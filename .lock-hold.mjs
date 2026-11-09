// Opens a PGlite database, writes a row, then waits to be killed.
import { PGlite } from '@electric-sql/pglite';

const dir = process.argv[2];
const pg = new PGlite(dir);
await pg.waitReady;
await pg.exec(`CREATE TABLE IF NOT EXISTS t (id int primary key, note text);`);
await pg.exec(`INSERT INTO t VALUES (1, 'written before the kill') ON CONFLICT DO NOTHING;`);
const r = await pg.query('select count(*)::int as n from t');
console.log('HELD rows=' + r.rows[0].n);
setInterval(() => {}, 1000); // stay alive until killed
