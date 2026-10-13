import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Every sign-up and sign-in is a password hash (about 0.2 s, more while the files run side by
    // side), and some tests make a dozen in a row: the default 5 s is too tight.
    testTimeout: 30_000,
  },
});
