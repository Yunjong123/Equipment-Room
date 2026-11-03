import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDate,
  addDays,
  clubToday,
  validateDates,
  isOverdue,
  assertVersion,
  assertCanReserve,
  assertBookingAction,
  assertRetirement,
  sameReservation,
} from '../../shared/domain.ts';

const today = '2026-03-08';
const checkout = {
  action: 'checkout',
  status: 'reserved',
  role: 'staff',
  start: today,
  end: '2026-03-10',
  today,
  condition: 'ready',
  anotherLoan: false,
  openIssues: 0,
};
const rejects = (code) => (error) => error.code === code;

for (const [value, valid] of [
  ['2026-03-08', true],
  ['2024-02-29', true],
  ['2026-02-29', false],
  ['2026-04-31', false],
  ['2026-13-01', false],
  ['2026-00-10', false],
  ['2026-01-00', false],
  ['03/08/2026', false],
  ['2026-3-8', false],
  ['', false],
  [null, false],
]) test(`calendar date validation: ${String(value)}`, () => assert.equal(isDate(value), valid));

test(
  'date addition crosses a month boundary',
  () => assert.equal(addDays('2026-01-31', 1), '2026-02-01')
);
test(
  'date addition crosses a year boundary',
  () => assert.equal(addDays('2026-12-31', 1), '2027-01-01')
);
test(
  'date addition handles negative days',
  () => assert.equal(addDays('2024-03-01', -1), '2024-02-29')
);
test('invalid date arithmetic fails', () => assert.throws(() => addDays('2026-02-30', 1)));
test(
  'club day does not use the UTC date near midnight',
  () => assert.equal(clubToday('America/New_York', new Date('2026-03-08T03:00:00Z')), '2026-03-07')
);
test(
  'club day remains a calendar day across DST',
  () => {
    assert.equal(clubToday('America/New_York', new Date('2026-03-08T06:59:00Z')), today);
    assert.equal(clubToday('America/New_York', new Date('2026-03-08T07:01:00Z')), today);
  }
);
test(
  'western and eastern clubs can have different dates',
  () => {
    const now = new Date('2026-07-01T05:00:00Z');
    assert.equal(clubToday('America/New_York', now), '2026-07-01');
    assert.equal(clubToday('America/Los_Angeles', now), '2026-06-30');
  }
);
test(
  'one-day reservation occupies one day',
  () => assert.deepEqual(validateDates(today, today, today), [today])
);
test(
  'a full week includes both endpoints',
  () => {
    const days = validateDates(today, '2026-03-14', today);
    assert.equal(days.length, 7);
    assert.equal(days[0], today);
    assert.equal(days[6], '2026-03-14');
  }
);
test(
  'past pickup is rejected',
  () => assert.throws(() => validateDates('2026-03-07', today, today), rejects('PAST_DATE'))
);
test(
  'return before pickup is rejected',
  () => assert.throws(() => validateDates('2026-03-10', today, today), rejects('INVALID_DATES'))
);
test(
  'eight-day loans are rejected',
  () => assert.throws(() => validateDates(today, '2026-03-15', today), rejects('LOAN_TOO_LONG'))
);
test(
  'invalid dates cannot be normalized into valid bookings',
  () => assert.throws(() => validateDates('2026-02-30', today, today), rejects('INVALID_DATES'))
);
test(
  'the last horizon day is allowed',
  () => {
    const day = addDays(today, 90);
    assert.deepEqual(validateDates(day, day, today), [day]);
  }
);
test(
  'the horizon also applies to the return date',
  () => assert.throws(
    () => validateDates(addDays(today, 90), addDays(today, 91), today),
    rejects('DATE_TOO_FAR')
  )
);
test(
  'a loan is not overdue on its return date',
  () => assert.equal(isOverdue('checked_out', today, today), false)
);
test(
  'an unreturned loan is overdue on the next calendar day',
  () => assert.equal(isOverdue('checked_out', '2026-03-07', today), true)
);
test(
  'reserved and returned records are not physical overdue loans',
  () => {
    assert.equal(isOverdue('reserved', '2026-03-07', today), false);
    assert.equal(isOverdue('returned', '2026-03-07', today), false);
  }
);
test('matching versions are accepted', () => assert.doesNotThrow(() => assertVersion(4, 4)));
test(
  'stale versions are rejected',
  () => assert.throws(() => assertVersion(3, 4), rejects('VERSION_CONFLICT'))
);
test(
  'ready equipment can be reserved',
  () => assert.doesNotThrow(() => assertCanReserve({ condition: 'ready', overdue: false, openIssues: 0 }))
);
for (const condition of ['maintenance', 'retired']) test(
  `${condition} equipment cannot be reserved`,
  () => assert.throws(() => assertCanReserve({ condition, overdue: false, openIssues: 0 }), rejects('NOT_READY'))
);
test(
  'overdue equipment cannot receive new reservations',
  () => assert.throws(
    () => assertCanReserve({ condition: 'ready', overdue: true, openIssues: 0 }),
    rejects('OVERDUE_ITEM')
  )
);
test(
  'open reports prevent new reservations',
  () => assert.throws(
    () => assertCanReserve({ condition: 'ready', overdue: false, openIssues: 1 }),
    rejects('OPEN_ISSUE')
  )
);
test(
  'staff can check out a ready item on its pickup date',
  () => assert.equal(assertBookingAction(checkout), 'checked_out')
);
test(
  'members cannot check equipment out themselves',
  () => assert.throws(() => assertBookingAction({ ...checkout, role: 'member' }), rejects('STAFF_REQUIRED'))
);
test(
  'early checkout is rejected',
  () => assert.throws(() => assertBookingAction({ ...checkout, start: '2026-03-09' }), rejects('PICKUP_DATE'))
);
test(
  'late checkout is rejected',
  () => assert.throws(() => assertBookingAction({ ...checkout, start: '2026-03-07' }), rejects('PICKUP_DATE'))
);
test(
  'an existing physical loan blocks another handoff',
  () => assert.throws(() => assertBookingAction({ ...checkout, anotherLoan: true }), rejects('STILL_OUT'))
);
test(
  'maintenance blocks checkout',
  () => assert.throws(() => assertBookingAction({ ...checkout, condition: 'maintenance' }), rejects('NOT_READY'))
);
test(
  'open issues block checkout',
  () => assert.throws(() => assertBookingAction({ ...checkout, openIssues: 1 }), rejects('NOT_READY'))
);
test(
  'a cancelled reservation cannot be checked out',
  () => assert.throws(() => assertBookingAction({ ...checkout, status: 'cancelled' }), rejects('INVALID_STATE'))
);
test(
  'members can cancel before handoff on the pickup day',
  () => assert.equal(assertBookingAction({ ...checkout, role: 'member', action: 'cancel' }), 'cancelled')
);
test(
  'members cannot cancel a missed pickup from a prior day',
  () => assert.throws(
    () => assertBookingAction({ ...checkout, role: 'member', action: 'cancel', start: '2026-03-07' }),
    rejects('PICKUP_MISSED')
  )
);
test(
  'staff can cancel a missed pickup',
  () => assert.equal(assertBookingAction({ ...checkout, action: 'cancel', start: '2026-03-07' }), 'cancelled')
);
test(
  'a physical loan cannot be cancelled',
  () => assert.throws(
    () => assertBookingAction({ ...checkout, action: 'cancel', status: 'checked_out' }),
    rejects('INVALID_STATE')
  )
);
test(
  'staff can return an overdue loan',
  () => assert.equal(
    assertBookingAction({ ...checkout, action: 'return', status: 'checked_out', end: '2026-03-07' }),
    'returned'
  )
);
test(
  'a reservation cannot be returned before checkout',
  () => assert.throws(() => assertBookingAction({ ...checkout, action: 'return' }), rejects('INVALID_STATE'))
);
test(
  'members cannot confirm their own returns',
  () => assert.throws(
    () => assertBookingAction({ ...checkout, role: 'member', action: 'return', status: 'checked_out' }),
    rejects('STAFF_REQUIRED')
  )
);
test(
  'staff can mark a pickup missed on its scheduled day',
  () => assert.equal(assertBookingAction({ ...checkout, action: 'no-show' }), 'no_show')
);
test(
  'future pickups cannot be marked missed',
  () => assert.throws(
    () => assertBookingAction({ ...checkout, action: 'no-show', start: '2026-03-09' }),
    rejects('INVALID_STATE')
  )
);
test(
  'members cannot mark a no-show',
  () => assert.throws(
    () => assertBookingAction({ ...checkout, action: 'no-show', role: 'member' }),
    rejects('STAFF_REQUIRED')
  )
);
test(
  'retirement is blocked by commitments',
  () => assert.throws(() => assertRetirement('retired', true), rejects('ACTIVE_BOOKINGS'))
);
test(
  'equipment without commitments can be retired',
  () => assert.doesNotThrow(() => assertRetirement('retired', false))
);
test(
  'maintenance can retain future reservations for staff follow-up',
  () => assert.doesNotThrow(() => assertRetirement('maintenance', true))
);
const existing = { equipment_id: 'a', start_date: today, end_date: today, purpose: 'Interview' };
const incoming = { equipmentId: 'a', startDate: today, endDate: today, purpose: 'Interview' };
test(
  'identical reservation retries match',
  () => assert.equal(sameReservation(existing, incoming), true)
);
for (const change of [
  { equipmentId: 'b' },
  { startDate: '2026-03-09' },
  { endDate: '2026-03-09' },
  { purpose: 'Different project' }
]) {
  test(
    `changed retry payload does not match: ${Object.keys(change)[0]}`,
    () => assert.equal(sameReservation(existing, { ...incoming, ...change }), false)
  );
}
