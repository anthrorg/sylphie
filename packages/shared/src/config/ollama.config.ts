import { registerAs } from '@nestjs/config';

export const ollamaConfig = registerAs('ollama', () => ({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
}));
