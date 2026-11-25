import { readdir, stat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDatabase, type Database } from '../server/db.ts';

export async function cleanupExpiredData(
  db: Database,
  dataDir: string,
  now = Date.now(),
): Promise<number> {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  const directory = path.join(dataDir, 'uploads');
  const files = await readdir(directory).catch(() => [] as string[]);
  let removed = 0;
  for (const name of files) {
    if (!/^[a-f0-9-]{36}\.webp$/.test(name)) continue;
    const file = path.join(directory, name);
    if (now - (await stat(file)).mtimeMs < 24 * 60 * 60 * 1000) continue;
    const result = await db.query('SELECT id FROM photos WHERE id=$1', [name.slice(0, -5)]);
    if (!result.rows.length) {
      await unlink(file);
      removed++;
    }
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const db = await openDatabase(config);
  try {
    const removed = await cleanupExpiredData(db, config.dataDir);
    console.log(`Removed ${removed} unreferenced photo files. Expired sessions cleared.`);
  } finally {
    await db.close();
  }
}
