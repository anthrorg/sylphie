import { Controller, Get, Param, Query, Logger, BadRequestException } from '@nestjs/common';
import { WkgQueryService, GraphSnapshotDto, SearchNodeResult, NeighborhoodDto } from '../services/wkg-query.service';

@Controller('graph')
export class GraphController {
  private readonly logger = new Logger(GraphController.name);

  constructor(private readonly wkg: WkgQueryService) {}

  // ── Legacy full-snapshot endpoints (backward compatible) ────────────

  @Get('snapshot')
  async getSnapshot(): Promise<GraphSnapshotDto> {
    return this.wkg.getSnapshot();
  }

  @Get('okg')
  async getOkgSnapshot(): Promise<GraphSnapshotDto> {
    return this.wkg.getOkgSnapshot();
  }

  @Get('skg')
  async getSkgSnapshot(): Promise<GraphSnapshotDto> {
    return this.wkg.getSkgSnapshot();
  }

  @Get('pkg')
  async getPkgSnapshot(): Promise<GraphSnapshotDto> {
    return this.wkg.getPkgSnapshot();
  }

  // ── Explorer view — search + neighborhood ───────────────────────────
  // These MUST appear before :instance/* wildcard routes.

  @Get('wkg/search')
  async searchNodes(
    @Query('q') query: string,
    @Query('limit') limitStr = '10',
  ): Promise<SearchNodeResult[]> {
    if (!query || query.trim().length < 1) {
      throw new BadRequestException('Query parameter "q" is required (min 1 character)');
    }
    const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || 10));
    return this.wkg.searchNodes(query.trim(), limit);
  }

  @Get('wkg/neighborhood')
  async getNeighborhood(
    @Query('nodeId') nodeId: string,
    @Query('hops') hopsStr = '2',
  ): Promise<NeighborhoodDto> {
    if (!nodeId || nodeId.trim().length < 1) {
      throw new BadRequestException('Query parameter "nodeId" is required');
    }
    const hops = Math.max(1, Math.min(3, parseInt(hopsStr, 10) || 2));
    return this.wkg.getNeighborhood(nodeId.trim(), hops);
  }

  // ── Paginated endpoints for progressive loading ─────────────────────

  @Get(':instance/count')
  async getCount(@Param('instance') instance: string) {
    const resolved = this.wkg.resolveInstance(instance);
    if (!resolved) throw new BadRequestException(`Unknown graph instance: ${instance}`);
    return this.wkg.getCount(resolved);
  }

  @Get(':instance/nodes')
  async getNodes(
    @Param('instance') instance: string,
    @Query('skip') skipStr = '0',
    @Query('limit') limitStr = '500',
  ) {
    const resolved = this.wkg.resolveInstance(instance);
    if (!resolved) throw new BadRequestException(`Unknown graph instance: ${instance}`);
    const skip = Math.max(0, parseInt(skipStr, 10) || 0);
    const limit = Math.min(2000, Math.max(1, parseInt(limitStr, 10) || 500));
    return this.wkg.getNodePage(resolved, skip, limit);
  }

  @Get(':instance/edges')
  async getEdges(
    @Param('instance') instance: string,
    @Query('skip') skipStr = '0',
    @Query('limit') limitStr = '1000',
  ) {
    const resolved = this.wkg.resolveInstance(instance);
    if (!resolved) throw new BadRequestException(`Unknown graph instance: ${instance}`);
    const skip = Math.max(0, parseInt(skipStr, 10) || 0);
    const limit = Math.min(5000, Math.max(1, parseInt(limitStr, 10) || 1000));
    return this.wkg.getEdgePage(resolved, skip, limit);
  }
}
