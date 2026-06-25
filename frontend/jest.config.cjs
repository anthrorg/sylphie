/** @type {import('jest').Config} */
const NPX_CACHE = 'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules'
const TSJEST = require.resolve(`${NPX_CACHE}/ts-jest`)

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: {
        target: 'ES2020',
        module: 'CommonJS',
        strict: true,
        skipLibCheck: true,
        // No DOM lib needed — tests use plain Node
      },
      diagnostics: false,
    }],
  },
}
