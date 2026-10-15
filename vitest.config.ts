import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // `npm run test:cov` (CI runs it): the unit tests' coverage of src/, failing under these
    // floors. They sit just under the coverage at #59 (statements 41%, branches 33%, functions 28%,
    // lines 43%): coverage can't drop unnoticed. Raise them as unit tests are added; the e2e tests
    // (not counted here) cover most of the rest.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/database/migrations/**'],
      reporter: ['text-summary'],
      thresholds: { statements: 40, branches: 32, functions: 27, lines: 42 },
    },
  },
});
