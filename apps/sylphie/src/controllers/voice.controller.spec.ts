/**
 * TK-79 — DEC-8: wire /transcribe to Deepgram REST; delete theater stub.
 *
 * AC1: POST /transcribe with real audio returns { text (non-empty), confidence>0 }
 * AC2: On failure, honest error thrown — NOT the fake { text:'', confidence:0 } 200.
 *
 * Tests run with Jest via: yarn workspace @sylphie/app test
 */

import { VoiceController } from './voice.controller';
import type { SttService } from '../services/stt.service';
import type { TtsService } from '../services/tts.service';
import { SttService as SttServiceClass, OneShot } from '../services/stt.service';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeSttStub(overrides?: Partial<Pick<SttService, 'available' | 'transcribeBuffer'>>): SttService {
  return {
    available: true,
    transcribeBuffer: jest.fn().mockResolvedValue({
      text: 'Hello world',
      confidence: 0.95,
      latencyMs: 120,
    } satisfies OneShot),
    createSession: jest.fn(),
    sendAudio: jest.fn(),
    closeSession: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    ...overrides,
  } as unknown as SttService;
}

function makeTtsStub(): TtsService {
  return { available: false } as unknown as TtsService;
}

function makeRequest(body: Buffer | undefined, contentType = 'audio/webm') {
  return { body, headers: { 'content-type': contentType } };
}

// ---------------------------------------------------------------------------
// VoiceController tests
// ---------------------------------------------------------------------------

describe('VoiceController.transcribe', () => {
  // AC1 — real audio ↦ real transcript
  it('AC1: returns non-empty text and confidence>0 from Deepgram REST', async () => {
    const stt = makeSttStub();
    const ctrl = new VoiceController(stt, makeTtsStub());

    const audio = Buffer.from('fake-audio-bytes');
    const result = await ctrl.transcribe(makeRequest(audio, 'audio/webm;codecs=opus') as any);

    // Deepgram REST is called with the cleaned mime type (codecs stripped)
    expect(stt.transcribeBuffer).toHaveBeenCalledWith(audio, 'audio/webm');
    expect(result.text).toBe('Hello world');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // AC2 — Deepgram REST failure → honest error thrown (not empty-200 returned)
  it('AC2: throws (does NOT return fake empty-200) when Deepgram REST fails', async () => {
    const stt = makeSttStub({
      transcribeBuffer: jest.fn().mockRejectedValue(new Error('Deepgram REST error 503')),
    });
    const ctrl = new VoiceController(stt, makeTtsStub());

    const req = makeRequest(Buffer.from('audio'), 'audio/webm');
    await expect(ctrl.transcribe(req as any)).rejects.toThrow();
    // Must be an exception, not a { text: '', confidence: 0 } shape
  });

  // AC2 — no audio body → honest error (not fake empty-200)
  it('AC2: throws when no audio body is present', async () => {
    const stt = makeSttStub();
    const ctrl = new VoiceController(stt, makeTtsStub());

    await expect(ctrl.transcribe(makeRequest(undefined) as any)).rejects.toThrow();
    // transcribeBuffer must not be called with nothing
    expect(stt.transcribeBuffer).not.toHaveBeenCalled();
  });

  // AC2 — empty buffer → honest error
  it('AC2: throws when audio buffer is empty', async () => {
    const stt = makeSttStub();
    const ctrl = new VoiceController(stt, makeTtsStub());

    await expect(ctrl.transcribe(makeRequest(Buffer.alloc(0)) as any)).rejects.toThrow();
    expect(stt.transcribeBuffer).not.toHaveBeenCalled();
  });

  // AC2 — STT unavailable → honest 503, not fake empty-200
  it('AC2: throws when DEEPGRAM_API_KEY is not configured', async () => {
    const stt = makeSttStub({ available: false });
    const ctrl = new VoiceController(stt, makeTtsStub());

    await expect(ctrl.transcribe(makeRequest(Buffer.from('audio')) as any)).rejects.toThrow();
    expect(stt.transcribeBuffer).not.toHaveBeenCalled();
  });

  // Codec params stripped from Content-Type before forwarding to Deepgram
  it('strips codec params from Content-Type before forwarding to Deepgram', async () => {
    const stt = makeSttStub();
    const ctrl = new VoiceController(stt, makeTtsStub());

    const audio = Buffer.from('audio-data');
    await ctrl.transcribe(makeRequest(audio, 'audio/webm;codecs=opus') as any);

    expect(stt.transcribeBuffer).toHaveBeenCalledWith(audio, 'audio/webm');
  });

  // Verify the theater stub is gone — method is now async and calls the service
  it('the stub { text:"", confidence:0 } response is gone — method delegates to SttService', async () => {
    const stt = makeSttStub();
    const ctrl = new VoiceController(stt, makeTtsStub());

    await ctrl.transcribe(makeRequest(Buffer.from('audio')) as any);

    // If the stub were still there, transcribeBuffer would never be called
    expect(stt.transcribeBuffer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SttService.transcribeBuffer — unit tests (Deepgram REST path)
// ---------------------------------------------------------------------------

function makeSttServiceInstance(): SttServiceClass {
  const configStub = { get: jest.fn().mockReturnValue('test-api-key') };
  const svc = new (SttServiceClass as any)(configStub) as SttServiceClass;
  // Bypass onModuleInit — set key directly
  (svc as any).apiKey = 'test-key';
  return svc;
}

describe('SttService.transcribeBuffer', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('AC1: calls Deepgram REST and returns non-empty text with confidence>0', async () => {
    const deepgramResponse = {
      results: {
        channels: [{ alternatives: [{ transcript: 'hello there', confidence: 0.87 }] }],
      },
    };
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => deepgramResponse,
    } as any);

    const svc = makeSttServiceInstance();
    const result: OneShot = await svc.transcribeBuffer(Buffer.from('audio'), 'audio/webm');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api.deepgram.com/v1/listen'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Token test-key' }),
      }),
    );
    expect(result.text).toBe('hello there');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.confidence).toBe(0.87);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('AC2: throws (honest error) on Deepgram REST non-2xx response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);

    const svc = makeSttServiceInstance();

    await expect(svc.transcribeBuffer(Buffer.from('audio'), 'audio/webm')).rejects.toThrow(
      'Deepgram REST error 401',
    );
  });

  it('AC2: throws when API key is missing (never calls fetch)', async () => {
    const svc = makeSttServiceInstance();
    (svc as any).apiKey = ''; // clear the key

    await expect(svc.transcribeBuffer(Buffer.from('audio'), 'audio/webm')).rejects.toThrow(
      'STT unavailable',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AC2: propagates network errors (fetch rejection)', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));

    const svc = makeSttServiceInstance();

    await expect(svc.transcribeBuffer(Buffer.from('audio'), 'audio/webm')).rejects.toThrow(
      'network error',
    );
  });

  it('sends the audio bytes as the request body (same content as input buffer)', async () => {
    const inputBuffer = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // WebM magic bytes
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: 'ok', confidence: 0.9 }] }] },
      }),
    } as any);

    const svc = makeSttServiceInstance();
    await svc.transcribeBuffer(inputBuffer, 'audio/webm');

    const fetchCall = fetchSpy.mock.calls[0];
    // Body is converted to ArrayBuffer for BodyInit compatibility; verify content matches.
    const sentBody: ArrayBuffer = fetchCall[1].body;
    expect(sentBody).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(sentBody)).toEqual(new Uint8Array(inputBuffer));
  });
});
