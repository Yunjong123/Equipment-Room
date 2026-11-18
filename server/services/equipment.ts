import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database } from '../db.ts';
import type { Equipment, EquipmentDetails, User, AuditEvent, Photo } from '../../shared/types.ts';
import { equipmentInput, equipmentUpdateInput } from '../../shared/validation.ts';
import { assertRetirement, assertVersion, fail } from '../../shared/domain.ts';
import { event, lockEquipment, openIssueCount } from './common.ts';

const selectEquipment = `SELECT e.*,
  (SELECT p.id FROM photos p WHERE p.equipment_id=e.id AND p.issue_id IS NULL ORDER BY p.created_at,p.id LIMIT 1) AS cover_photo_id,
  (SELECT count(*)::int FROM issues i WHERE i.equipment_id=e.id AND i.status='open') AS open_issues,
  EXISTS(SELECT 1 FROM bookings b WHERE b.equipment_id=e.id AND b.status='checked_out') AS checked_out,
  EXISTS(SELECT 1 FROM bookings b WHERE b.equipment_id=e.id AND b.status='checked_out' AND b.end_date < $1::date) AS overdue
  FROM equipment e`;

export async function listEquipment(
  db: Database,
  today: string,
  input: {
    q?: string;
    category?: string;
    start?: string;
    end?: string;
    includeRetired?: boolean;
    page: number;
  }
): Promise<{ items: Equipment[]; hasMore: boolean }> {
  const values: unknown[] = [today];
  const conditions = ['true'];
  if (!input.includeRetired) conditions.push("e.condition <> 'retired'");
  if (input.q) {
    values.push(`%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(e.name ILIKE $${values.length} OR e.asset_tag ILIKE $${values.length})`);
  }
  if (input.category) {
    values.push(input.category);
    conditions.push(`e.category=$${values.length}`);
  }
  if (input.start && input.end) {
    values.push(input.start, input.end);
    const start = values.length - 1;
    conditions.push(`e.condition='ready'
      AND NOT EXISTS(SELECT 1 FROM booking_days d WHERE d.equipment_id=e.id AND d.day BETWEEN $${start}::date AND $${start + 1}::date)
      AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.equipment_id=e.id AND b.status='checked_out' AND b.end_date < $1::date)
      AND NOT EXISTS(SELECT 1 FROM issues i WHERE i.equipment_id=e.id AND i.status='open')`);
  }
  values.push((input.page - 1) * 24);
  const { rows } = await db.query<Equipment>(
    `${selectEquipment} WHERE ${conditions.join(' AND ')}
    ORDER BY e.name,e.asset_tag LIMIT 25 OFFSET $${values.length}`,
    values
  );
  return { items: rows.slice(0, 24), hasMore: rows.length > 24 };
}

export async function equipmentDetails(db: Database, id: string, today: string, user: User): Promise<EquipmentDetails> {
  const { rows } = await db.query<Equipment>(`${selectEquipment} WHERE e.id=$2`, [today, id]);
  const equipment = rows[0];
  if (!equipment) fail(404, 'NOT_FOUND', 'Equipment was not found.');
  const photos = await db.query<Photo>(
    'SELECT id,equipment_id,issue_id,created_at FROM photos WHERE equipment_id=$1 AND issue_id IS NULL ORDER BY created_at,id',
    [id]
  );
  // Dates only. Member responses must not reveal other borrowers or their purposes.
  const dates = await db.query<{ start_date: string; end_date: string }>(
    `SELECT day AS start_date,day AS end_date
    FROM booking_days WHERE equipment_id=$1 AND day >= $2::date ORDER BY day`,
    [id, today]
  );
  const history = user.role === 'staff'
    ? await db.query<AuditEvent>(
      `SELECT a.id,a.action,a.details,a.created_at,u.name AS actor_name FROM audit_events a
        JOIN users u ON u.id=a.actor_id WHERE a.equipment_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 50`,
      [id]
    )
    : { rows: [] };
  return { equipment, photos: photos.rows, reservedDates: dates.rows, events: history.rows };
}

export async function createEquipment(db: Database, user: User, input: z.infer<typeof equipmentInput>): Promise<{ id: string }> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO equipment (id,asset_tag,name,category,description,location,condition,condition_notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.assetTag,
        input.name,
        input.category,
        input.description,
        input.location,
        input.condition,
        input.conditionNotes
      ]
    );
    await event(tx, user.id, id, 'equipment_created', { assetTag: input.assetTag });
  });
  return { id };
}

export async function updateEquipment(
  db: Database,
  user: User,
  id: string,
  today: string,
  input: z.infer<typeof equipmentUpdateInput>
): Promise<{ id: string }> {
  await db.transaction(async (tx) => {
    const equipment = await lockEquipment(tx, id);
    assertVersion(input.expectedVersion, equipment.version);
    const checkedOut = await tx.query(`SELECT id FROM bookings WHERE equipment_id=$1 AND status='checked_out'`, [id]);
    if (checkedOut.rows.length && input.condition !== equipment.condition) {
      fail(409, 'STILL_OUT', 'Record the condition when this item is returned.');
    }
    const commitments = await tx.query(
      `SELECT id FROM bookings WHERE equipment_id=$1
      AND (status='checked_out' OR (status='reserved' AND end_date >= $2::date)) LIMIT 1`,
      [id, today]
    );
    assertRetirement(input.condition, commitments.rows.length > 0);
    if (input.condition === 'ready' && equipment.condition !== 'ready' && await openIssueCount(tx, id) > 0) {
      fail(409, 'OPEN_ISSUE', 'Resolve open condition reports before marking the item ready.');
    }
    await tx.query(
      `UPDATE equipment SET asset_tag=$2,name=$3,category=$4,description=$5,location=$6,
      condition=$7,condition_notes=$8,version=version+1,updated_at=now() WHERE id=$1`,
      [
        id,
        input.assetTag,
        input.name,
        input.category,
        input.description,
        input.location,
        input.condition,
        input.conditionNotes
      ]
    );
    await event(
      tx,
      user.id,
      id,
      'equipment_updated',
      {
        condition: input.condition,
        previousCondition: equipment.condition,
        notes: input.conditionNotes,
      }
    );
  });
  return { id };
}
