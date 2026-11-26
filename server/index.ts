import { loadConfig } from './config.ts';
import { openDatabase, migrate } from './db.ts';
import { createApp } from './app.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();
const db = await openDatabase(config);
if (!config.production) await migrate(db);
else {
  const migration = await db.query('SELECT version FROM schema_migrations WHERE version=1');
  if (!migration.rows.length) throw new Error('Run database migrations before starting the server.');
}
if (config.demo) await seedDemo(db, config);
const app = createApp(db, config);
const server = app.listen(
  config.port,
  config.host,
  () => {
    console.log(`Equipment Room API: http://${config.host}:${config.port}`);
    if (config.demo) console.log('Local demo accounts are enabled.');
  }
);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
