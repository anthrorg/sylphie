import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { WkgBootstrapService } from '../services/wkg-bootstrap.service';

@Controller('skills')
export class SkillsController {
  private readonly logger = new Logger(SkillsController.name);

  constructor(private readonly wkgBootstrap: WkgBootstrapService) {}

  @Post('reset')
  @HttpCode(200)
  async resetAll(@Body() body: { confirm: boolean }) {
    if (!body.confirm) {
      return { success: false, message: 'Confirmation required' };
    }

    this.logger.warn('Full system reset requested by guardian');
    const result = await this.wkgBootstrap.resetAndBootstrap();

    return {
      success: true,
      operation: 'full-reset',
      nodes_deleted: result.nodesDeleted,
      edges_deleted: result.edgesDeleted,
      nodes_created: result.nodesCreated,
    };
  }

  /**
   * WORLD-only reset: wipes the World Knowledge Graph and re-bootstraps.
   * Preserves SELF KG, OTHER KG, tensor pipeline, voice patterns, etc.
   * Resets has_learned so old events get reprocessed with the improved pipeline.
   */
  @Post('reset-world')
  @HttpCode(200)
  async resetWorld(@Body() body: { confirm: boolean }) {
    if (!body.confirm) {
      return { success: false, message: 'Confirmation required. Send { "confirm": true }' };
    }

    this.logger.warn('WORLD-only reset requested by guardian');
    const result = await this.wkgBootstrap.resetWorldOnly();

    return {
      success: true,
      operation: 'world-only-reset',
      nodes_deleted: result.nodesDeleted,
      edges_deleted: result.edgesDeleted,
      nodes_created: result.nodesCreated,
      events_queued_for_reprocessing: result.eventsReset,
      preserved: ['SELF KG', 'OTHER KG', 'learned_patterns', 'voice_patterns', 'sensory_ticks', 'PostgreSQL'],
    };
  }
}
