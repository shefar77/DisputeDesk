import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@shared\/(.*)\.js$/, replacement: `${shared}/$1.ts` }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // One in-memory Postgres per worker; demo gateway; no keys of any kind.
    env: {
      PGLITE_DIR: 'memory://',
      DEMO_MODE: 'true',
      ANTHROPIC_API_KEY: '',
      ELASTIC_URL: '',
      KERNEL_API_KEY: '',
      POLL_ENABLED: 'false',
      LOG_LEVEL: 'error',
    },
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
