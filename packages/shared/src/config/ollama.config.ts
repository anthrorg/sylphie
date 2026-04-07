import { registerAs } from '@nestjs/config';

export const ollamaConfig = registerAs('ollama', () => ({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',

  // Tiered model configuration. Each tier maps to a different Ollama model
  // optimized for different task complexities:
  //   quick  — Fast/small: trigger phrases, fact extraction, classification
  //   medium — Balanced: standard deliberation, conversation responses
  //   deep   — Largest: complex reasoning, planning, multi-step debate
  modelQuick: process.env.OLLAMA_MODEL_QUICK || 'qwen2.5:3b',
  modelMedium: process.env.OLLAMA_MODEL_MEDIUM || process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b',
  modelDeep: process.env.OLLAMA_MODEL_DEEP || 'gpt-oss:20b',

  chatTimeoutMs: parseInt(process.env.OLLAMA_CHAT_TIMEOUT_MS || '30000', 10),
  searxngUrl: process.env.SEARXNG_URL || 'http://localhost:8888',
}));
