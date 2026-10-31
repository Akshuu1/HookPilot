import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', '**/*.e2e.*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['apps/*/src/services/**'],
      exclude: ['**/node_modules/**', '**/dist/**', 'apps/worker/src/services/alert-*.service.ts'],
      thresholds: {
        lines: 70,
        functions: 75,
        statements: 70,
      },
    },
  },
});
