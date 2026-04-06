import { registerAs } from '@nestjs/config';

export const ollamaConfig = registerAs('ollama', () => ({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  chatModel: process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b',
  chatTimeoutMs: parseInt(process.env.OLLAMA_CHAT_TIMEOUT_MS || '30000', 10),
  searxngUrl: process.env.SEARXNG_URL || 'http://localhost:8888',
}));
