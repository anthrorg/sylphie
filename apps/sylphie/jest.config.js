/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Scoped to *.controller.spec.ts (jest-style) and the explicit VWM service
  // specs (which are jest-compatible and require @nestjs/common via NODE_PATH).
  // The tsx-run service specs (theater-affect-scorer, cycle-outcome-reporter,
  // communication.cost) — which are NOT jest-compatible — are excluded by not
  // matching their filenames here.
  testMatch: [
    '**/*.controller.spec.ts',
    // TK-102 stale-track eviction (VWM service, jest-compatible)
    '**/visual-working-memory.stale-eviction.spec.ts',
    // TK-155 guardian pool wiring (jest-compatible: constructor-injected
    // mocks, no live DB)
    '**/guardian-pool.provider.spec.ts',
    '**/guardian-rules.service.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.json',
      diagnostics: false,
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
};
