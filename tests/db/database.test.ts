import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate, openDatabase, sqlState, type Database } from '../../server/db.ts';

async function withDatabase(work: (db: Database) => Promise<void>) {
  const db = await openDatabase({ databaseUrl: undefined, dataDir: ':memory:', ssl: false });
  try {
    await migrate(db);
    await work(db);
  } finally {
    await db.close();
  }
}

test('migration is repeatable and creates the expected schema', async () => {
  await withDatabase(async (db) => {
    await migrate(db);

    const migrations = await db.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    assert.deepEqual(migrations.rows, [{ version: 1 }]);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    assert.deepEqual(
      tables.rows.map(({ table_name }) => table_name),
      [
        'audit_events',
        'booking_days',
        'bookings',
        'equipment',
        'issues',
        'photos',
        'schema_migrations',
        'sessions',
        'users',
      ],
    );
  });
});

test('overlapping booking days are rejected and the transaction rolls back', async () => {
  await withDatabase(async (db) => {
    const userId = randomUUID();
    const equipmentId = randomUUID();
    const bookingId = randomUUID();

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, 'Test member', 'test-hash', 'member')",
          [userId, `${userId}@example.test`],
        );
        await tx.query(
          "INSERT INTO equipment (id, asset_tag, name, category, location, condition) VALUES ($1, $2, 'Test camera', 'camera', 'Test shelf', 'ready')",
          [equipmentId, `TEST-${equipmentId}`],
        );
        await tx.query(
          "INSERT INTO bookings (id, equipment_id, user_id, start_date, end_date, purpose, request_id) VALUES ($1, $2, $3, '2026-12-01', '2026-12-01', 'Constraint test', $4)",
          [bookingId, equipmentId, userId, randomUUID()],
        );
        await tx.query(
          "INSERT INTO booking_days (equipment_id, day, booking_id) VALUES ($1, '2026-12-01', $2)",
          [equipmentId, bookingId],
        );
        await tx.query(
          "INSERT INTO booking_days (equipment_id, day, booking_id) VALUES ($1, '2026-12-01', $2)",
          [equipmentId, bookingId],
        );
      }),
      (error: unknown) => {
        assert.equal(sqlState(error), '23505');
        return true;
      },
    );

    const residue = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users WHERE id = $1',
      [userId],
    );
    assert.equal(residue.rows[0]?.count, '0');
  });
});

test('an item cannot have two checked-out bookings', async () => {
  await withDatabase(async (db) => {
    const userId = randomUUID();
    const equipmentId = randomUUID();

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, 'Test member', 'test-hash', 'member')",
          [userId, `${userId}@example.test`],
        );
        await tx.query(
          "INSERT INTO equipment (id, asset_tag, name, category, location, condition) VALUES ($1, $2, 'Test camera', 'camera', 'Test shelf', 'ready')",
          [equipmentId, `TEST-${equipmentId}`],
        );
        for (const day of ['2026-12-01', '2026-12-02']) {
          await tx.query(
            "INSERT INTO bookings (id, equipment_id, user_id, start_date, end_date, purpose, request_id, status, checked_out_at) VALUES ($1, $2, $3, $4, $4, 'Open loan test', $5, 'checked_out', now())",
            [randomUUID(), equipmentId, userId, day, randomUUID()],
          );
        }
      }),
      (error: unknown) => {
        assert.equal(sqlState(error), '23505');
        return true;
      },
    );
  });
});
