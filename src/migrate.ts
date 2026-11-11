import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './db';

async function main(): Promise<void> {
  const sql = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration complete');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
