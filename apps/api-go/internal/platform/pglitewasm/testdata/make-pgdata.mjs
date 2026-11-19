// Test setup only: makes the synthetic PGlite 0.5.15 data folder SIPGES_PGLITE_PGDATA names, with
// PGlite itself: table t with 2000 rows (id int, x float8, s text, d timestamptz) and a plpgsql
// function f(). Synthetic data only.
//   node make-pgdata.mjs <@electric-sql/pglite 0.5.15 dist folder> <new data folder>
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';

const [dist, dir] = process.argv.slice(2);
if (!dist || !dir) {
  console.error('usage: node make-pgdata.mjs <pglite dist> <new data folder>');
  process.exit(2);
}
const { PGlite } = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
const db = new PGlite(resolve(dir));
await db.exec(`create table t(id int primary key, x float8, s text, d timestamptz default now());
insert into t select g, g*1.5, repeat('ab', g), now() from generate_series(1,2000) g;
create function f() returns int language plpgsql as $$ begin return 1; end $$;`);
const [row] = (await db.query('select count(*)::int as n, sum(x) as sum from t')).rows;
await db.close();
if (row.n !== 2000 || row.sum !== 3001500) {
  console.error(`unexpected synthetic data: ${row.n} rows, sum ${row.sum}`);
  process.exit(1);
}
console.log(`synthetic PGlite data folder: ${resolve(dir)}`);
