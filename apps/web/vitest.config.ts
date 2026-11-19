import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/lib/types.ts'], // type declarations only: no runtime code
      reporter: ['text-summary', 'text'],
      // Enforced: `npm run coverage` fails if any metric drops below 100%.
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
