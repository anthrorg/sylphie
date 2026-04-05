import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { WkgBootstrapService } from '../services/wkg-bootstrap.service';

@Controller('skills')
export class SkillsController {
  private readonly logger = new Logger(SkillsController.name);

  constructor(private readonly wkgBootstrap: WkgBootstrapService) {}

  @Post('reset')
  @HttpCode(200)
  async resetWkg(@Body() body: { confirm: boolean }) {
    if (!body.confirm) {
      return { success: false, message: 'Confirmation required' };
    }

    this.logger.warn('WKG reset requested by guardian');
    const result = await this.wkgBootstrap.resetAndBootstrap();

    return {
      success: true,
      operation: 'wkg-reset',
      nodes_deleted: result.nodesDeleted,
      edges_deleted: result.edgesDeleted,
      nodes_created: result.nodesCreated,
    };
  }
}
