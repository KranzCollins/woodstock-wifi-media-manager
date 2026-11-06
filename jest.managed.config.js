// W&W managed-organization extension tests (docs/managed-extension/README.md).
// Separate from the root jest.config.ts, which needs @nx/jest. Transpile-only
// (isolatedModules): type-check with tsc separately. @prisma/client is mapped
// to a FAKE so the tests need neither a database nor a generated client.
//
// The content gate runs the REAL editor sanitizer (sanitize.post.content.ts ->
// isomorphic-dompurify -> jsdom 29). Some of jsdom's dependencies ship ESM
// only; Node loads them with require(esm), Jest's module registry can't, so
// only those packages are transformed to CommonJS for Jest (no behaviour
// change, nothing mocked). Every other node_modules file is left as is.
const ESM_PACKAGES = [
  '@exodus',
  '@asamuzakjp',
  '@bramus',
  '@csstools',
  'css-tree',
  'entities',
  'lru-cache',
  'parse5',
  'tough-cookie',
].join('|');

module.exports = {
  displayName: 'managed-extension',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/managed/__tests__/**/*.spec.ts',
    '<rootDir>/apps/backend/src/managed-api/__tests__/**/*.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/managed-creative/__tests__/**/*.spec.ts',
    '<rootDir>/apps/orchestrator/src/activities/__tests__/**/*.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.managed.spec.json', isolatedModules: true },
    ],
    '^.+\\.m?js$': '<rootDir>/managed-jest-esm-transformer.cjs',
  },
  transformIgnorePatterns: [`/node_modules/(?!(?:.*/node_modules/)?(?:${ESM_PACKAGES})/)`],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  moduleNameMapper: {
    '^@prisma/client$':
      '<rootDir>/libraries/nestjs-libraries/src/database/prisma/managed/__tests__/fakes/prisma.client.fake.ts',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/orchestrator/(.*)$': '<rootDir>/apps/orchestrator/src/$1',
  },
};
