import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database, Sql } from '../db.ts';
import type { Issue, Photo, User, Booking } from '../../shared/types.ts';
import type { issueInput, resolveInput } from '../../shared/validation.ts';
import { assertVersion, fail } from '../../shared/domain.ts';
import { event, lockEquipment } from './common.ts';

export async function assertIssueAccess(tx: Sql, user: User, id: string, writable = false): Promise<Issue> {
  const { rows } = await tx.query<Issue>('SELECT * FROM issues WHERE id=$1', [id]);
  const issue = rows[0];
  if (!issue || (user.role !== 'staff' && issue.reporter_id !== user.id)) fail(404, 'NOT_FOUND', 'Condition report was not found.');
  if (writable && issue.status !== 'open') fail(409, 'ISSUE_CLOSED', 'This condition report is already resolved.');
  return issue;
}

export async function listIssues(
  db: Database,
  user: User,
  input: {
    status?: string; equipmentId?: string; page: number;
  }
): Promise<{ items: Issue[]; hasMore: boolean }> {
  const conditions = ['true'];
  const values: unknown[] = [];
  if (user.role !== 'staff') {
    values.push(user.id);
    conditions.push(`i.reporter_id=$${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`i.status=$${values.length}`);
  }
  if (input.equipmentId) {
    values.push(input.equipmentId);
    conditions.push(`i.equipment_id=$${values.length}`);
  }
  values.push((input.page - 1) * 25);
  const { rows } = await db.query<Issue>(
    `SELECT i.*,u.name AS reporter_name,e.name AS equipment_name,e.asset_tag
    FROM issues i JOIN users u ON u.id=i.reporter_id JOIN equipment e ON e.id=i.equipment_id
    WHERE ${conditions.join(' AND ')} ORDER BY i.created_at DESC,i.id LIMIT 26 OFFSET $${values.length}`,
    values
  );
  const items = rows.slice(0, 25);
  if (items.length) {
    const photos = await db.query<Photo>(
      `SELECT id,equipment_id,issue_id,created_at FROM photos WHERE issue_id=ANY($1::uuid[]) ORDER BY created_at,id`,
      [items.map((item) => item.id)]
    );
    for (const item of items) item.photos = photos.rows.filter((photo) => photo.issue_id === item.id);
  }
  return { items, hasMore: rows.length > 25 };
}

export async function createIssue(db: Database, user: User, input: z.infer<typeof issueInput>): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    await lockEquipment(tx, input.equipmentId);
    const existing = await tx.query<Issue>(
      'SELECT * FROM issues WHERE reporter_id=$1 AND request_id=$2',
      [user.id, input.requestId]
    );
    if (existing.rows[0]) {
      const record = existing.rows[0];
      if (record.equipment_id !== input.equipmentId || record.booking_id !== (input.bookingId || null) || record.description !== input.description) {
        fail(409, 'REQUEST_REUSED', 'This request ID was used for a different condition report.');
      }
      return { id: record.id };
    }
    if (user.role !== 'staff' || input.bookingId) {
      const { rows } = await tx.query<Booking>('SELECT * FROM bookings WHERE id=$1', [input.bookingId || null]);
      const booking = rows[0];
      if (!booking || booking.equipment_id !== input.equipmentId ||
        (user.role !== 'staff' && booking.user_id !== user.id)) fail(404, 'NOT_FOUND', 'Loan was not found.');
      if (!['checked_out', 'returned'].includes(booking.status)) fail(409, 'NO_LOAN', 'Report a condition issue for equipment you have collected.');
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO issues (id,equipment_id,booking_id,reporter_id,request_id,description)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.equipmentId, input.bookingId || null, user.id, input.requestId, input.description]
    );
    await event(tx, user.id, input.equipmentId, 'issue_reported', { issueId: id }, input.bookingId || null);
    return { id };
  });
}

export async function resolveIssue(db: Database, user: User, id: string, input: z.infer<typeof resolveInput>): Promise<void> {
  await db.transaction(async (tx) => {
    const found = await assertIssueAccess(tx, user, id);
    await lockEquipment(tx, found.equipment_id);
    const issue = await assertIssueAccess(tx, user, id, true);
    assertVersion(input.expectedVersion, issue.version);
    await tx.query(
      `UPDATE issues SET status='resolved',resolution=$2,resolved_by=$3,resolved_at=now(),version=version+1 WHERE id=$1`,
      [id, input.resolution, user.id]
    );
    await event(
      tx,
      user.id,
      issue.equipment_id,
      'issue_resolved',
      { issueId: id, resolution: input.resolution },
      issue.booking_id
    );
  });
}
