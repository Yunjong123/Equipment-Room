import type { BookingStatus, EquipmentCondition, Role } from './types.ts';

export const CATEGORIES = ['camera', 'audio', 'lighting', 'support', 'projector', 'accessory'] as const;
export const MAX_LOAN_DAYS = 7;
export const BOOKING_HORIZON_DAYS = 90;
export const MAX_PHOTOS = 3;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const DAY = 86_400_000;

export class DomainError extends Error {
  public status: number;
  public code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'DomainError';
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new DomainError(status, code, message);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function addDays(date: string, count: number): string {
  if (!isDate(date) || !Number.isInteger(count)) throw new Error('Invalid date arithmetic.');
  return new Date(Date.parse(`${date}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

export function clubToday(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }
  ).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validateDates(start: string, end: string, today: string): string[] {
  if (!isDate(start) || !isDate(end)) fail(422, 'INVALID_DATES', 'Choose valid calendar dates.');
  if (start < today) fail(422, 'PAST_DATE', 'A reservation cannot start in the past.');
  if (end < start) fail(422, 'INVALID_DATES', 'The return date must be on or after pickup.');
  if (end > addDays(today, BOOKING_HORIZON_DAYS)) {
    fail(422, 'DATE_TOO_FAR', `Reserve within the next ${BOOKING_HORIZON_DAYS} days.`);
  }
  if (end > addDays(start, MAX_LOAN_DAYS - 1)) {
    fail(422, 'LOAN_TOO_LONG', `A loan can cover up to ${MAX_LOAN_DAYS} calendar days.`);
  }
  const days: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) days.push(date);
  return days;
}

export function isOverdue(status: BookingStatus, end: string, today: string): boolean {
  return status === 'checked_out' && end < today;
}

export function assertVersion(expected: number, current: number): void {
  if (expected !== current) {
    fail(409, 'VERSION_CONFLICT', 'This record changed in another window. Reload before trying again.');
  }
}

export function assertCanReserve(input: {
  condition: EquipmentCondition;
  overdue: boolean;
  openIssues: number;
}): void {
  if (input.condition !== 'ready') fail(409, 'NOT_READY', 'This item is not accepting reservations.');
  if (input.overdue) fail(409, 'OVERDUE_ITEM', 'This item has an overdue loan. Staff must check it first.');
  if (input.openIssues > 0) fail(409, 'OPEN_ISSUE', 'This item has an unresolved condition report.');
}

export function assertBookingAction(
  input: {
    action: 'cancel' | 'checkout' | 'return' | 'no-show';
    status: BookingStatus;
    role: Role;
    start: string;
    end: string;
    today: string;
    condition: EquipmentCondition;
    anotherLoan: boolean;
    openIssues: number;
  }
): BookingStatus {
  const { action, status, role, start, today } = input;
  if (action === 'cancel') {
    if (status !== 'reserved') fail(409, 'INVALID_STATE', 'Only a reservation can be cancelled.');
    if (role !== 'staff' && start < today) {
      fail(409, 'PICKUP_MISSED', 'Contact staff about a missed pickup.');
    }
    return 'cancelled';
  }
  if (role !== 'staff') fail(403, 'STAFF_REQUIRED', 'Only staff can perform this action.');
  if (action === 'checkout') {
    if (status !== 'reserved') fail(409, 'INVALID_STATE', 'This reservation cannot be checked out.');
    if (start !== today) fail(409, 'PICKUP_DATE', 'Check out equipment on its scheduled pickup date.');
    if (input.condition !== 'ready' || input.openIssues > 0) {
      fail(409, 'NOT_READY', 'Resolve condition reports and mark the item ready before checkout.');
    }
    if (input.anotherLoan) fail(409, 'STILL_OUT', 'The previous borrower has not returned this item.');
    return 'checked_out';
  }
  if (action === 'return') {
    if (status !== 'checked_out') fail(409, 'INVALID_STATE', 'Only checked-out equipment can be returned.');
    return 'returned';
  }
  if (status !== 'reserved' || start > today) {
    fail(409, 'INVALID_STATE', 'Mark a missed pickup on or after its scheduled date.');
  }
  return 'no_show';
}

export function assertRetirement(condition: EquipmentCondition, hasCommitments: boolean): void {
  if (condition === 'retired' && hasCommitments) {
    fail(
      409,
      'ACTIVE_BOOKINGS',
      'Cancel upcoming reservations and finish the current loan before retiring this item.'
    );
  }
}

export function sameReservation(
  existing: {
    equipment_id: string;
    start_date: string;
    end_date: string;
    purpose: string
  },
  incoming: {
    equipmentId: string;
    startDate: string;
    endDate: string;
    purpose: string
  },

): boolean {
  return existing.equipment_id === incoming.equipmentId && existing.start_date === incoming.startDate
    && existing.end_date === incoming.endDate && existing.purpose === incoming.purpose;
}

export function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}
