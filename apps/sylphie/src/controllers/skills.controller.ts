import { Controller, Get, Post, Delete, Param, Body, HttpCode } from '@nestjs/common';

@Controller('skills')
export class SkillsController {
  @Get()
  listSkills() {
    return { skills: [], total: 0, activeCount: 0, type1Count: 0 };
  }

  @Post('upload')
  @HttpCode(201)
  uploadSkill(@Body() body: { label: string; type: string; properties: Record<string, unknown> }) {
    return {
      skill: {
        id: 'stub',
        label: body.label,
        type: body.type,
        confidence: 0,
        provenance: 'GUARDIAN',
        useCount: 0,
        predictionMae: null,
        isType1: false,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        deactivated: false,
      },
      enforcedProvenance: 'GUARDIAN',
      enforcedConfidence: 0,
      relationshipsCreated: 0,
    };
  }

  @Delete(':id')
  deactivateSkill(@Param('id') _id: string) {
    return { message: 'not implemented' };
  }

  @Post('reset')
  resetSkills(@Body() _body: { scope: string; confirm: boolean }) {
    return { success: true, operation: 'reset', nodes_deleted: 0, edges_deleted: 0 };
  }
}
