import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const typescriptHook = fileURLToPath(new URL('./src/__tests__/helpers/typescript-hook.ts', import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    execArgv: ['--import', typescriptHook],
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
      autoAttachSubprocess: true,
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 75,
      },
    },
  },
})
