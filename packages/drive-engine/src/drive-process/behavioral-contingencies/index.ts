/**
 * Behavioral Contingencies Module
 *
 * CANON §A.14 Behavioral Contingencies:
 * Five reinforcement schedules that shape Sylphie's personality through
 * contingency-based learning. All are Type 1 (reflexive, no blocking calls).
 *
 * Exports:
 * - SatisfactionHabituation — diminishing returns on repeated success
 * - AnxietyAmplification — stress amplifies failure impact
 * - GuiltyRepair — relief through acknowledgment and behavioral change
 * - SocialCommentQuality — relief for prompt guardian responses
 * - CuriosityInformationGain — relief proportional to new learning
 * - ContingencyCoordinator — orchestrates all five
 */

export {
  SatisfactionHabituation,
  getOrCreateSatisfactionHabituation,
  type SatisfactionHabitationEffect,
} from './satisfaction-habituation';

export {
  AnxietyAmplification,
  getOrCreateAnxietyAmplification,
} from './anxiety-amplification';

export {
  GuiltyRepair,
  getOrCreateGuiltyRepair,
  type GuiltRepairEffect,
} from './guilt-repair';

export {
  SocialCommentQuality,
  getOrCreateSocialCommentQuality,
  type SocialCommentReliefResult,
  type SocialCommentQualityEffects,
} from './social-comment-quality';

export {
  CuriosityInformationGain,
  getOrCreateCuriosityInformationGain,
  type InformationGainMetrics,
  type CuriosityInformationGainEffect,
} from './curiosity-information-gain';

export {
  ContingencyCoordinator,
  getOrCreateContingencyCoordinator,
} from './contingency-coordinator';
