import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: { name: 'integration', include: ['src/__tests__/integration/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'e2e', include: ['src/__tests__/e2e/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'package', include: ['src/__tests__/package/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 75,
      },
    },
  },
})
