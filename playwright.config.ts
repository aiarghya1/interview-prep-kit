import { defineConfig, devices } from '@playwright/test';

/** End-to-end: real browser -> Next.js (production build) -> Express -> MongoDB, fixture sites, scripted model. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3199', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
  webServer: [
    { command: 'npx tsx e2e/start-api.mts', url: 'http://localhost:4199/api/health', timeout: 120_000, reuseExistingServer: false },
    {
      command: 'npm run build -w @kit/web && npx next start apps/web -p 3199',
      env: { API_URL: 'http://localhost:4199', NEXT_DIST_DIR: '.next-e2e', NEXT_TELEMETRY_DISABLED: '1' },
      url: 'http://localhost:3199/login',
      timeout: 300_000,
      reuseExistingServer: false,
    },
  ],
});
