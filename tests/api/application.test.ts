import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import sharp from 'sharp';
import { openDatabase, migrate, type Database } from '../../server/db.ts';
import { createApp } from '../../server/app.ts';
import { hashPassword } from '../../server/passwords.ts';
import type { Config } from '../../server/config.ts';
import type { User } from '../../shared/types.ts';

type Agent = ReturnType<typeof supertest.agent>;
type Account = { user: User; agent: Agent; token: string };
let db: Database;
let directory: string;
let app: ReturnType<typeof createApp>;
let staff: Account;
let member: Account;
let other: Account;
let now = new Date('2026-03-08T16:00:00Z');
const origin = 'http://127.0.0.1:5173';
const password = 'A-test-password-2026';

async function account(role: 'member' | 'staff'): Promise<Account> {
  const user: User = {
    id: randomUUID(),
    email: `${randomUUID()}@example.com`,
    name: role === 'staff' ? 'Test Staff' : 'Test Member',
    role
  };
  await db.query(
    'INSERT INTO users (id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)',
    [user.id, user.email, user.name, role, await hashPassword(password)]
  );
  const agent = supertest.agent(app);
  const session = await agent.get('/api/auth/session').expect(200);
  const login = await agent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrfToken).set('Origin', origin)
    .send({ email: user.email, password }).expect(200);
  return { user, agent, token: login.body.csrfToken };
}
const post = (who: Account, url: string, body: unknown) => who.agent.post(`/api${url}`).set('X-CSRF-Token', who.token).set('Origin', origin).send(body as object);
const patch = (who: Account, url: string, body: unknown) => who.agent.patch(`/api${url}`).set('X-CSRF-Token', who.token).set('Origin', origin).send(body as object);
async function equipment() {
  const payload = {
    assetTag: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test camera',
    category: 'camera',
    description: 'Test kit',
    location: 'Test desk',
    condition: 'ready',
    conditionNotes: ''
  };
  const response = await post(staff, '/equipment', payload).expect(201);
  return { id: response.body.id as string, payload };
}
async function booking(equipmentId: string, who = member, startDate = '2026-03-08', endDate = startDate) {
  const body = { equipmentId, startDate, endDate, purpose: 'API test project', requestId: randomUUID() };
  const result = await post(who, '/bookings', body).expect(201);
  return { id: result.body.id as string, body };
}
const detail = async (who: Account, id: string) => (await who.agent.get(`/api/bookings/${id}`).expect(200)).body.booking;
async function checkout(id: string) {
  const record = await detail(staff, id);
  await post(staff, `/bookings/${id}/checkout`, { expectedVersion: record.version, notes: '' }).expect(200);
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'equipment-room-test-'));
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl && !new URL(databaseUrl).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test.');
  }
  db = await openDatabase({ dataDir: ':memory:', databaseUrl, ssl: false });
  await migrate(db);
  const config: Config = {
    dataDir: directory,
    production: false,
    port: 3001,
    host: '127.0.0.1',
    origin,
    timeZone: 'America/New_York',
    clubName: 'Test club',
    demo: false,
    allowSignup: true,
    sessionSecret: 'test-session-secret-at-least-32-characters',
    trustProxyHops: 0,
    ssl: false,
    databaseUrl,
  };
  app = createApp(db, config, { now: () => now, testing: true });
  staff = await account('staff');
  member = await account('member');
  other = await account('member');
});
beforeEach(() => {
  now = new Date('2026-03-08T16:00:00Z');
});
after(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test(
  'unauthenticated inventory access is denied',
  async () => {
    await supertest(app).get('/api/equipment').expect(401);
  }
);
test(
  'mutations without a CSRF token are rejected',
  async () => {
    await member.agent.post('/api/bookings').send({}).expect(403);
  }
);
test(
  'mutations from another origin are rejected',
  async () => {
    await member.agent.post('/api/bookings').set('X-CSRF-Token', member.token).set(
      'Origin',
      'https://another.example'
    ).send({}).expect(403);
  }
);
test(
  'members cannot create equipment or access the staff desk',
  async () => {
    await post(member, '/equipment', {}).expect(403);
    await member.agent.get('/api/staff/summary').expect(403);
  }
);
test(
  'member registration cannot assign the staff role',
  async () => {
    const agent = supertest.agent(app);
    const session = await agent.get('/api/auth/session');
    await agent.post('/api/auth/register').set('X-CSRF-Token', session.body.csrfToken)
      .send({ email: `${randomUUID()}@example.com`, name: 'Attempt', password, role: 'staff' }).expect(422);
  }
);
test(
  'registration creates a member account',
  async () => {
    const agent = supertest.agent(app);
    const session = await agent.get('/api/auth/session');
    const response = await agent.post('/api/auth/register').set('X-CSRF-Token', session.body.csrfToken)
      .send({ email: `${randomUUID()}@example.com`, name: 'New Member', password }).expect(201);
    assert.equal(response.body.user.role, 'member');
  }
);
test(
  'one-sided availability filters are rejected',
  async () => {
    await member.agent.get('/api/equipment?start=2026-03-08').expect(422);
  }
);
test(
  'catalog availability does not disclose other borrowers',
  async () => {
    const item = await equipment();
    const bookingId = randomUUID();
    await db.query(
      "INSERT INTO bookings (id, equipment_id, user_id, start_date, end_date, purpose, request_id) VALUES ($1, $2, $3, '2026-03-08', '2026-03-08', 'Private project', $4)",
      [bookingId, item.id, member.user.id, randomUUID()]
    );
    await db.query(
      "INSERT INTO booking_days (equipment_id, day, booking_id) VALUES ($1, '2026-03-08', $2)",
      [item.id, bookingId]
    );

    const response = await other.agent.get(`/api/equipment/${item.id}`).expect(200);
    assert.equal(response.body.events.length, 0);
    assert.deepEqual(Object.keys(response.body.reservedDates[0]).sort(), ['end_date', 'start_date']);
    assert.equal(JSON.stringify(response.body).includes(member.user.email), false);
    assert.equal(JSON.stringify(response.body).includes('Private project'), false);
  }
);
test(
  'retirement cannot strand an active reservation',
  async () => {
    const item = await equipment();
    const bookingId = randomUUID();
    await db.query(
      "INSERT INTO bookings (id, equipment_id, user_id, start_date, end_date, purpose, request_id) VALUES ($1, $2, $3, '2026-03-08', '2026-03-08', 'Retirement guard', $4)",
      [bookingId, item.id, member.user.id, randomUUID()]
    );
    await db.query(
      "INSERT INTO booking_days (equipment_id, day, booking_id) VALUES ($1, '2026-03-08', $2)",
      [item.id, bookingId]
    );

    await patch(
      staff,
      `/equipment/${item.id}`,
      { ...item.payload, condition: 'retired', conditionNotes: 'Replacing kit', expectedVersion: 1 }
    ).expect(409);
  }
);
test(
  'invalid dates and excessive date ranges are rejected',
  async () => {
    const item = await equipment();
    await post(
      member,
      '/bookings',
      {
        equipmentId: item.id,
        startDate: '2026-02-30',
        endDate: '2026-03-01',
        purpose: 'Test',
        requestId: randomUUID()
      }
    ).expect(422);
    await post(
      member,
      '/bookings',
      {
        equipmentId: item.id,
        startDate: '2026-03-08',
        endDate: '2026-03-15',
        purpose: 'Test',
        requestId: randomUUID()
      }
    ).expect(422);
  }
);
test(
  'a reservation has a slot for every inclusive date',
  async () => {
    const item = await equipment();
    const record = await booking(item.id, member, '2026-03-08', '2026-03-10');
    const result = await db.query<{ day: string }>(
      'SELECT day FROM booking_days WHERE booking_id=$1 ORDER BY day',
      [record.id]
    );
    assert.deepEqual(result.rows.map((row) => row.day), ['2026-03-08', '2026-03-09', '2026-03-10']);
  }
);
test(
  'overlapping reservations are rejected',
  async () => {
    const item = await equipment();
    await booking(item.id, member, '2026-03-08', '2026-03-10');
    await post(
      other,
      '/bookings',
      {
        equipmentId: item.id,
        startDate: '2026-03-10',
        endDate: '2026-03-11',
        purpose: 'Overlap',
        requestId: randomUUID()
      }
    ).expect(409);
  }
);
test(
  'two simultaneous requests for the same item and day produce one booking',
  async () => {
    const item = await equipment();
    const body = { equipmentId: item.id, startDate: '2026-03-08', endDate: '2026-03-08', purpose: 'Race' };
    const results = await Promise.all([
      post(member, '/bookings', { ...body, requestId: randomUUID() }),
      post(other, '/bookings', { ...body, requestId: randomUUID() })
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    const count = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM bookings WHERE equipment_id=$1',
      [item.id]
    );
    assert.equal(count.rows[0].count, 1);
  }
);
test(
  'replaying a successful reservation returns the original booking',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    const replay = await post(member, '/bookings', record.body).expect(200);
    assert.equal(replay.body.id, record.id);
  }
);
test(
  'concurrent identical requests return one reservation',
  async () => {
    const item = await equipment();
    const body = {
      equipmentId: item.id,
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      purpose: 'Same request',
      requestId: randomUUID()
    };
    const results = await Promise.all([post(member, '/bookings', body), post(member, '/bookings', body)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
    assert.equal(results[0].body.id, results[1].body.id);
  }
);
test(
  'reused request IDs cannot change the reservation',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await post(member, '/bookings', { ...record.body, purpose: 'Changed' }).expect(409);
  }
);
test(
  'members cannot inspect or cancel another borrower reservation',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await other.agent.get(`/api/bookings/${record.id}`).expect(404);
    await post(other, `/bookings/${record.id}/cancel`, { expectedVersion: 1, notes: '' }).expect(404);
  }
);
test(
  'cancellation releases reserved dates',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await post(member, `/bookings/${record.id}/cancel`, { expectedVersion: 1, notes: '' }).expect(200);
    await booking(item.id, other);
  }
);
test(
  'stale actions fail without adding another audit event',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await checkout(record.id);
    await post(staff, `/bookings/${record.id}/checkout`, { expectedVersion: 1, notes: '' }).expect(409);
    const count = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE booking_id=$1 AND action='booking_checked_out'",
      [record.id]
    );
    assert.equal(count.rows[0].count, 1);
  }
);
test(
  'early return releases future dates but retains the return-day slot',
  async () => {
    const item = await equipment();
    const record = await booking(item.id, member, '2026-03-08', '2026-03-10');
    await checkout(record.id);
    await post(
      staff,
      `/bookings/${record.id}/return`,
      { expectedVersion: 2, notes: 'All parts present', returnCondition: 'ready' }
    ).expect(200);
    await post(
      other,
      '/bookings',
      {
        equipmentId: item.id,
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        purpose: 'Same day',
        requestId: randomUUID()
      }
    ).expect(409);
    await booking(item.id, other, '2026-03-09', '2026-03-10');
  }
);
test(
  'an overdue physical loan blocks an existing future reservation checkout',
  async () => {
    const item = await equipment();
    const first = await booking(item.id);
    const next = await booking(item.id, other, '2026-03-09');
    await checkout(first.id);
    now = new Date('2026-03-09T16:00:00Z');
    const response = await post(staff, `/bookings/${next.id}/checkout`, { expectedVersion: 1, notes: '' }).expect(409);
    assert.equal(response.body.error.code, 'STILL_OUT');
    assert.equal((await detail(staff, first.id)).overdue, true);
  }
);
test(
  'members cannot confirm a physical return',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await checkout(record.id);
    await post(member, `/bookings/${record.id}/return`, { expectedVersion: 2, notes: '', returnCondition: 'ready' }).expect(403);
  }
);
test(
  'maintenance returns require a reason and create a condition report',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await checkout(record.id);
    await post(
      staff,
      `/bookings/${record.id}/return`,
      { expectedVersion: 2, notes: '', returnCondition: 'maintenance' }
    ).expect(422);
    await post(
      staff,
      `/bookings/${record.id}/return`,
      { expectedVersion: 2, notes: 'Loose lens mount', returnCondition: 'maintenance' }
    ).expect(200);
    const result = await staff.agent.get(`/api/equipment/${item.id}`);
    assert.equal(result.body.equipment.condition, 'maintenance');
    assert.equal(result.body.equipment.open_issues, 1);
  }
);
test(
  'maintenance keeps existing reservations visible but blocks new ones',
  async () => {
    const item = await equipment();
    const record = await booking(item.id);
    await patch(
      staff,
      `/equipment/${item.id}`,
      { ...item.payload, condition: 'maintenance', conditionNotes: 'Inspection', expectedVersion: 1 }
    ).expect(200);
    assert.equal((await detail(staff, record.id)).blocked, true);
    await post(
      other,
      '/bookings',
      {
        equipmentId: item.id,
        startDate: '2026-03-09',
        endDate: '2026-03-09',
        purpose: 'Test',
        requestId: randomUUID()
      }
    ).expect(409);
  }
);
test(
  'equipment edits reject stale versions',
  async () => {
    const item = await equipment();
    await patch(staff, `/equipment/${item.id}`, { ...item.payload, name: 'Changed', expectedVersion: 1 }).expect(200);
    await patch(staff, `/equipment/${item.id}`, { ...item.payload, name: 'Old form', expectedVersion: 1 }).expect(409);
  }
);
test(
  'an expired session rejects the write until a fresh login supplies a new CSRF token',
  async () => {
    const borrower = await account('member');
    const item = await equipment();
    const input = {
      equipmentId: item.id,
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      purpose: 'Preserved draft after expiry',
      requestId: randomUUID()
    };
    await db.query("DELETE FROM sessions WHERE sess->>'userId'=$1", [borrower.user.id]);
    const rejected = await post(borrower, '/bookings', input).expect(403);
    assert.equal(rejected.body.error.code, 'CSRF_INVALID');
    const beforeLogin = await db.query('SELECT id FROM bookings WHERE request_id=$1', [input.requestId]);
    assert.equal(beforeLogin.rows.length, 0);

    const refreshed = await borrower.agent.get('/api/auth/session').expect(200);
    assert.equal(refreshed.body.user, null);
    assert.notEqual(refreshed.body.csrfToken, borrower.token);
    const login = await borrower.agent.post('/api/auth/login')
      .set('X-CSRF-Token', refreshed.body.csrfToken)
      .set('Origin', origin)
      .send({ email: borrower.user.email, password }).expect(200);
    borrower.token = login.body.csrfToken;
    await post(borrower, '/bookings', input).expect(201);
    const saved = await db.query('SELECT id FROM bookings WHERE request_id=$1', [input.requestId]);
    assert.equal(saved.rows.length, 1);
  }
);
