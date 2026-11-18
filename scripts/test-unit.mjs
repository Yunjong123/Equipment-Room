import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir('tests/unit')).filter((name) => name.endsWith('.test.mjs')).sort();
const result = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types', '--test', ...files.map((name) => `tests/unit/${name}`),
  ],
  { stdio: 'inherit' }
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
