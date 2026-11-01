import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (PRD §21): queue -> detail -> approve -> status, in demo mode.
 * `npm run test:e2e` runs once; `npx playwright test --repeat-each=20` is the
 * PRD's "20 scripted runs" reliability check (each run resets demo data first).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8799', trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npm run build && cd server && node --import tsx src/index.ts',
    url: 'http://localhost:8799/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
    env: { PORT: '8799', DEMO_MODE: 'true', PGLITE_DIR: 'memory://', POLL_ENABLED: 'false', LOG_LEVEL: 'warn', ANTHROPIC_API_KEY: '' },
  },
});
