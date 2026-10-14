import { defineConfig } from 'vitest/config'

// Vitest runs *.spec.ts. Files named *.test.ts belong to `claude plugin test`.
export default defineConfig({
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30_000, hookTimeout: 30_000, maxConcurrency: 4 },
})
