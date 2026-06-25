/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

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
  moduleNameMapper: {
    '^@nestjs/config$': '<rootDir>/src/__mocks__/@nestjs/config.ts',
    '^@nestjs/common$': 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules/@nestjs/common',
  },
  modulePaths: [
    'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules',
  ],
};
