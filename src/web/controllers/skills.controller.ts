/**
 * SkillsController — guardian-facing REST API for WKG Procedure node management.
 *
 * Exposes CRUD operations for Procedure nodes plus a guardian concept upload
 * endpoint. Skills are Sylphie's learned procedures — the observable record of
 * what she knows how to do and how reliably she can do it.
 *
 * CANON §Dual-Process Cognition: isType1 in SkillDto reflects the graduation
 * condition (confidence > 0.80 AND predictionMae < 0.10). The dashboard uses
 * this to show the Type 1/Type 2 ratio shifting over time.
 *
 * CANON §Provenance Is Sacred (Standard 7): All responses include provenance.
 * Upload endpoint forces provenance = 'GUARDIAN' regardless of client input.
 *
 * CANON §Confidence Ceiling (Standard 3): Upload endpoint forces confidence =
 * 0.60 regardless of client input. Confidence can only grow past the ceiling
 * after successful retrieval-and-use events.
 *
 * CANON §No Self-Modification (Standard 6): This endpoint is guardian-only.
 * Sylphie's subsystems never call these mutation endpoints.
 *
 * CANON §A.13 amendment: Guardian-initiated concept upload is explicitly
 * permitted with GUARDIAN provenance at 0.60 base confidence.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  Inject,
} from '@nestjs/common';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { KnowledgeNode } from '../../shared/types/knowledge.types';
import { computeConfidence, CONFIDENCE_THRESHOLDS } from '../../shared/types/confidence.types';
import type {
  SkillDto,
  ConceptUploadRequest,
  SkillListResponse,
  SkillUploadResponse,
} from '../dtos/skills.dto';

// ---------------------------------------------------------------------------
// Valid WKG node types for guardian upload
// ---------------------------------------------------------------------------

/**
 * Permitted primary labels for guardian concept uploads.
 *
 * These are the instance-level node types defined in the WKG schema. The
 * upload endpoint validates against this list to prevent injection of
 * schema-level or meta-schema-level nodes via the guardian pathway.
 *
 * CANON §WKG: Instance-level nodes represent individual entities, concepts,
 * procedures, and utterances. Schema and meta-schema nodes are managed through
 * the Learning subsystem's consolidation cycle, not through direct upload.
 */
const VALID_WKG_NODE_TYPES = new Set([
  'Concept',
  'Entity',
  'Procedure',
  'Action',
  'Utterance',
  'Pattern',
  'Event',
  'Person',
  'Location',
  'Attribute',
] as const);

// ---------------------------------------------------------------------------
// GUARDIAN confidence constant (CANON §Confidence Ceiling, Standard 3)
// ---------------------------------------------------------------------------

/** Base confidence for all guardian-uploaded concepts. Cannot be overridden by client. */
const GUARDIAN_BASE_CONFIDENCE = 0.60 as const;

@Controller('api/skills')
export class SkillsController {
  private readonly logger = new Logger(SkillsController.name);

  constructor(
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
  ) {}

  // =========================================================================
  // GET /api/skills — list all Procedure nodes
  // =========================================================================

  /**
   * GET /api/skills
   *
   * List all Procedure nodes from the World Knowledge Graph, ordered by
   * confidence descending. Includes both active and deactivated procedures.
   *
   * CANON §The World Knowledge Graph Is the Brain: All skill knowledge lives
   * in the WKG. This endpoint surfaces that knowledge for guardian inspection.
   *
   * @returns SkillListResponse with all procedures, active count, and Type 1 count.
   */
  @Get()
  async listSkills(): Promise<SkillListResponse> {
    try {
      const nodes = await this.wkgService.queryProcedures();

      const skills = nodes.map((node) => this.toSkillDto(node));

      const activeCount = skills.filter((s) => !s.deactivated).length;
      const type1Count = skills.filter((s) => s.isType1).length;

      return {
        skills,
        total: skills.length,
        activeCount,
        type1Count,
      };
    } catch (error) {
      this.logger.error(
        `listSkills failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to list skills from WKG');
    }
  }

  // =========================================================================
  // GET /api/skills/:id — get single procedure with performance history
  // =========================================================================

  /**
   * GET /api/skills/:id
   *
   * Retrieve a single Procedure node by its Neo4j element ID. Returns the node
   * as a SkillDto regardless of whether it is deactivated — the guardian
   * dashboard needs to inspect deactivated skills too.
   *
   * Returns 404 if no node with the given ID exists in the WKG.
   *
   * @param id Neo4j element ID of the Procedure node.
   * @returns SkillDto for the requested node.
   * @throws NotFoundException (404) if the node does not exist.
   */
  @Get(':id')
  async getSkill(@Param('id') id: string): Promise<SkillDto> {
    if (!id || id.trim().length === 0) {
      throw new BadRequestException('Skill ID is required');
    }

    let node: KnowledgeNode | null;

    try {
      node = await this.wkgService.findNode(id);
    } catch (error) {
      this.logger.error(
        `getSkill: findNode failed for id="${id}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to retrieve skill from WKG');
    }

    if (node === null) {
      throw new NotFoundException(`Skill with id "${id}" not found in WKG`);
    }

    return this.toSkillDto(node);
  }

  // =========================================================================
  // DELETE /api/skills/:id — soft-delete by lowering confidence
  // =========================================================================

  /**
   * DELETE /api/skills/:id
   *
   * Soft-delete a Procedure node. Sets confidence to 0.0 and marks the node
   * with `deactivated: true`. The node is NOT removed from Neo4j — it remains
   * for audit and provenance tracing.
   *
   * After deactivation, the node will not appear in normal retrieval queries
   * (which apply the 0.50 confidence threshold) but remains visible in the
   * guardian dashboard via GET /api/skills (which returns all nodes including
   * deactivated ones).
   *
   * CANON §Provenance Is Sacred: The node's provenance and history are
   * preserved. Deactivation is a confidence operation, not a deletion.
   *
   * Returns 404 if the node does not exist.
   *
   * @param id Neo4j element ID of the Procedure node to deactivate.
   * @returns SkillDto of the deactivated node (confidence = 0.0, deactivated = true).
   * @throws NotFoundException (404) if the node does not exist.
   */
  @Delete(':id')
  async deleteSkill(@Param('id') id: string): Promise<SkillDto> {
    if (!id || id.trim().length === 0) {
      throw new BadRequestException('Skill ID is required');
    }

    let node: KnowledgeNode | null;

    try {
      node = await this.wkgService.deactivateNode(id);
    } catch (error) {
      this.logger.error(
        `deleteSkill: deactivateNode failed for id="${id}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to deactivate skill in WKG');
    }

    if (node === null) {
      throw new NotFoundException(`Skill with id "${id}" not found in WKG`);
    }

    return this.toSkillDto(node);
  }

  // =========================================================================
  // POST /api/skills/upload — guardian concept upload
  // =========================================================================

  /**
   * POST /api/skills/upload
   *
   * Upload a guardian-defined concept into the World Knowledge Graph.
   * Creates a new WKG node with:
   *   - provenance = 'GUARDIAN' (forced, regardless of client input)
   *   - confidence = 0.60 (forced per CANON §Confidence Ceiling, Standard 3)
   *   - created_by = 'guardian_upload' (added to properties bag)
   *
   * Optionally creates relationships to existing WKG nodes. Each requested
   * relationship also carries 'GUARDIAN' provenance.
   *
   * Validation:
   *   - label must be non-empty
   *   - type must be one of the permitted WKG node types (VALID_WKG_NODE_TYPES)
   *   - confidence is forced to 0.60 regardless of any client-supplied value
   *   - provenance is forced to 'GUARDIAN' regardless of any client-supplied value
   *
   * CANON §A.13 amendment: Guardian-initiated concept upload is explicitly
   * permitted with GUARDIAN provenance at 0.60 base confidence.
   *
   * CANON §No Self-Modification (Standard 6): This endpoint is guardian-only.
   * Sylphie's subsystems do not have access to this write pathway.
   *
   * @param body ConceptUploadRequest with label, type, properties, and optional relationships.
   * @returns SkillUploadResponse confirming the created node and enforced values.
   * @throws BadRequestException (400) if validation fails.
   */
  @Post('upload')
  async uploadConcept(
    @Body() body: ConceptUploadRequest,
  ): Promise<SkillUploadResponse> {
    // Validate label
    if (!body.label || body.label.trim().length === 0) {
      throw new BadRequestException('label must be non-empty');
    }

    // Validate type against permitted WKG node labels
    if (!body.type || !VALID_WKG_NODE_TYPES.has(body.type as typeof VALID_WKG_NODE_TYPES extends Set<infer T> ? T : never)) {
      throw new BadRequestException(
        `type must be one of: ${Array.from(VALID_WKG_NODE_TYPES).join(', ')}. Received: "${body.type ?? ''}"`,
      );
    }

    // Validate properties is an object (may be empty)
    if (body.properties !== null && typeof body.properties !== 'object') {
      throw new BadRequestException('properties must be an object');
    }

    // Build enriched properties — add created_by tag and the display label
    const enrichedProperties: Record<string, unknown> = {
      ...(body.properties ?? {}),
      name: body.label.trim(),
      created_by: 'guardian_upload',
    };

    let createdNode: KnowledgeNode;

    try {
      const upsertResult = await this.wkgService.upsertNode({
        labels: [body.type],
        nodeLevel: 'INSTANCE',
        provenance: 'GUARDIAN',
        // Force 0.60 regardless of anything the client may have sent.
        // CANON §Confidence Ceiling (Standard 3): no node exceeds 0.60 without
        // a successful retrieval-and-use event.
        initialConfidence: GUARDIAN_BASE_CONFIDENCE,
        properties: enrichedProperties,
      });

      if (upsertResult.type === 'contradiction') {
        // A conceptually conflicting node already exists. Surface the conflict
        // to the guardian rather than silently overwriting existing knowledge.
        this.logger.warn(
          `uploadConcept: contradiction detected for label="${body.label}", type="${body.type}"`,
        );
        // Return the incoming node's attempted state as an error context.
        throw new BadRequestException(
          `A contradiction was detected when uploading concept "${body.label}" (type: ${body.type}). ` +
          `An existing node conflicts with this upload. Review the WKG before re-uploading.`,
        );
      }

      createdNode = upsertResult.node;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `uploadConcept: upsertNode failed for label="${body.label}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        `Failed to create concept "${body.label}" in WKG`,
      );
    }

    // Create requested relationships (fire-and-forget errors are logged but
    // do not fail the response — the node was created successfully)
    let relationshipsCreated = 0;

    if (body.relationships && body.relationships.length > 0) {
      for (const rel of body.relationships) {
        try {
          const edgeResult = await this.wkgService.upsertEdge({
            sourceId: createdNode.id,
            targetId: rel.targetId,
            relationship: rel.relationship,
            provenance: 'GUARDIAN',
            initialConfidence: GUARDIAN_BASE_CONFIDENCE,
          });

          if (edgeResult.type === 'success') {
            relationshipsCreated++;
          } else {
            this.logger.warn(
              `uploadConcept: edge contradiction for rel="${rel.relationship}" to target="${rel.targetId}"`,
            );
          }
        } catch (edgeError) {
          this.logger.error(
            `uploadConcept: failed to create edge rel="${rel.relationship}" to target="${rel.targetId}": ` +
            `${edgeError instanceof Error ? edgeError.message : String(edgeError)}`,
          );
        }
      }
    }

    return {
      skill: this.toSkillDto(createdNode),
      enforcedProvenance: 'GUARDIAN',
      enforcedConfidence: 0.60,
      relationshipsCreated,
    };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Convert a WKG KnowledgeNode to a SkillDto.
   *
   * Extracts the display label from node properties (prefers `name`, then
   * `label`; falls back to the primary Neo4j label). Computes current ACT-R
   * confidence. Determines isType1 from confidence and predictionMae.
   *
   * predictionMae is stored as `prediction_mae` in the node properties bag
   * when the Learning subsystem records a prediction evaluation. If absent,
   * it defaults to null (procedure has never been used for predictions).
   *
   * deactivated is a top-level Neo4j property set by deactivateNode(). It is
   * separate from the properties bag so it is directly queryable in Cypher.
   *
   * @param node KnowledgeNode from the WKG.
   * @returns SkillDto safe to serialize to JSON.
   */
  private toSkillDto(node: KnowledgeNode): SkillDto {
    const confidence = computeConfidence(node.actrParams);

    const predictionMae =
      typeof node.properties.prediction_mae === 'number'
        ? node.properties.prediction_mae
        : null;

    const isType1 =
      confidence > CONFIDENCE_THRESHOLDS.graduation &&
      predictionMae !== null &&
      predictionMae < CONFIDENCE_THRESHOLDS.graduationMAE;

    // Extract human-readable display label
    let label: string;
    if (typeof node.properties.name === 'string' && node.properties.name.length > 0) {
      label = node.properties.name;
    } else if (typeof node.properties.label === 'string' && node.properties.label.length > 0) {
      label = node.properties.label;
    } else {
      label = node.labels[0] ?? 'Unknown';
    }

    // Type is the primary label; compound labels joined for display
    const type = node.labels.join('/');

    // deactivated is stored as a top-level Neo4j property, not in the
    // properties bag. It arrives in node.properties when WkgService maps
    // all Neo4j node properties into the KnowledgeNode.properties Record.
    const deactivated = node.properties.deactivated === true;

    return {
      id: node.id,
      label,
      type,
      confidence,
      provenance: node.provenance,
      useCount: node.actrParams.count,
      predictionMae,
      isType1,
      createdAt: node.createdAt.toISOString(),
      lastUsedAt: node.actrParams.lastRetrievalAt
        ? node.actrParams.lastRetrievalAt.toISOString()
        : null,
      deactivated,
    };
  }
}
