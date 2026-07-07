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
    // TK-109 route-auth guard (jest-compatible: direct-instantiation, no live DB)
    '**/route-auth.guard.spec.ts',
    // TK-111 shared boot-deadline helper (jest-compatible: pure, no live DB)
    '**/boot-deadline.spec.ts',
    // TK-113 stt.service close-handler guard (jest-compatible)
    '**/stt.service.spec.ts',
    // TK-114 audio/conversation gateway client-notify (jest-compatible)
    '**/audio.gateway.spec.ts',
    '**/conversation.gateway.spec.ts',
    // TK-115 communication.service unhandled-rejection guard (jest-compatible)
    '**/communication.service.spec.ts',
    // TK-116 sensory-logger interval-leak guard (jest-compatible)
    '**/sensory-logger.service.spec.ts',
    // TK-117 drive-publisher telemetry-honesty guard (jest-compatible)
    '**/drive-publisher.service.spec.ts',
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
