import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    exclude: ['tests/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.mjs'],
      all: true,
      reporter: ['text'],
    },
  },
});
