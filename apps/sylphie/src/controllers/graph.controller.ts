import { Controller, Get, Logger } from '@nestjs/common';
import { WkgQueryService, GraphSnapshotDto } from '../services/wkg-query.service';

@Controller('graph')
export class GraphController {
  private readonly logger = new Logger(GraphController.name);

  constructor(private readonly wkg: WkgQueryService) {}

  @Get('snapshot')
  async getSnapshot(): Promise<GraphSnapshotDto> {
    return this.wkg.getSnapshot();
  }
}
