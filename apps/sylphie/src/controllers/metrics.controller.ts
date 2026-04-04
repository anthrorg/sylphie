import { Controller, Get } from '@nestjs/common';

@Controller('metrics')
export class MetricsController {
  @Get('observatory/vocabulary-growth')
  vocabularyGrowth() {
    return { days: [] };
  }

  @Get('observatory/drive-evolution')
  driveEvolution() {
    return { sessions: [] };
  }

  @Get('observatory/action-diversity')
  actionDiversity() {
    return { sessions: [] };
  }

  @Get('observatory/developmental-stage')
  developmentalStage() {
    return {
      sessions: [],
      overall: { stage: 'pre-autonomy', type1Pct: 0 },
    };
  }

  @Get('observatory/session-comparison')
  sessionComparison() {
    return { sessions: [] };
  }

  @Get('observatory/comprehension-accuracy')
  comprehensionAccuracy() {
    return { sessions: [] };
  }

  @Get('observatory/phrase-recognition')
  phraseRecognition() {
    return {
      totalUtterances: 0,
      recognizedCount: 0,
      ratio: 0,
      byProvenance: {},
    };
  }

  @Get('health')
  health() {
    return { metrics: [] };
  }
}
