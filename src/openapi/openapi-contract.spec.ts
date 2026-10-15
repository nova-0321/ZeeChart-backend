import { readFileSync } from 'node:fs';

// What the API docs (openapi.json, kept up to date by `npm run openapi:check` in CI) must say
// (#59): every route is grouped under a tag, and every write that is checked for conflicts (#21)
// says it takes If-Match and may answer 409 with the conflict's body. The frontend's types are
// made from this file, so a route missing these is a client that doesn't know.

interface Operation {
  tags?: string[];
  parameters?: { name: string; in: string }[];
  responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
}

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);

/** The groups the docs show, one per domain (and its sub-areas): see each controller's @ApiTags. */
const TAGS = [
  'auth',
  'dependencies',
  'events',
  'health',
  'invitations',
  'members',
  'projects',
  'revisions',
  'tasks',
  'undo',
  'versions',
];

/** The writes RevisionInterceptor checks (conflicts.ts targetOf): changing or deleting a row. */
const isChecked = ({ path, method }: { path: string; method: string }) =>
  (method === 'patch' || method === 'delete') &&
  /^\/(tasks|events|projects|dependencies)\/\{id\}(\/(parent|move|type|archive|reopen))?$/.test(
    path,
  );
const takesIfMatch = (operation: Operation) =>
  (operation.parameters ?? []).some((p) => p.in === 'header' && p.name === 'If-Match');

describe('the API docs', () => {
  it('group every route under one of the domains, by @ApiTags', () => {
    // A controller without @ApiTags is grouped under its class name ("Task", "ProjectMembers"):
    // that shows here as a tag not in this list.
    const outside = operations.filter(
      ({ operation }) => operation.tags?.length !== 1 || !TAGS.includes(operation.tags[0]!),
    );
    expect(
      outside.map(({ path, method, operation }) => `${method} ${path}: ${String(operation.tags)}`),
    ).toEqual([]);
  });

  it('say which writes take If-Match, and their 409 (exactly those)', () => {
    const checked = operations.filter(isChecked);
    expect(checked.length).toBe(13);
    for (const { path, method, operation } of checked) {
      expect(takesIfMatch(operation), `${method} ${path}`).toBe(true);
      expect(
        operation.responses['409']?.content?.['application/json']?.schema?.$ref,
        `${method} ${path}`,
      ).toBe('#/components/schemas/ConflictErrorDto');
    }
    const others = operations.filter((o) => !isChecked(o) && takesIfMatch(o.operation));
    expect(others.map(({ path, method }) => `${method} ${path}`)).toEqual([]);
  });
});
