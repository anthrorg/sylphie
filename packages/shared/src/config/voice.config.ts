import { registerAs } from '@nestjs/config';

export const voiceConfig = registerAs('voice', () => ({
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  elevenlabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
}));
