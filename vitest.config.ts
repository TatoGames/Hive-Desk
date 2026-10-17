import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests spawn real processes and git; Windows CI runners are several times slower.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
