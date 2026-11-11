/**
 * Production build for the server.
 *
 * Development runs TypeScript directly through `tsx`, which is ideal for a
 * fast edit/restart loop but keeps a transpiler resident and transpiles the
 * whole project on every boot. On a small instance that is expensive twice
 * over: it was the bulk of an ~8s startup, and the transient memory it needed
 * at boot was enough to breach a 512 MiB container before the port ever opened.
 *
 * So production gets a plain JavaScript bundle and runs on bare `node`.
 *
 * `packages: 'external'` means only our own source — server/src plus shared/src,
 * whose `@shared/*` aliases are resolved here at build time — is bundled. Every
 * dependency is left as a normal import so it loads from node_modules at
 * runtime, which keeps native and WASM packages (PGlite, pg) working exactly as
 * they do under tsx.
 *
 * The bundle lands at server/dist/index.js. Note that `env.ts` derives repoRoot
 * two levels up from its own file, which is the repository root from both
 * server/src/ and server/dist/ — so .env loading and serving web/dist are
 * unaffected by the move.
 */

import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  // Keeps stack traces pointing at the TypeScript sources when something throws
  // in production; costs nothing at runtime because it is a separate file.
  sourcemap: 'linked',
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`server bundle: ${(bytes / 1024).toFixed(1)} kB`);
