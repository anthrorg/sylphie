import {
  Controller,
  Get,
  Query,
  Param,
  Inject,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { SylphieEvent } from '../../shared/types/event.types';
import type { DriveSnapshot } from '../../shared/types/drive.types';
import type { DriveSnapshotDto, DriveValueDto } from '../dtos/drive.dto';
import type {
  ConversationMessage,
  ConversationHistoryResponse,
} from '../dtos/conversation.dto';
import { validatePaginationParams } from '../utils/paginator';

/**
 * ConversationController — REST API for conversation history and transcripts.
 *
 * Exposes read-only endpoints for querying communication events from TimescaleDB.
 * Consumes IEventService for all event retrieval.
 *
 * CANON §Communication: Used by the frontend to display conversation context
 * and by Sylphie to ground response generation in prior turns.
 */
@Controller('api/conversation')
export class ConversationController {
  constructor(
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * GET /api/conversation/history?from=&to=&limit=50&offset=0
   *
   * Retrieve conversation history with Guardian and Sylphie turns.
   * Includes drive snapshots and theater validation results.
   *
   * Query parameters:
   * - from (optional): ISO 8601 timestamp for start of time window
   * - to (optional): ISO 8601 timestamp for end of time window
   * - limit (optional, default 50): Number of messages to return
   * - offset (optional, default 0): Pagination offset
   *
   * Returns ConversationHistoryResponse with paginated messages in chronological order.
   */
  @Get('history')
  async getHistory(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ): Promise<ConversationHistoryResponse> {
    try {
      // Parse pagination parameters
      const { offset, limit } = validatePaginationParams(offsetStr, limitStr);

      // Parse time window
      let startTime: Date | undefined;
      let endTime: Date | undefined;

      if (fromStr) {
        const parsed = new Date(fromStr);
        if (!isNaN(parsed.getTime())) {
          startTime = parsed;
        }
      }

      if (toStr) {
        const parsed = new Date(toStr);
        if (!isNaN(parsed.getTime())) {
          endTime = parsed;
        }
      }

      // Query conversation events
      const communicationEventTypes: Array<
        | 'INPUT_RECEIVED'
        | 'INPUT_PARSED'
        | 'RESPONSE_GENERATED'
        | 'RESPONSE_DELIVERED'
        | 'GUARDIAN_CORRECTION'
        | 'GUARDIAN_CONFIRMATION'
      > = [
        'INPUT_RECEIVED',
        'INPUT_PARSED',
        'RESPONSE_GENERATED',
        'RESPONSE_DELIVERED',
        'GUARDIAN_CORRECTION',
        'GUARDIAN_CONFIRMATION',
      ];

      const events = await this.eventService.query({
        types: communicationEventTypes,
        startTime,
        endTime,
        limit: offset + limit + 100, // Fetch extra to allow grouping
      });

      // Convert events to messages
      const messages = this.eventsToMessages(events);

      // Apply pagination
      const paginatedMessages = messages.slice(offset, offset + limit);

      const response: ConversationHistoryResponse = {
        messages: paginatedMessages,
        total: messages.length,
        offset,
        limit,
      };

      return response;
    } catch (error) {
      console.error('ConversationController.getHistory failed:', error);
      throw new InternalServerErrorException('Failed to retrieve conversation history');
    }
  }

  /**
   * GET /api/conversation/messages/:conversationId
   *
   * Retrieve all messages belonging to a specific conversation session.
   * Uses correlationId to group related events.
   *
   * Path parameters:
   * - conversationId: Session ID or correlation ID to group messages
   *
   * Returns ConversationHistoryResponse with all messages for the conversation.
   */
  @Get('messages/:conversationId')
  async getConversationMessages(
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationHistoryResponse> {
    try {
      // Query events matching the conversation ID
      const communicationEventTypes: Array<
        | 'INPUT_RECEIVED'
        | 'INPUT_PARSED'
        | 'RESPONSE_GENERATED'
        | 'RESPONSE_DELIVERED'
        | 'GUARDIAN_CORRECTION'
        | 'GUARDIAN_CONFIRMATION'
      > = [
        'INPUT_RECEIVED',
        'INPUT_PARSED',
        'RESPONSE_GENERATED',
        'RESPONSE_DELIVERED',
        'GUARDIAN_CORRECTION',
        'GUARDIAN_CONFIRMATION',
      ];

      // Try both sessionId and correlationId
      let events: readonly SylphieEvent[] = [];

      // First try sessionId
      events = await this.eventService.query({
        types: communicationEventTypes,
        sessionId: conversationId,
        limit: 1000,
      });

      // If no results, try correlationId
      if (events.length === 0) {
        events = await this.eventService.query({
          types: communicationEventTypes,
          correlationId: conversationId,
          limit: 1000,
        });
      }

      // Convert to messages
      const messages = this.eventsToMessages(events);

      const response: ConversationHistoryResponse = {
        messages,
        total: messages.length,
        offset: 0,
        limit: messages.length,
      };

      return response;
    } catch (error) {
      console.error('ConversationController.getConversationMessages failed:', error);
      throw new InternalServerErrorException('Failed to retrieve conversation messages');
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private eventsToMessages(events: readonly SylphieEvent[]): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // Group events by correlation ID to construct coherent messages
    const eventsByCorrelation = new Map<string, SylphieEvent[]>();

    for (const event of events) {
      const corrId = event.correlationId ?? 'default';
      if (!eventsByCorrelation.has(corrId)) {
        eventsByCorrelation.set(corrId, []);
      }
      eventsByCorrelation.get(corrId)!.push(event);
    }

    // Process each correlation group to extract messages
    for (const [, groupEvents] of eventsByCorrelation) {
      // Sort by timestamp
      const sorted = [...groupEvents].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      // Create message entries
      for (const event of sorted) {
        const eventType = event.type;
        const payload = (event as any).payload ?? {};

        if (eventType === 'INPUT_RECEIVED') {
          messages.push({
            id: event.id,
            text: payload.inputText ?? '(empty input)',
            direction: 'incoming',
            timestamp: event.timestamp.getTime(),
            guardianFeedbackType: 'none',
          });
        } else if (eventType === 'INPUT_PARSED') {
          // Skip parsing events; they don't represent user-visible messages
        } else if (eventType === 'RESPONSE_GENERATED') {
          const theaterResult = payload.theaterCheckResult ?? null;

          messages.push({
            id: event.id,
            text: payload.responseText ?? '(empty response)',
            direction: 'outgoing',
            timestamp: event.timestamp.getTime(),
            driveSnapshot: this.convertDriveSnapshotToDto(event.driveSnapshot),
            theaterCheck: theaterResult
              ? {
                  passed: theaterResult.passed ?? false,
                  violations: theaterResult.violations ?? [],
                  overallCorrelation: theaterResult.overallCorrelation ?? 0.0,
                }
              : undefined,
            type1OrType2: payload.type1OrType2 ?? undefined,
          });
        } else if (eventType === 'RESPONSE_DELIVERED') {
          // Note final delivery; typically combines with RESPONSE_GENERATED
        } else if (eventType === 'GUARDIAN_CORRECTION') {
          messages.push({
            id: event.id,
            text: payload.feedbackText ?? '(correction)',
            direction: 'incoming',
            timestamp: event.timestamp.getTime(),
            guardianFeedbackType: 'correction',
          });
        } else if (eventType === 'GUARDIAN_CONFIRMATION') {
          messages.push({
            id: event.id,
            text: payload.feedbackText ?? '(confirmation)',
            direction: 'incoming',
            timestamp: event.timestamp.getTime(),
            guardianFeedbackType: 'confirmation',
          });
        }
      }
    }

    // Sort all messages by timestamp for chronological order
    messages.sort((a, b) => a.timestamp - b.timestamp);

    return messages;
  }

  private convertDriveSnapshotToDto(snapshot: DriveSnapshot): DriveSnapshotDto {
    // Map PressureVector keys to DriveValueDto array
    const driveEntries = Object.entries(snapshot.pressureVector) as Array<
      [string, number]
    >;
    const drives: DriveValueDto[] = driveEntries.map(([name, value]) => ({
      name,
      value,
    }));

    return {
      drives: drives as readonly DriveValueDto[],
      totalPressure: snapshot.totalPressure,
      tickNumber: snapshot.tickNumber,
      timestamp: snapshot.timestamp instanceof Date ? snapshot.timestamp.getTime() : Number(snapshot.timestamp),
    };
  }
}
