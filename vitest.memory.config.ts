import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--expose-gc'],
    include: ['test/memory/**/*.memory-test.ts'],
    testTimeout: 180_000,
  },
})
