import { loadConfig } from '../server/config.ts';
import { openDatabase, migrate } from '../server/db.ts';
const db = await openDatabase(loadConfig());
try {
    await migrate(db);
    console.log('Database migrations are up to date.');
} finally {
    await db.close();
}