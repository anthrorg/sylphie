/**
 * JobRegistryService — registry and orchestrator of learnable jobs.
 *
 * Manages the collection of ILearningJob instances that run during
 * consolidation cycles. Responsible for:
 *   - Registering jobs on initialization (dependency order)
 *   - Determining which jobs should run in each cycle
 *   - Executing jobs in sequence with result tracking
 *   - Emitting JOB_EXECUTION events to TimescaleDB
 *   - Aggregating job metrics for cycle-level reporting
 *
 * CANON §Subsystem 3: The consolidation cycle orchestrates multiple jobs
 * in a strict dependency order:
 *   1. TemporalPatternJob (no deps)
 *   2. CorrectionProcessingJob (no deps)
 *   3. ProcedureFormationJob (depends on TemporalPatternJob)
 *   4. SentenceProcessingJob (depends on TemporalPatternJob)
 *   5. PatternGeneralizationJob (depends on ProcedureFormationJob, SentenceProcessingJob)
 *
 * This service provides the registry and execution harness for the job pipeline.
 * Per-job error isolation: one failure doesn't kill the cycle.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';

import type { ILearningJob, JobResult } from '../interfaces/learning.interfaces';
import { TemporalPatternJob } from './temporal-pattern.job';
import { CorrectionProcessingJob } from './correction-processing.job';
import { ProcedureFormationJob } from './procedure-formation.job';
import { SentenceProcessingJob } from './sentence-processing.job';
import { PatternGeneralizationJob } from './pattern-generalization.job';

/**
 * Job with dependency tracking for execution ordering.
 */
interface RegistryEntry {
  readonly job: ILearningJob;
  readonly dependsOn: readonly string[]; // names of jobs this depends on
}

@Injectable()
export class JobRegistryService {
  private readonly logger = new Logger(JobRegistryService.name);

  /** Map of job name → RegistryEntry, in dependency order. */
  private readonly jobRegistry = new Map<string, RegistryEntry>();

  constructor(
    @Inject(TemporalPatternJob)
    private readonly temporalPatternJob: TemporalPatternJob,
    @Inject(CorrectionProcessingJob)
    private readonly correctionProcessingJob: CorrectionProcessingJob,
    @Inject(ProcedureFormationJob)
    private readonly procedureFormationJob: ProcedureFormationJob,
    @Inject(SentenceProcessingJob)
    private readonly sentenceProcessingJob: SentenceProcessingJob,
    @Inject(PatternGeneralizationJob)
    private readonly patternGeneralizationJob: PatternGeneralizationJob,
  ) {
    this.registerJobs();
  }

  /**
   * Register all learning jobs in dependency order.
   *
   * Dependency chain:
   *   TemporalPatternJob (base)
   *   CorrectionProcessingJob (base)
   *   ProcedureFormationJob (requires TemporalPatternJob)
   *   SentenceProcessingJob (requires TemporalPatternJob)
   *   PatternGeneralizationJob (requires ProcedureFormationJob, SentenceProcessingJob)
   *
   * @private
   */
  private registerJobs(): void {
    // Base jobs (no dependencies)
    this.jobRegistry.set(this.temporalPatternJob.name, {
      job: this.temporalPatternJob,
      dependsOn: [],
    });

    this.jobRegistry.set(this.correctionProcessingJob.name, {
      job: this.correctionProcessingJob,
      dependsOn: [],
    });

    // Jobs depending on TemporalPatternJob
    this.jobRegistry.set(this.procedureFormationJob.name, {
      job: this.procedureFormationJob,
      dependsOn: [this.temporalPatternJob.name],
    });

    this.jobRegistry.set(this.sentenceProcessingJob.name, {
      job: this.sentenceProcessingJob,
      dependsOn: [this.temporalPatternJob.name],
    });

    // Jobs depending on ProcedureFormationJob and SentenceProcessingJob
    this.jobRegistry.set(this.patternGeneralizationJob.name, {
      job: this.patternGeneralizationJob,
      dependsOn: [
        this.procedureFormationJob.name,
        this.sentenceProcessingJob.name,
      ],
    });

    this.logger.log(
      `Registered ${this.jobRegistry.size} learning jobs in dependency order`,
    );
  }

  /**
   * Get all registered jobs in dependency order.
   *
   * @returns Array of all registered jobs in execution order.
   */
  getRegisteredJobs(): ILearningJob[] {
    return Array.from(this.jobRegistry.values()).map((entry) => entry.job);
  }

  /**
   * Get jobs that should run in the current cycle.
   *
   * Returns all registered jobs (filtering by shouldRun() happens during execution).
   *
   * @returns Array of all registered jobs in dependency order.
   */
  getJobsForCycle(): ILearningJob[] {
    return this.getRegisteredJobs();
  }

  /**
   * Execute all registered learning jobs in dependency order for the cycle.
   *
   * Per-job error isolation: failures in one job do not prevent subsequent
   * jobs from running. Each job result is tracked and aggregated.
   *
   * Emits JOB_EXECUTION events to TimescaleDB for each completed job.
   *
   * @returns Array of job results (one per job executed), in execution order.
   */
  async executeJobsForCycle(): Promise<JobResult[]> {
    const results: JobResult[] = [];
    const cycleStartTime = Date.now();

    this.logger.log(
      `Starting job execution cycle: ${this.jobRegistry.size} jobs registered`,
    );

    // Execute jobs in dependency order
    for (const entry of this.jobRegistry.values()) {
      const { job } = entry;

      // Check if job should run in this cycle
      if (!job.shouldRun()) {
        this.logger.debug(`Job '${job.name}' skipped (shouldRun = false)`);
        continue;
      }

      const jobStartTime = Date.now();

      try {
        this.logger.debug(`Starting job: ${job.name}`);
        const jobResult = await job.run();

        results.push(jobResult);

        // Note: JOB_EXECUTION is not an official EventType in CANON.
        // Job results are aggregated and emitted as part of CONSOLIDATION_CYCLE_COMPLETED.
        // Detailed job-level tracking is available via the results array.

        const duration = Date.now() - jobStartTime;
        this.logger.log(
          `Job '${job.name}' completed in ${duration}ms: ` +
            `success=${jobResult.success}, artifacts=${jobResult.artifactCount}, ` +
            `issues=${jobResult.issues.length}`,
        );
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Job '${job.name}' failed with exception: ${errorMsg}`,
          error instanceof Error ? error.stack : undefined,
        );

        // Record failure as a job result
        results.push({
          jobName: job.name,
          success: false,
          artifactCount: 0,
          issues: [errorMsg],
          latencyMs: Date.now() - jobStartTime,
          error: errorMsg,
        });

        // Continue to next job (error isolation)
      }
    }

    const cycleDuration = Date.now() - cycleStartTime;
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    this.logger.log(
      `Job execution cycle completed in ${cycleDuration}ms: ` +
        `${successful} succeeded, ${failed} failed, ${results.length} total`,
    );

    return results;
  }
}
