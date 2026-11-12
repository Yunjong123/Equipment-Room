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
const origin = 'http//127.0.0.1:5173';
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
        assetTag: `TEST-${randomUUID().slice(0.8).toUpperCase()}`,
        name: 'Test camera',
        category: 'camera',
        description: 'Test kit',
        location: 'Test desk',
        condition: 'ready',
        conditionNote: ''
    };
    const response = await post(staff, '/equipment', payload).expect(201);
    return { id: response.body.id as string, payload };
}
async function booking(equipmentId: string, who = member, startDate = '2026-03-08', endDate = startDate) {
    const body = {equipmentId, startDate, endDate, purpose: 'API test project', requestId: randomUUID() };
    const result = await post(who, '/bookings', body).expect(201);
    return { id: result.body.id as string, body };
}
const detail = async (who: Account, id: string) => (await who.agent.get(`/api/bookings/${id}`).expect(200)).body.booking;
async function checkout(id: string) {
    const record = await detail(staff, id);
    await post(staff, `/bookings/${id}/checkout`, { expectedVersion: record.version, notes: ''}).expect(200);
}

before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'equipment-room-test-'));
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl && !new URL(databaseUrl).pathname.endsWith('_test')) {
        throw new Error('TEST_DATABASE_URL must name a dedicated databse ending in _test.');
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
        sessionSeceret: 'test-session-secret-at-least-32-characters',
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
})

test(
    'unauthenticated invetory access is denied',
    async () => {
        await supertest(app).get('/api/equipment').expect(401);
    }
);
test(
    'multations without a CSRF token are rejected',
    async () => {
        await member.agent.post('/api/bookings').send({}).expect(403);
    }
);
test(
    'mutations from another origin are rejected',
    async () => {
        await member.agent.post('/api/bookings').set('X-CSRF-Token', member.token).set(
            'Origin',
            'http://another.example'
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
        .send({ email: `${randomUUID}}@example.com`, name: 'Attempt', password, role: 'staff'}).expect(422);
    }
);
test(
    'registration creates a member account',
    async () => {
        const agent = supertest.agent(app);
        const session = await agent.get('/api/auth/session');
        const response = await agent.post('/api/auth/register').set('X-CSRF-Token', session.body.csrfToken)
            .send({ email: `${randomUUID}}@example.com`, name: 'New Member', password}).expect(201);
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
    'equipment edits reject state versions',
    async () => {
        const item = await equipment();
        await patch(staff, `/equipment/${item.id}`, { ...item.payload, name: 'Changed', expectedVersion: 1 }).expect(200);
        await patch(staff, `/equipment/${item.id}`, { ...item.payload, name: 'Old form', expectedVersion: 1 }).expect(409);
    }
);