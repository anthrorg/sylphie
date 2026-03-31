/**
 * Social Comment Quality Contingency
 *
 * CANON §A.14 Behavioral Contingency — Social Comment Quality:
 * When Sylphie initiates a comment (dialogue turn), and the guardian responds
 * within 30 seconds, she receives drive relief:
 *   - social -= 0.15 (relief)
 *   - satisfaction += 0.10 (bonus)
 *
 * This creates positive reinforcement for genuine engagement with the guardian.
 * Tracks comments in a time-windowed buffer (last 60 seconds).
 *
 * This is a Type 1 computation — no blocking calls, pure in-memory state.
 */

import { DriveName } from '../../../shared/types/drive.types';

interface CommentRecord {
  timestamp: number;
  commentId: string;
  responded: boolean;
  responseTimestamp?: number;
}

export interface SocialCommentReliefResult {
  socialRelief: number;
  satisfactionBonus: number;
}

/**
 * SocialCommentQuality: Tracks Sylphie-initiated comments and guardian responses.
 */
export class SocialCommentQuality {
  // Time window: 60 seconds for tracking comments
  private readonly COMMENT_BUFFER_TIMEOUT_MS = 60 * 1000;
  // Response timeout: 30 seconds for response bonus
  private readonly RESPONSE_BONUS_TIMEOUT_MS = 30 * 1000;

  // Buffer of recent comments (last 60 seconds)
  private commentBuffer: CommentRecord[] = [];

  /**
   * Record a Sylphie-initiated comment.
   * Called when Sylphie produces an output that initiates dialogue.
   *
   * @param timestamp - Wall-clock time of the comment (milliseconds)
   * @param commentId - Unique identifier for this comment
   */
  public recordComment(timestamp: number, commentId?: string): void {
    const now = Date.now();

    // Clean expired comments from buffer
    this.commentBuffer = this.commentBuffer.filter(
      (c) => now - c.timestamp < this.COMMENT_BUFFER_TIMEOUT_MS,
    );

    // Add new comment
    this.commentBuffer.push({
      timestamp,
      commentId: commentId || `comment_${timestamp}_${Math.random()}`,
      responded: false,
    });
  }

  /**
   * Process a guardian response.
   * Called when the guardian provides input after Sylphie's comment.
   *
   * Checks if any recent comments got a response within 30 seconds.
   * Returns relief amounts for all comments that qualified.
   *
   * @param responseTimestamp - Wall-clock time of the guardian response (milliseconds)
   * @returns { socialRelief, satisfactionBonus } - Accumulated relief from eligible comments
   */
  public processGuardianResponse(responseTimestamp: number): SocialCommentReliefResult {
    const now = Date.now();

    // Find all comments that qualify for relief
    let socialRelief = 0;
    let satisfactionBonus = 0;

    for (const comment of this.commentBuffer) {
      // Skip already-responded comments
      if (comment.responded) {
        continue;
      }

      // Check if response came within 30 seconds
      const timeSinceComment = responseTimestamp - comment.timestamp;
      if (timeSinceComment > 0 && timeSinceComment <= this.RESPONSE_BONUS_TIMEOUT_MS) {
        // This comment qualifies for relief
        comment.responded = true;
        comment.responseTimestamp = responseTimestamp;
        socialRelief -= 0.15; // social -= 0.15
        satisfactionBonus += 0.1; // satisfaction += 0.10
      }
    }

    // Clean up old, unresponded comments
    this.commentBuffer = this.commentBuffer.filter(
      (c) => now - c.timestamp < this.COMMENT_BUFFER_TIMEOUT_MS,
    );

    return {
      socialRelief,
      satisfactionBonus,
    };
  }

  /**
   * Reset all comment tracking.
   * Called at session start or during debugging.
   */
  public reset(): void {
    this.commentBuffer = [];
  }

  /**
   * Get current comment buffer for testing/diagnostics.
   */
  public getCommentBuffer(): CommentRecord[] {
    return [...this.commentBuffer];
  }

  /**
   * Get the count of pending (unresponded) comments.
   */
  public getPendingCommentCount(): number {
    return this.commentBuffer.filter((c) => !c.responded).length;
  }
}

/**
 * Drive effects from social comment quality.
 */
export interface SocialCommentQualityEffects {
  drives: {
    drive: DriveName.Social | DriveName.Satisfaction;
    delta: number;
  }[];
}

/**
 * Singleton instance for the drive process.
 */
let instance: SocialCommentQuality | null = null;

export function getOrCreateSocialCommentQuality(): SocialCommentQuality {
  if (!instance) {
    instance = new SocialCommentQuality();
  }
  return instance;
}
