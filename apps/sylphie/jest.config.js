/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

// Worktrees don't have their own node_modules — resolve from the main checkout.
const MAIN_MODULES = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.spec.json',
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@sylphie/decision-making$': '<rootDir>/../../packages/decision-making/src/index.ts',
    '^@sylphie/drive-engine$': '<rootDir>/../../packages/drive-engine/src/index.ts',
    '^@sylphie/learning$': '<rootDir>/../../packages/learning/src/index.ts',
    '^@sylphie/planning$': '<rootDir>/../../packages/planning/src/index.ts',
    '^@sylphie/supervisor$': '<rootDir>/../../packages/supervisor/src/index.ts',
  },
  // Worktrees share node_modules with the main checkout; add it to the search path.
  moduleDirectories: ['node_modules', MAIN_MODULES],
};
