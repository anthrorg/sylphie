import { registerAs } from '@nestjs/config';

export const ollamaConfig = registerAs('ollama', () => ({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',

  // Tiered model configuration:
  //   quick  — Fast/small: trigger phrases, fact extraction, classification (local CPU)
  //   medium — Balanced: monologue classification, conversation responses (local CPU)
  //   deep   — Complex reasoning, debate, arbiter (DeepSeek API if configured, else local)
  modelQuick: process.env.OLLAMA_MODEL_QUICK || 'qwen2.5:3b',
  modelMedium: process.env.OLLAMA_MODEL_MEDIUM || process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b',
  modelDeep: process.env.OLLAMA_MODEL_DEEP || 'gpt-oss:20b',

  chatTimeoutMs: parseInt(process.env.OLLAMA_CHAT_TIMEOUT_MS || '30000', 10),
  searxngUrl: process.env.SEARXNG_URL || 'http://localhost:8888',

  // DeepSeek API. When DEEPSEEK_API_KEY is set, deep and medium tiers
  // route to DeepSeek instead of local Ollama.
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-reasoner',
  deepseekMediumModel: process.env.DEEPSEEK_MEDIUM_MODEL || '',
}));
