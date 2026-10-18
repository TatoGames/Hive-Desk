import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  esbuild: { jsx: 'automatic' },
  test: {
    // Tests spawn real processes and git; Windows CI runners are several times slower.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
