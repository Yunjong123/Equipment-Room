import { randomUUID } from 'node:crypto';
import type { Sql } from '../db.ts';
import type { User, Equipment, Booking } from '../../shared/types.ts';
import { fail } from '../../shared/domain.ts';

export async function lockEquipment(tx: Sql, id: string): Promise<Equipment> {
  const { rows } = await tx.query<Equipment>('SELECT * FROM equipment WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0]) fail(404, 'NOT_FOUND', 'Equipment was not found.');
  return rows[0];
}

export async function lockBooking(tx: Sql, id: string, user: User): Promise<{ booking: Booking; equipment: Equipment }> {
  const lookup = await tx.query<Booking>('SELECT * FROM bookings WHERE id=$1', [id]);
  const found = lookup.rows[0];
  if (!found || (user.role !== 'staff' && found.user_id !== user.id)) fail(404, 'NOT_FOUND', 'Reservation was not found.');
  const equipment = await lockEquipment(tx, found.equipment_id);
  const { rows } = await tx.query<Booking>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  return { booking: rows[0], equipment };
}

export async function event(
  tx: Sql,
  actor: string,
  equipment: string,
  action: string,
  details: Record<string, unknown> = {},
  booking: string | null = null
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (id,actor_id,equipment_id,booking_id,action,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), actor, equipment, booking, action, JSON.stringify(details)]
  );
}

export async function openIssueCount(tx: Sql, equipment: string): Promise<number> {
  const { rows } = await tx.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM issues WHERE equipment_id=$1 AND status=\'open\'',
    [equipment]
  );
  return rows[0].count;
}
