/**
 * Unit tests for AnthropicLlmService.
 *
 * Tests cover:
 * - Cost estimation (pre-call)
 * - Availability checks (API key presence)
 * - Token counting and cost calculation
 */

import { AnthropicLlmService } from '../anthropic-llm.service';
import type { LlmRequest } from '../../../shared/types/llm.types';

describe('AnthropicLlmService', () => {
  describe('estimateCost', () => {
    /**
     * Create a minimal mock service for cost estimation testing.
     * We only need the estimateCost method which is pure (no side effects).
     */
    const createTestService = () => {
      // Create a minimal service instance for testing
      const mockConfigService = {
        get: jest.fn().mockReturnValue({
          llm: {
            anthropicApiKey: 'test-api-key',
            model: 'claude-sonnet-4-20250514',
            maxTokens: 4096,
            temperature: 0.7,
            costTrackingEnabled: true,
          },
        }),
      };

      const mockEventService = {
        record: jest.fn(),
      };

      const mockMetricsReporter = {
        reportMetrics: jest.fn(),
      };

      const mockDriveStateReader = {
        getCurrentState: jest.fn(),
      };

      return new AnthropicLlmService(
        mockConfigService as any,
        mockEventService as any,
        mockMetricsReporter as any,
        mockDriveStateReader as any,
      );
    };

    it('should estimate token count and latency', () => {
      const service = createTestService();

      const request: LlmRequest = {
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        systemPrompt: 'You are a helpful assistant.',
        maxTokens: 1000,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const estimate = service.estimateCost(request);

      expect(estimate.tokenEstimate).toBeGreaterThan(0);
      expect(estimate.latencyEstimate).toBeGreaterThan(0);
      expect(estimate.cognitiveEffortCost).toBeGreaterThanOrEqual(0);
      expect(estimate.cognitiveEffortCost).toBeLessThanOrEqual(1);
    });

    it('should estimate higher tokens for longer prompts', () => {
      const service = createTestService();

      const shortRequest: LlmRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'Help',
        maxTokens: 100,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const longRequest: LlmRequest = {
        messages: [{ role: 'user', content: 'A'.repeat(1000) }],
        systemPrompt: 'B'.repeat(1000),
        maxTokens: 100,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const shortEstimate = service.estimateCost(shortRequest);
      const longEstimate = service.estimateCost(longRequest);

      expect(longEstimate.tokenEstimate).toBeGreaterThan(
        shortEstimate.tokenEstimate,
      );
    });

    it('should cap cognitive effort cost at 1.0', () => {
      const service = createTestService();

      const hugeRequest: LlmRequest = {
        messages: [{ role: 'user', content: 'A'.repeat(100000) }],
        systemPrompt: 'B'.repeat(100000),
        maxTokens: 50000,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const estimate = service.estimateCost(hugeRequest);

      expect(estimate.cognitiveEffortCost).toBeLessThanOrEqual(1.0);
    });

    it('should estimate latency proportional to token count', () => {
      const service = createTestService();

      const smallRequest: LlmRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'Help',
        maxTokens: 100,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const largeRequest: LlmRequest = {
        messages: [{ role: 'user', content: 'X'.repeat(5000) }],
        systemPrompt: 'Y'.repeat(5000),
        maxTokens: 4000,
        temperature: 0.7,
        metadata: {
          callerSubsystem: 'COMMUNICATION',
          purpose: 'TEST',
          sessionId: 'test-session',
        },
      };

      const smallEstimate = service.estimateCost(smallRequest);
      const largeEstimate = service.estimateCost(largeRequest);

      expect(largeEstimate.latencyEstimate).toBeGreaterThan(
        smallEstimate.latencyEstimate,
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is configured', () => {
      const mockConfigService = {
        get: jest.fn().mockReturnValue({
          llm: {
            anthropicApiKey: 'test-api-key',
            model: 'claude-sonnet-4-20250514',
            maxTokens: 4096,
            temperature: 0.7,
            costTrackingEnabled: true,
          },
        }),
      };

      const mockEventService = { record: jest.fn() };
      const mockMetricsReporter = { reportMetrics: jest.fn() };
      const mockDriveStateReader = { getCurrentState: jest.fn() };

      const service = new AnthropicLlmService(
        mockConfigService as any,
        mockEventService as any,
        mockMetricsReporter as any,
        mockDriveStateReader as any,
      );

      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when API key is empty', () => {
      const mockConfigService = {
        get: jest.fn().mockReturnValue({
          llm: {
            anthropicApiKey: '',
            model: 'claude-sonnet-4-20250514',
            maxTokens: 4096,
            temperature: 0.7,
            costTrackingEnabled: true,
          },
        }),
      };

      const mockEventService = { record: jest.fn() };
      const mockMetricsReporter = { reportMetrics: jest.fn() };
      const mockDriveStateReader = { getCurrentState: jest.fn() };

      const service = new AnthropicLlmService(
        mockConfigService as any,
        mockEventService as any,
        mockMetricsReporter as any,
        mockDriveStateReader as any,
      );

      expect(service.isAvailable()).toBe(false);
    });
  });
});
