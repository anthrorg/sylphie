/**
 * @sylphie/learning — Public API barrel export.
 *
 * Only three things are exported:
 *   1. LearningModule — the NestJS module to import in AppModule.
 *   2. LEARNING_SERVICE — the DI token to inject ILearningService.
 *   3. ILearningService — the interface (type-only) for type-safe injection.
 *
 * All pipeline step tokens, concrete service classes, and internal interfaces
 * are intentionally NOT exported. They are implementation details of the
 * Learning subsystem and must not be imported by other modules.
 */

export { LearningModule } from './learning.module';
export { LEARNING_SERVICE } from './learning.tokens';
export type { ILearningService, MaintenanceCycleResult, ReflectionResult, SynthesisCycleResult } from './interfaces/learning.interfaces';
