/**
 * Unit tests for PlanningRateLimiterService (ticket E8-T015).
 *
 * Tests cover:
 * - Rate limit checks (per-window and active plan caps)
 * - Window duration and reset behavior
 * - Plan creation and evaluation tracking
 * - State reporting for dashboard
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, PlanningConfig } from '../../shared/config/app.config';
import { PlanningRateLimiterService } from './planning-rate-limiter.service';
import type { RateLimiterState } from '../interfaces/planning.interfaces';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a PlanningConfig mock with optional overrides.
 */
function createMockConfig(overrides?: Partial<PlanningConfig>): PlanningConfig {
  return {
    queueMaxSize: 50,
    queueDecayRatePerHour: 0.1,
    queueMinPriority: 0.01,
    coldStartThreshold: 100,
    coldStartInitialDampening: 0.8,
    maxPlansPerWindow: 3,
    windowDurationMs: 3600000, // 1 hour
    maxActivePlans: 10,
    maxTokensPerPlan: 4000,
    processingIntervalMs: 5000,
    researchTimeWindowDays: 7,
    minFailuresForEvidence: 2,
    simulationMinExpectedValue: 0.3,
    maxProposalRevisions: 2,
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('PlanningRateLimiterService', () => {
  let service: PlanningRateLimiterService;
  let mockConfigService: jest.Mocked<ConfigService<AppConfig>>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return {
            sessionId: 'test-session',
            planning: createMockConfig(),
          };
        }
        return {
          app: {
            sessionId: 'test-session',
            planning: createMockConfig(),
          },
        };
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningRateLimiterService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<PlanningRateLimiterService>(PlanningRateLimiterService);
  });

  // --------
  // Basic Rate Limiting Tests
  // --------

  it('should allow fresh limiter to proceed (canProceed returns true)', () => {
    expect(service.canProceed()).toBe(true);
  });

  it('should enforce per-window plan creation cap', () => {
    const config = createMockConfig({ maxPlansPerWindow: 3 });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 3 plans (at threshold)
    expect(rateLimiter.canProceed()).toBe(true);
    rateLimiter.recordPlanCreated();

    expect(rateLimiter.canProceed()).toBe(true);
    rateLimiter.recordPlanCreated();

    expect(rateLimiter.canProceed()).toBe(true);
    rateLimiter.recordPlanCreated();

    // 4th should be blocked
    expect(rateLimiter.canProceed()).toBe(false);
  });

  it('should enforce active plans limit', () => {
    const config = createMockConfig({ maxActivePlans: 5, maxPlansPerWindow: 10 });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 5 active plans
    for (let i = 0; i < 5; i++) {
      expect(rateLimiter.canProceed()).toBe(true);
      rateLimiter.recordPlanCreated();
    }

    // 6th should be blocked by active plans cap
    expect(rateLimiter.canProceed()).toBe(false);
  });

  it('should block when either per-window or active-plans cap is reached', () => {
    const config = createMockConfig({
      maxPlansPerWindow: 3,
      maxActivePlans: 2,
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 2 plans (at active plans limit)
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();

    // Should be blocked due to active plans cap
    expect(rateLimiter.canProceed()).toBe(false);
  });

  // --------
  // Window Reset Tests
  // --------

  it('should reset window when duration expires', (done) => {
    const config = createMockConfig({
      maxPlansPerWindow: 2,
      windowDurationMs: 100, // 100ms for testing
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 2 plans (at threshold)
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();

    // Should be blocked
    expect(rateLimiter.canProceed()).toBe(false);

    // Wait for window to expire
    setTimeout(() => {
      // After window reset, should be allowed again
      expect(rateLimiter.canProceed()).toBe(true);
      done();
    }, 150);
  });

  it('should reset per-window counter after window expires', (done) => {
    const config = createMockConfig({
      maxPlansPerWindow: 2,
      windowDurationMs: 100,
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Fill window
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();

    let state = rateLimiter.getState();
    expect(state.plansThisWindow).toBe(2);

    // Wait for window reset
    setTimeout(() => {
      state = rateLimiter.getState();
      expect(state.plansThisWindow).toBe(0);
      done();
    }, 150);
  });

  // --------
  // Plan Tracking Tests
  // --------

  it('should increment active plans on recordPlanCreated', () => {
    service.recordPlanCreated();
    service.recordPlanCreated();

    let state = service.getState();
    expect(state.activePlans).toBe(2);
  });

  it('should decrement active plans on recordPlanEvaluated', () => {
    service.recordPlanCreated();
    service.recordPlanCreated();

    let state = service.getState();
    expect(state.activePlans).toBe(2);

    service.recordPlanEvaluated();
    state = service.getState();
    expect(state.activePlans).toBe(1);

    service.recordPlanEvaluated();
    state = service.getState();
    expect(state.activePlans).toBe(0);
  });

  it('should not allow active plans count to go negative', () => {
    // Call recordPlanEvaluated without any active plans
    service.recordPlanEvaluated();
    service.recordPlanEvaluated();

    const state = service.getState();
    expect(state.activePlans).toBe(0);
  });

  it('should track per-window plan count accurately', () => {
    service.recordPlanCreated();
    service.recordPlanCreated();
    service.recordPlanCreated();

    let state = service.getState();
    expect(state.plansThisWindow).toBe(3);
  });

  // --------
  // State Reporting Tests
  // --------

  it('should return accurate metrics via getState()', () => {
    service.recordPlanCreated();
    service.recordPlanCreated();

    const state = service.getState();

    expect(state).toHaveProperty('plansThisWindow', 2);
    expect(state).toHaveProperty('activePlans', 2);
    expect(state).toHaveProperty('windowResetsAt');
    expect(state).toHaveProperty('canProceed');
    expect(state.canProceed).toBe(true); // Only 2 of 3 plans per window
  });

  it('should report canProceed false when limits exceeded', () => {
    const config = createMockConfig({
      maxPlansPerWindow: 2,
      maxActivePlans: 2,
    });
    mockConfigService.get.mockImplementation((key?: string) => {
      if (key === 'app') {
        return { sessionId: 'test-session', planning: config };
      }
      return { app: { sessionId: 'test-session', planning: config } };
    });

    service = new PlanningRateLimiterService(mockConfigService);

    // Create 2 plans (at both limits)
    service.recordPlanCreated();
    service.recordPlanCreated();

    const state = service.getState();
    expect(state.canProceed).toBe(false);
  });

  it('should calculate windowResetsAt correctly', () => {
    const config = createMockConfig({
      windowDurationMs: 3600000, // 1 hour
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    const state = rateLimiter.getState();
    const now = new Date();
    const expectedResetTime = now.getTime() + 3600000;

    // windowResetsAt should be approximately now + windowDurationMs
    // Allow 100ms tolerance for execution time
    expect(state.windowResetsAt.getTime()).toBeGreaterThanOrEqual(expectedResetTime - 100);
    expect(state.windowResetsAt.getTime()).toBeLessThanOrEqual(expectedResetTime + 100);
  });

  // --------
  // Complex Scenarios
  // --------

  it('should handle mixed plan creation and evaluation', () => {
    const config = createMockConfig({
      maxPlansPerWindow: 5,
      maxActivePlans: 10,
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 3 plans
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();

    let state = rateLimiter.getState();
    expect(state.plansThisWindow).toBe(3);
    expect(state.activePlans).toBe(3);
    expect(state.canProceed).toBe(true); // Still under both limits

    // Evaluate 2 plans
    rateLimiter.recordPlanEvaluated();
    rateLimiter.recordPlanEvaluated();

    state = rateLimiter.getState();
    expect(state.plansThisWindow).toBe(3); // Window count unchanged
    expect(state.activePlans).toBe(1); // Active count decreased
    expect(state.canProceed).toBe(true);
  });

  it('should maintain per-window cap independently of active plans', (done) => {
    const config = createMockConfig({
      maxPlansPerWindow: 2,
      maxActivePlans: 10,
      windowDurationMs: 100,
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Create 2 plans (at window limit)
    rateLimiter.recordPlanCreated();
    rateLimiter.recordPlanCreated();

    expect(rateLimiter.canProceed()).toBe(false);

    // Evaluate both plans to reduce active count to 0
    rateLimiter.recordPlanEvaluated();
    rateLimiter.recordPlanEvaluated();

    let state = rateLimiter.getState();
    expect(state.activePlans).toBe(0);
    expect(state.plansThisWindow).toBe(2);
    expect(state.canProceed).toBe(false); // Still blocked by window cap

    // Wait for window to reset
    setTimeout(() => {
      state = rateLimiter.getState();
      expect(state.canProceed).toBe(true); // Now allowed
      done();
    }, 150);
  });

  it('should work correctly at boundary conditions', () => {
    const config = createMockConfig({
      maxPlansPerWindow: 1,
      maxActivePlans: 1,
    });
    const newMockConfigService = {
      get: jest.fn((key?: string) => {
        if (key === 'app') {
          return { sessionId: 'test-session', planning: config };
        }
        return { app: { sessionId: 'test-session', planning: config } };
      }),
    } as any;

    const rateLimiter = new PlanningRateLimiterService(newMockConfigService);

    // Should allow exactly 1
    expect(rateLimiter.canProceed()).toBe(true);
    rateLimiter.recordPlanCreated();

    // Should block the 2nd
    expect(rateLimiter.canProceed()).toBe(false);

    // Evaluate the plan
    rateLimiter.recordPlanEvaluated();
    expect(rateLimiter.canProceed()).toBe(false); // Still blocked by window

    let state = rateLimiter.getState();
    expect(state.activePlans).toBe(0);
    expect(state.plansThisWindow).toBe(1);
  });
});
