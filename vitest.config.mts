import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@main': r('./src/main'),
      '@preload': r('./src/preload'),
      '@renderer': r('./src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
