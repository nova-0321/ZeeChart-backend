import { readdirSync } from 'node:fs';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Each folder in src/ is a domain. A domain reads another domain's data through that domain's
// exported service, never through its entities (or a repository of them): see #55. Entities may
// still name each other, for TypeORM relations, and tests may build any rows they need.
const domains = readdirSync(new URL('./src', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// The same for SQL written by hand, which an import rule can't see: a domain names only its own
// tables after FROM / JOIN / INTO / UPDATE. The migrations (src/database) set up every table.
const TABLES = {
  auth: ['users'],
  dependencies: ['task_dependencies'],
  events: ['events'],
  members: ['members', 'invitations'],
  projects: ['projects'],
  revisions: ['revisions', 'project_versions'],
  tasks: ['tasks'],
};
const allTables = Object.values(TABLES).flat();
const foreignTables = (domain) => allTables.filter((table) => !TABLES[domain]?.includes(table));
const sqlOn = (tables) => `/\\b(FROM|JOIN|INTO|UPDATE)\\s+"(${tables.join('|')})"/i`;

const domainBoundaries = domains.map((domain) => ({
  files: [`src/${domain}/**/*.ts`],
  ignores: [`src/${domain}/entities/**`, '**/*.spec.ts', 'src/database/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: `^(\\.\\./)+(?!${domain}/)[a-z-]+/entities/`,
            message: `Another domain's entity: use that domain's exported service instead (#55).`,
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...[
        `Literal[value=${sqlOn(foreignTables(domain))}]`,
        `TemplateElement[value.raw=${sqlOn(foreignTables(domain))}]`,
      ].map((selector) => ({
        selector,
        message: `SQL on another domain's table: use that domain's exported functions instead (#55).`,
      })),
    ],
  },
}));

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,mts,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Shared with frontend
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Backend: catch un-awaited promises (type-aware)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Plain JS/config files aren't in a tsconfig; skip type-aware rules there.
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.vitest },
  },
  ...domainBoundaries,
  prettier, // keep last: turns off rules that clash with Prettier
]);
