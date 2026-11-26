import { loadConfig } from '../server/config.ts';
import { openDatabase, migrate } from '../server/db.ts';
import { seedDemo } from '../server/seed.ts';
const config = loadConfig();
const db = await openDatabase(config);
try {
  await migrate(db);
  await seedDemo(db, config);
  console.log('Demo seed checked. Existing records were not overwritten.');
} finally {
  await db.close();
}
