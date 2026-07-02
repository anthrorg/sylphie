/** @type {import('jest').Config} */
let TSJEST;
try {
  TSJEST = require.resolve('ts-jest');
} catch {
  TSJEST = require.resolve(
    'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
  );
}

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.json',
      diagnostics: false,
    }],
  },
};
