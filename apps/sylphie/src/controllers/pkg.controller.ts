import { Controller, Get, Param, Query, Logger } from '@nestjs/common';
import { PkgQueryService } from '../services/pkg-query.service';

@Controller('graph/pkg')
export class PkgController {
  private readonly logger = new Logger(PkgController.name);

  constructor(private readonly pkg: PkgQueryService) {}

  @Get('search')
  async search(
    @Query('pattern') pattern: string,
    @Query('fileFilter') fileFilter?: string,
    @Query('limit') limitStr = '20',
  ) {
    if (!pattern) return [];
    const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 20));
    return this.pkg.search(pattern, fileFilter || undefined, limit);
  }

  @Get('function/:name')
  async getFunctionDetail(
    @Param('name') name: string,
    @Query('filePath') filePath?: string,
  ) {
    return this.pkg.getFunctionDetail(name, filePath || undefined);
  }

  @Get('dataflow/:name')
  async getDataFlow(
    @Param('name') name: string,
    @Query('direction') direction: 'upstream' | 'downstream' | 'both' = 'both',
    @Query('depth') depthStr = '3',
  ) {
    const depth = Math.min(6, Math.max(1, parseInt(depthStr, 10) || 3));
    return this.pkg.getDataFlow(name, direction, depth);
  }
}
