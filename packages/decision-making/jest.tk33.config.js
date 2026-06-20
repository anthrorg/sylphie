/** @type {import('jest').Config} */
/**
 * TK-33 scoped jest config — runs ONLY the two new spec files introduced in
 * this worktree, using the main checkout's node_modules for resolution.
 */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/tensor/tensor-candidate-builder.spec.ts',
    '**/latent-space/recall-retrieval-helper.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.json',
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': '<rootDir>/../shared/src/index.ts',
    '^@sylphie/drive-engine$': '<rootDir>/../drive-engine/src/index.ts',
  },
  // Use main checkout node_modules for NestJS and other packages
  modulePaths: ['C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules'],
};
