import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'text'],
      // Enforced: `npm run coverage` fails if any metric drops below 100%.
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
