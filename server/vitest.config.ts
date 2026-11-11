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
    // Every provider key is blanked explicitly: these are set before .env is
    // read, and env.ts only fills a variable that is still undefined, so a real
    // key in .env can never reach a test and turn it into a paid network call.
    env: {
      PGLITE_DIR: 'memory://',
      DEMO_MODE: 'true',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      LLM_PROVIDER: '',
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
