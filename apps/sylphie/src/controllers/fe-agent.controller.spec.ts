/**
 * TK-142 (item 20260702-005) — FE Agent proxy contract.
 *
 * AC: given a production build of the frontend, the bundle contains no
 * Anthropic key, and the FE agent's requests go to a backend proxy route.
 * This spec covers the backend half of that AC: the proxy route exists,
 * reads the key ONLY from server-side env (never from the request), gates
 * /ask behind auth-shaped input validation, and degrades to a clear 503
 * when the server-side key is unset (rather than silently no-op-ing).
 */

import { BadGatewayException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { FeAgentController } from './fe-agent.controller';

function makeConfigService(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as any;
}

describe('FeAgentController — GET /fe-agent/status', () => {
  it('reports available=true when the server-side key is configured', () => {
    const controller = new FeAgentController(makeConfigService({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));
    expect(controller.status()).toEqual({ available: true });
  });

  it('reports available=false when unset — no key ever leaves the server to say otherwise', () => {
    const controller = new FeAgentController(makeConfigService({}));
    expect(controller.status()).toEqual({ available: false });
  });
});

describe('FeAgentController — POST /fe-agent/ask', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rejects a missing question with 400 before ever calling upstream', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const controller = new FeAgentController(makeConfigService({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));

    await expect(controller.ask({ question: '' } as any)).rejects.toThrow(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws 503 when ANTHROPIC_API_KEY is unset on the server (no silent no-op)', async () => {
    const controller = new FeAgentController(makeConfigService({}));
    await expect(controller.ask({ question: 'What is Sylphie doing?' })).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('calls the Anthropic Messages API server-side with the key in a header, never in the frontend payload', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Sylphie is idle.' }] }),
    });
    global.fetch = fetchSpy as any;

    const controller = new FeAgentController(makeConfigService({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));
    const result = await controller.ask({
      question: 'What is Sylphie doing?',
      telemetrySnapshot: 'pressure=0.4',
      history: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual({ response: 'Sylphie is idle.' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test-key');
    const requestBody = JSON.parse(init.body);
    expect(requestBody.messages.at(-1).content).toContain('What is Sylphie doing?');
  });

  it('surfaces an upstream failure as 502, not a swallowed error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'upstream broke' }) as any;
    const controller = new FeAgentController(makeConfigService({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }));

    await expect(controller.ask({ question: 'hi' })).rejects.toThrow(BadGatewayException);
  });
});
