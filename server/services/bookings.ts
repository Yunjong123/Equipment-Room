import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database } from '../db.ts';
import type { Booking, BookingDetails, User, AuditEvent } from '../../shared/types.ts';
import type { reservationInput, actionInput } from '../../shared/validation.ts';
import {
  assertBookingAction,
  assertCanReserve,
  assertVersion,
  fail,
  sameReservation,
  validateDates
} from '../../shared/domain.ts';
import { event, lockEquipment, lockBooking, openIssueCount } from './common.ts';

const selectBooking = `SELECT b.*,e.name AS equipment_name,e.asset_tag,e.condition AS equipment_condition,
  u.name AS borrower_name,u.email AS borrower_email,
  (b.status='checked_out' AND b.end_date < $1::date) AS overdue,
  (b.status='reserved' AND (e.condition <> 'ready'
    OR EXISTS(SELECT 1 FROM issues i WHERE i.equipment_id=e.id AND i.status='open')
    OR EXISTS(SELECT 1 FROM bookings other WHERE other.equipment_id=e.id AND other.status='checked_out' AND other.end_date < $1::date))) AS blocked
  FROM bookings b JOIN equipment e ON e.id=b.equipment_id JOIN users u ON u.id=b.user_id`;

export async function listBookings(
  db: Database,
  user: User,
  today: string,
  input: {
    staff?: boolean;
    status?: string;
    date?: string;
    overdue?: boolean;
    page: number;
  }
): Promise<{ items: Booking[]; hasMore: boolean }> {
  const values: unknown[] = [today];
  const conditions = ['true'];
  if (!input.staff || user.role !== 'staff') {
    values.push(user.id);
    conditions.push(`b.user_id=$${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`b.status=$${values.length}`);
  }
  if (input.date) {
    values.push(input.date);
    conditions.push(`b.start_date <= $${values.length}::date AND b.end_date >= $${values.length}::date`);
  }
  if (input.overdue) conditions.push(`b.status='checked_out' AND b.end_date < $1::date`);
  values.push((input.page - 1) * 25);
  const { rows } = await db.query<Booking>(
    `${selectBooking} WHERE ${conditions.join(' AND ')}
    ORDER BY b.created_at DESC,b.id LIMIT 26 OFFSET $${values.length}`,
    values
  );
  return { items: rows.slice(0, 25), hasMore: rows.length > 25 };
}

export async function bookingDetails(db: Database, user: User, today: string, id: string): Promise<BookingDetails> {
  const { rows } = await db.query<Booking>(`${selectBooking} WHERE b.id=$2`, [today, id]);
  const booking = rows[0];
  if (!booking || (user.role !== 'staff' && booking.user_id !== user.id)) fail(404, 'NOT_FOUND', 'Reservation was not found.');
  const events = await db.query<AuditEvent>(
    `SELECT a.id,a.action,a.details,a.created_at,u.name AS actor_name
    FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE a.booking_id=$1 ORDER BY a.created_at,a.id`,
    [id]
  );
  return { booking, events: events.rows };
}

export async function reserve(db: Database, user: User, today: string,
  input: z.infer<typeof reservationInput>): Promise<{ id: string; repeated: boolean }> {
  return db.transaction(async (tx) => {
    const equipment = await lockEquipment(tx, input.equipmentId);
    const existing = await tx.query<Booking>(
      'SELECT * FROM bookings WHERE user_id=$1 AND request_id=$2',
      [user.id, input.requestId]
    );
    if (existing.rows[0]) {
      if (!sameReservation(existing.rows[0], input)) fail(409, 'REQUEST_REUSED', 'This request ID belongs to different reservation details.');
      return { id: existing.rows[0].id, repeated: true };
    }
    const days = validateDates(input.startDate, input.endDate, today);
    const overdue = await tx.query(
      `SELECT id FROM bookings WHERE equipment_id=$1 AND status='checked_out' AND end_date < $2::date`,
      [equipment.id, today]
    );
    assertCanReserve({
      condition: equipment.condition,
      overdue: overdue.rows.length > 0,
      openIssues: await openIssueCount(tx, equipment.id)
    });
    const conflict = await tx.query(
      `SELECT day FROM booking_days WHERE equipment_id=$1 AND day BETWEEN $2::date AND $3::date LIMIT 1`,
      [equipment.id, input.startDate, input.endDate]
    );
    if (conflict.rows.length) fail(
      409,
      'DATES_TAKEN',
      'This item was reserved for one or more selected dates. Choose other dates.'
    );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO bookings (id,equipment_id,user_id,start_date,end_date,purpose,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, equipment.id, user.id, input.startDate, input.endDate, input.purpose, input.requestId]
    );
    for (const day of days) {
      await tx.query(
        'INSERT INTO booking_days (equipment_id,day,booking_id) VALUES ($1,$2,$3)',
        [equipment.id, day, id]
      );
    }
    await event(
      tx,
      user.id,
      equipment.id,
      'reservation_created',
      { startDate: input.startDate, endDate: input.endDate },
      id
    );
    return { id, repeated: false };
  });
}

export async function changeBooking(
  db: Database,
  user: User,
  today: string,
  id: string,
  action: 'cancel' | 'checkout' | 'return' | 'no-show',
  input: z.infer<typeof actionInput>
): Promise<{ id: string }> {
  await db.transaction(async (tx) => {
    const { booking, equipment } = await lockBooking(tx, id, user);
    assertVersion(input.expectedVersion, booking.version);
    const other = await tx.query(
      `SELECT id FROM bookings WHERE equipment_id=$1 AND status='checked_out' AND id <> $2`,
      [equipment.id, id]
    );
    const next = assertBookingAction({
      action,
      status: booking.status,
      role: user.role,
      start: booking.start_date,
      end: booking.end_date,
      today,
      condition: equipment.condition,
      anotherLoan: other.rows.length > 0,
      openIssues: await openIssueCount(tx, equipment.id)
    });
    if (action === 'return' && !input.returnCondition) fail(422, 'RETURN_CONDITION', 'Select the condition at return.');
    if ((input.returnCondition === 'maintenance' || (action === 'cancel' && user.role === 'staff') || action === 'no-show') && !input.notes) {
      fail(422, 'NOTES_REQUIRED', 'Add a short reason before continuing.');
    }
    if (action === 'return') {
      await tx.query(
        `UPDATE bookings SET status='returned',returned_at=now(),version=version+1 WHERE id=$1`,
        [id]
      );
      // Keep the return day occupied; release only later dates.
      await tx.query('DELETE FROM booking_days WHERE booking_id=$1 AND day > $2::date', [id, today]);
      await tx.query(
        `UPDATE equipment SET condition=$2,condition_notes=$3,version=version+1,updated_at=now() WHERE id=$1`,
        [equipment.id, input.returnCondition, input.notes]
      );
      if (input.returnCondition === 'maintenance') {
        await tx.query(
          `INSERT INTO issues (id,equipment_id,booking_id,reporter_id,request_id,description)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), equipment.id, id, user.id, randomUUID(), input.notes]
        );
      }
    } else if (action === 'checkout') {
      await tx.query(
        `UPDATE bookings SET status='checked_out',checked_out_at=now(),version=version+1 WHERE id=$1`,
        [id]
      );
    } else {
      await tx.query(
        `UPDATE bookings SET status=$2,cancellation_reason=$3,version=version+1 WHERE id=$1`,
        [id, next, input.notes]
      );
      await tx.query('DELETE FROM booking_days WHERE booking_id=$1', [id]);
    }
    await event(
      tx,
      user.id,
      equipment.id,
      `booking_${next}`,
      { notes: input.notes, returnCondition: input.returnCondition || null },
      id
    );
  });
  return { id };
}
