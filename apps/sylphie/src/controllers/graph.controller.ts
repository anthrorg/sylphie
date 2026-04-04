import { Controller, Get } from '@nestjs/common';

@Controller('graph')
export class GraphController {
  @Get('snapshot')
  getSnapshot() {
    return { nodes: [], edges: [] };
  }
}
