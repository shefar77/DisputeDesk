// Tries to reopen a PGlite database and read the row written before the kill.
import { PGlite } from '@electric-sql/pglite';

const dir = process.argv[2];
try {
  const pg = new PGlite(dir);
  await pg.waitReady;
  const r = await pg.query('select count(*)::int as n from t');
  console.log('REOPEN OK rows=' + r.rows[0].n);
  await pg.close();
  process.exit(0);
} catch (e) {
  console.log('REOPEN FAILED: ' + (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 120));
  process.exit(1);
}
