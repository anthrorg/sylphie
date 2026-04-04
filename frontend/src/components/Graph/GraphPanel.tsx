import React, { useEffect, useMemo, useRef } from 'react'
import { Box, Chip, Stack, Tooltip } from '@mui/material'
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useAppStore } from '../../store'
import type { ProvenanceFilter, SchemaLevel } from '../../types'

// ---------------------------------------------------------------------------
// Provenance color map — CANON section 2: provenance types
// ---------------------------------------------------------------------------
export const PROVENANCE_COLORS: Record<string, string> = {
  SENSOR: '#2196F3',
  GUARDIAN: '#FFD700',
  LLM_GENERATED: '#9C27B0',
  INFERENCE: '#009688',
  SYSTEM_BOOTSTRAP: '#607D8B',
}

const PROVENANCE_OPTIONS: Array<{ value: ProvenanceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'SENSOR', label: 'Sensor' },
  { value: 'GUARDIAN', label: 'Guardian' },
  { value: 'LLM_GENERATED', label: 'LLM' },
  { value: 'INFERENCE', label: 'Inference' },
  { value: 'SYSTEM_BOOTSTRAP', label: 'Bootstrap' },
]

const SCHEMA_LEVEL_OPTIONS: Array<{ value: SchemaLevel; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'instance', label: 'Instance' },
  { value: 'schema', label: 'Schema' },
  { value: 'meta_schema', label: 'MetaSchema' },
]

// ---------------------------------------------------------------------------
// GraphFilterBar
// ---------------------------------------------------------------------------
const GraphFilterBar: React.FC = () => {
  const { graphFilters, setGraphFilters } = useAppStore()

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        pointerEvents: 'auto',
      }}
    >
      {/* Provenance row */}
      <Stack direction="row" spacing={0.5} flexWrap="wrap">
        {PROVENANCE_OPTIONS.map(({ value, label }) => {
          const isActive = graphFilters.provenance === value
          const dotColor = value === 'all' ? undefined : (PROVENANCE_COLORS[value] ?? undefined)
          return (
            <Tooltip key={value} title={`Provenance: ${label}`} arrow>
              <Chip
                size="small"
                label={
                  <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {dotColor && (
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          bgcolor: dotColor,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {label}
                  </Box>
                }
                onClick={() => setGraphFilters({ provenance: value })}
                sx={{
                  fontSize: '0.65rem',
                  height: 20,
                  cursor: 'pointer',
                  bgcolor: isActive ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.45)',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.5)',
                  border: `1px solid ${isActive ? (dotColor ?? 'rgba(255,255,255,0.6)') : 'rgba(255,255,255,0.12)'}`,
                  '& .MuiChip-label': { px: 0.75 },
                }}
              />
            </Tooltip>
          )
        })}
      </Stack>

      {/* Schema level row */}
      <Stack direction="row" spacing={0.5} flexWrap="wrap">
        {SCHEMA_LEVEL_OPTIONS.map(({ value, label }) => {
          const isActive = graphFilters.schemaLevel === value
          return (
            <Tooltip key={value} title={`Schema level: ${label}`} arrow>
              <Chip
                size="small"
                label={label}
                onClick={() => setGraphFilters({ schemaLevel: value })}
                sx={{
                  fontSize: '0.65rem',
                  height: 20,
                  cursor: 'pointer',
                  bgcolor: isActive ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.45)',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.5)',
                  border: `1px solid ${isActive ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.12)'}`,
                  '& .MuiChip-label': { px: 0.75 },
                }}
              />
            </Tooltip>
          )
        })}
      </Stack>
    </Box>
  )
}

// fcose = force-directed layout with compound node support, needed for knowledge graph topology
cytoscape.use(fcose)

export const GraphPanel: React.FC = () => {
  const cyRef = useRef<HTMLDivElement>(null)
  // Persist the Cytoscape instance across re-renders; destroyed on unmount
  const cyInstance = useRef<cytoscape.Core | null>(null)

  const { graphData, graphFilters, setNodeInspector } = useAppStore()

  // Stable fingerprint: only recompute Cytoscape elements when the actual
  // graph content changes (node/edge count + last node ID as a cheap hash).
  // Prevents expensive full re-layouts on identical snapshot pushes.
  const graphFingerprint = useMemo(() => {
    const lastNode = graphData.nodes[graphData.nodes.length - 1]
    return `${graphData.nodes.length}:${graphData.edges.length}:${lastNode?.node_id ?? ''}`
  }, [graphData])

  // Initialize Cytoscape
  useEffect(() => {
    if (!cyRef.current) return

    const cy = cytoscape({
      container: cyRef.current,
      style: [
        // ── Base node style ──────────────────────────────────────────
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '11px',
            'font-weight': 'normal',
            'text-wrap': 'wrap',
            'text-max-width': '100px',
            color: '#E0E0E0',
            'text-outline-width': 0,
            'text-margin-y': 6,
            'text-background-color': '#1a1a2e',
            'text-background-opacity': 0.7,
            'text-background-padding': '2px',
          },
        },
        // ── Schema-level fallbacks (overridden by node_type) ─────────
        {
          selector: 'node[schema_level = "instance"]',
          style: {
            'background-color': '#7986CB',
            shape: 'ellipse',
            width: '28px',
            height: '28px',
          },
        },
        {
          selector: 'node[schema_level = "schema"]',
          style: {
            'background-color': '#9575CD',
            shape: 'round-rectangle',
            width: '36px',
            height: '28px',
          },
        },
        {
          selector: 'node[schema_level = "meta_schema"]',
          style: {
            'background-color': '#F06292',
            shape: 'diamond',
            width: '40px',
            height: '40px',
          },
        },
        // ── Node types ───────────────────────────────────────────────
        // Language domain (warm coral / teal / gold spectrum)
        {
          selector: 'node[node_type = "PhraseNode"]',
          style: {
            'background-color': '#FF6B6B',
            shape: 'round-rectangle',
            width: '50px',
            height: '32px',
            'font-size': '12px',
            'font-weight': 'bold',
            color: '#FFF0F0',
          },
        },
        {
          selector: 'node[node_type = "WordNode"]',
          style: {
            'background-color': '#26C6DA',
            shape: 'ellipse',
            width: '24px',
            height: '24px',
            'font-size': '10px',
            color: '#E0F7FA',
          },
        },
        {
          selector: 'node[node_type = "WordFormNode"]',
          style: {
            'background-color': '#FFD54F',
            shape: 'ellipse',
            width: '22px',
            height: '22px',
            'font-size': '10px',
            color: '#FFF8E1',
          },
        },
        {
          selector: 'node[node_type = "WordSenseNode"]',
          style: {
            'background-color': '#7C4DFF',
            shape: 'round-rectangle',
            width: '30px',
            height: '24px',
            'font-size': '10px',
            'border-width': 1.5,
            'border-color': '#6200EA',
            color: '#EDE7F6',
          },
        },
        {
          selector: 'node[node_type = "InterpretationNode"]',
          style: {
            'background-color': '#FFAB40',
            shape: 'ellipse',
            width: '22px',
            height: '22px',
            'font-size': '9px',
            color: '#FFF3E0',
          },
        },
        // Drives: vivid crimson — the motivational core
        {
          selector: 'node[node_type = "DriveCategory"]',
          style: {
            'background-color': '#FF1744',
            shape: 'octagon',
            width: '36px',
            height: '36px',
            'border-width': 1.5,
            'border-color': '#D50000',
            'font-size': '10px',
            'font-weight': 'bold',
            color: '#FFCDD2',
          },
        },
        // Actions: bright orange
        {
          selector: 'node[node_type = "ActionProcedure"]',
          style: {
            'background-color': '#FF6D00',
            shape: 'hexagon',
            width: '40px',
            height: '36px',
            'border-width': 1.5,
            'border-color': '#E65100',
            'font-size': '11px',
            color: '#FFF3E0',
          },
        },
        // Concepts: vivid magenta
        {
          selector: 'node[node_type = "ConceptPrimitive"]',
          style: {
            'background-color': '#E040FB',
            shape: 'diamond',
            width: '34px',
            height: '34px',
            'border-width': 1.5,
            'border-color': '#AA00FF',
            color: '#F3E5F5',
          },
        },
        // Procedural domain (electric purple / pink / lime)
        {
          selector: 'node[node_type = "ProceduralTemplate"]',
          style: {
            'background-color': '#7B1FA2',
            shape: 'round-rectangle',
            width: '38px',
            height: '28px',
            'border-width': 1.5,
            'border-color': '#4A0072',
            color: '#F3E5F5',
          },
        },
        {
          selector: 'node[node_type = "ProcedureStep"]',
          style: {
            'background-color': '#F50057',
            shape: 'ellipse',
            width: '20px',
            height: '20px',
            'font-size': '9px',
            color: '#FCE4EC',
          },
        },
        {
          selector: 'node[node_type = "WorkedExample"]',
          style: {
            'background-color': '#AEEA00',
            shape: 'round-rectangle',
            width: '32px',
            height: '24px',
            'font-size': '10px',
            color: '#F9FBE7',
          },
        },
        // Data: bright emerald
        {
          selector: 'node[node_type = "ValueNode"]',
          style: {
            'background-color': '#00E676',
            shape: 'ellipse',
            width: '30px',
            height: '24px',
            color: '#E8F5E9',
          },
        },
        // Grounding failures: warm brown — visible but subdued
        {
          selector: 'node[node_type = "GroundingFailure"]',
          style: {
            label: 'data(label)',
            'background-color': '#8D6E63',
            shape: 'ellipse',
            width: '18px',
            height: '18px',
            opacity: 0.7,
            'font-size': '9px',
            color: '#D7CCC8',
          },
        },
        // Sylphie anchor: bright gold star — gravitational center
        {
          selector: 'node[node_type = "CoBeing"]',
          style: {
            'background-color': '#FFD740',
            shape: 'star',
            width: '52px',
            height: '52px',
            'border-width': 2,
            'border-color': '#FFC400',
            'font-size': '13px',
            'font-weight': 'bold',
            color: '#FFD740',
          },
        },
        // Primitive symbols: neon green substrate nodes
        {
          selector: 'node[node_type = "PrimitiveSymbol"]',
          style: {
            'background-color': '#39FF14',
            shape: 'ellipse',
            width: '44px',
            height: '44px',
            'border-width': 2,
            'border-color': '#00E676',
            'font-size': '12px',
            'font-weight': 'bold',
            color: '#39FF14',
          },
        },
        // Grammar primitives: purple pentagons — structural/syntactic atoms
        {
          selector: 'node[id ^= "primitive:grammar:"]',
          style: {
            'background-color': '#CC66FF',
            shape: 'pentagon',
            width: '40px',
            height: '40px',
            'border-width': 2,
            'border-color': '#9900FF',
            'font-size': '11px',
            'font-weight': 'bold',
            color: '#EDE7F6',
          },
        },
        // ── Provenance border ring — CANON provenance types ──────────
        // Applied as border-color overlay; does not override node shape or size.
        // Node background-color is controlled by node_type above; provenance is
        // indicated by a distinct border so both signals are visible simultaneously.
        {
          selector: 'node[provenance_type = "SENSOR"]',
          style: {
            'border-width': 2.5,
            'border-color': '#2196F3',
          },
        },
        {
          selector: 'node[provenance_type = "GUARDIAN"]',
          style: {
            'border-width': 2.5,
            'border-color': '#FFD700',
          },
        },
        {
          selector: 'node[provenance_type = "LLM_GENERATED"]',
          style: {
            'border-width': 2.5,
            'border-color': '#9C27B0',
          },
        },
        {
          selector: 'node[provenance_type = "INFERENCE"]',
          style: {
            'border-width': 2.5,
            'border-color': '#009688',
          },
        },
        {
          selector: 'node[provenance_type = "SYSTEM_BOOTSTRAP"]',
          style: {
            'border-width': 2.5,
            'border-color': '#607D8B',
          },
        },
        // ── Base edge style ─────────────────────────────────────────
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            'curve-style': 'unbundled-bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#78909C',
            'line-color': '#78909C',
            width: 0.8,
            opacity: 0.65,
            'arrow-scale': 0.7,
            'font-size': '7px',
            color: '#B0BEC5',
            'text-rotation': 'autorotate',
            'text-margin-y': -7,
            'text-background-color': '#1a1a2e',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
          },
        },
        // ── Edge types ───────────────────────────────────────────────
        { selector: 'edge[edge_type = "INSTANCE_OF"]', style: { 'line-color': '#9E9E9E', 'target-arrow-color': '#9E9E9E', width: 1 } },
        { selector: 'edge[edge_type = "IS_A"]', style: { 'line-color': '#B0BEC5', 'target-arrow-color': '#B0BEC5' } },
        { selector: 'edge[edge_type = "INSTANCE_OF_WORD"]', style: { 'line-color': '#7C4DFF', 'target-arrow-color': '#7C4DFF', 'line-style': 'dotted', width: 1 } },
        { selector: 'edge[edge_type = "INSTANCE_OF_CONCEPT"]', style: { 'line-color': '#E040FB', 'target-arrow-color': '#E040FB', 'line-style': 'dotted', width: 1 } },
        { selector: 'edge[edge_type = "DEPENDS_ON"]', style: { 'line-color': '#78909C', 'target-arrow-color': '#78909C', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "IS_PART_OF"]', style: { 'line-color': '#26C6DA', 'target-arrow-color': '#26C6DA', 'line-style': 'dotted', width: 1 } },
        { selector: 'edge[edge_type = "CAN_PRODUCE"]', style: { 'line-color': '#FF6D00', 'target-arrow-color': '#FF6D00', width: 2.5 } },
        { selector: 'edge[edge_type = "VARIANT_OF"]', style: { 'line-color': '#00BFA5', 'target-arrow-color': '#00BFA5', 'line-style': 'dashed', width: 1.5 } },
        { selector: 'edge[edge_type = "PRECEDES"]', style: { 'line-color': '#FF8A80', 'target-arrow-color': '#FF8A80', width: 1.5 } },
        { selector: 'edge[edge_type = "RESPONSE_TO"]', style: { 'line-color': '#40C4FF', 'target-arrow-color': '#40C4FF', width: 2 } },
        { selector: 'edge[edge_type = "HEARD_DURING"]', style: { 'line-color': '#FFAB40', 'target-arrow-color': '#FFAB40', width: 1, 'line-style': 'dotted' } },
        { selector: 'edge[edge_type = "SUPERSEDES"]', style: { 'line-color': '#FF1744', 'target-arrow-color': '#FF1744', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "MEANS"]', style: { 'line-color': '#69F0AE', 'target-arrow-color': '#69F0AE', width: 2 } },
        { selector: 'edge[edge_type = "DERIVED_FROM"]', style: { 'line-color': '#FF80AB', 'target-arrow-color': '#FF80AB', 'line-style': 'dashed', width: 1 } },
        { selector: 'edge[edge_type = "DENOTES"]', style: { 'line-color': '#B388FF', 'target-arrow-color': '#B388FF', width: 1.5 } },
        { selector: 'edge[edge_type = "SAME_SPELLING"]', style: { 'line-color': '#FFD54F', 'target-arrow-color': '#FFD54F', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "MENTIONS"]', style: { 'line-color': '#80D8FF', 'target-arrow-color': '#80D8FF', width: 1 } },
        { selector: 'edge[edge_type = "INTERPRETS"]', style: { 'line-color': '#FFAB40', 'target-arrow-color': '#FFAB40', width: 1.5 } },
        { selector: 'edge[edge_type = "PRODUCED_BY_TEMPLATE"]', style: { 'line-color': '#EA80FC', 'target-arrow-color': '#EA80FC', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "COMPETES_WITH"]', style: { 'line-color': '#FF5252', 'target-arrow-color': '#FF5252', 'line-style': 'dashed', 'target-arrow-shape': 'none' } },
        { selector: 'edge[edge_type = "FOLLOWS_PATTERN"]', style: { 'line-color': '#84FFFF', 'target-arrow-color': '#84FFFF', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "USED_DURING"]', style: { 'line-color': '#F4FF81', 'target-arrow-color': '#F4FF81', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "RELATED_TO"]', style: { 'line-color': '#B9F6CA', 'target-arrow-color': '#B9F6CA', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "RELIEVES"]', style: { 'line-color': '#00E676', 'target-arrow-color': '#00E676', width: 2 } },
        { selector: 'edge[edge_type = "INCREASES"]', style: { 'line-color': '#FF1744', 'target-arrow-color': '#FF1744' } },
        { selector: 'edge[edge_type = "SERVES_DRIVE"]', style: { 'line-color': '#FF9100', 'target-arrow-color': '#FF9100', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "HAS_SUB_PROCEDURE"]', style: { 'line-color': '#FF6D00', 'target-arrow-color': '#FF6D00', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "HAS_PROCEDURE_BODY"]', style: { 'line-color': '#CE93D8', 'target-arrow-color': '#CE93D8' } },
        { selector: 'edge[edge_type = "HAS_WORKED_EXAMPLE"]', style: { 'line-color': '#AEEA00', 'target-arrow-color': '#AEEA00', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "HAS_OPERAND"]', style: { 'line-color': '#F50057', 'target-arrow-color': '#F50057' } },
        { selector: 'edge[edge_type = "GENERATED_BY"]', style: { 'line-color': '#00BCD4', 'target-arrow-color': '#00BCD4', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "COMPUTES_TO"]', style: { 'line-color': '#B39DDB', 'target-arrow-color': '#B39DDB', 'line-style': 'dashed' } },
        { selector: 'edge[edge_type = "DOES_NOT_COMPUTE_TO"]', style: { 'line-color': '#FF5252', 'target-arrow-color': '#FF5252', 'line-style': 'dashed', width: 1.5 } },
        { selector: 'edge[edge_type = "TRANSFORMS_TO"]', style: { 'line-color': '#E040FB', 'target-arrow-color': '#E040FB' } },
        { selector: 'edge[edge_type = "SIMILAR_TO"]', style: { 'line-color': '#18FFFF', 'target-arrow-color': '#18FFFF', 'line-style': 'dashed' } },
        // Synthetic gravity edges — invisible, only exist to pull orphans into the mass
        {
          selector: 'edge[edge_type = "_synthetic"]',
          style: {
            width: 0,
            opacity: 0,
            'target-arrow-shape': 'none',
            'line-color': 'transparent',
          } as unknown as cytoscape.Css.Edge,
        },
        // Selection
        {
          selector: ':selected',
          style: {
            'border-width': 3,
            'border-color': '#FFFFFF',
            'overlay-opacity': 0.15,
            'overlay-color': '#FFFFFF',
          },
        },
      ],
      // fcose layout tuned for brain-like organic topology
      layout: {
        name: 'fcose',
        quality: 'default',
        randomize: true,
        animate: false,
        fit: true,
        padding: 30,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 400,
        nodeRepulsion: 100000,
        nodeOverlap: 50,
        edgeElasticity: 0.1,
        nestingFactor: 0.1,
        gravity: 0.02,
        gravityRange: 1.5,
        numIter: 5000,
        initialTemp: 400,
        coolingFactor: 0.95,
        minTemp: 1.0,
      } as unknown as cytoscape.LayoutOptions,
    })

    cy.on('tap', 'node', (event) => {
      const node = event.target
      const nodeId = node.id()
      setNodeInspector(true, nodeId)
    })

    cy.on('tap', (event) => {
      if (event.target === cy) {
        setNodeInspector(false)
      }
    })

    cyInstance.current = cy

    return () => {
      cy.destroy()
    }
  }, [setNodeInspector])

  // Update graph data — only when the fingerprint changes
  useEffect(() => {
    if (!cyInstance.current) return

    const cy = cyInstance.current
    const currentGraphData = useAppStore.getState().graphData

    const nodeLabel = (node: (typeof currentGraphData.nodes)[number]): string => {
      const p = node.properties ?? {}
      const nid = node.node_id ?? (node as any).id ?? ''
      switch (node.node_type) {
        case 'PhraseNode':
          return (p.normalized_text as string) || (p.raw_texts as string[])?.[0] || nid
        case 'WordNode':
          return (p.normalized_text as string) || nid.replace('word:', '')
        case 'WordFormNode':
          return (p.spelling as string) || nid.replace('form:', '')
        case 'WordSenseNode':
          return p.spelling ? `${p.spelling}:${p.sense_tag ?? '?'}` : nid.replace('word:', '')
        case 'ProcedureStep':
          return (p.step_type as string) || (p.operation as string) || 'step'
        case 'WorkedExample':
          return (p.name as string) || 'example'
        case 'ActionProcedure':
          return ((p.name as string) || nid.replace(/^action:/, '')).replace(/_/g, ' ')
        case 'ConceptPrimitive':
          return (p.name as string) || nid.replace(/^concept:/, '')
        case 'ProceduralTemplate':
          return (p.name as string) || (p.template_name as string) || nid
        case 'ValueNode':
          return (p.value_repr as string) || (p.name as string) || nid
        case 'InterpretationNode':
          return (p.interpretation as string) || 'interp'
        case 'GroundingFailure':
          return (p.triggering_word as string) || '?'
        case 'PrimitiveSymbol': {
          if (p.name) return p.name as string
          const bare = nid.replace('primitive:', '').replace(/_/g, ' ')
          return bare.charAt(0).toUpperCase() + bare.slice(1)
        }
        default:
          if (nid.startsWith('grounding-failure:'))
            return (p.triggering_word as string) || nid.split(':')[1] || '?'
          if (nid.startsWith('drive-category:'))
            return nid.replace('drive-category:', '').replace(/_/g, ' ')
          if (nid.startsWith('rule:')) return nid.replace('rule:', '').replace(/_/g, ' ')
          if (nid.startsWith('meta:')) return nid.replace('meta:', '').replace(/_/g, ' ')
          return node.label || (p.name as string) || (p.value_repr as string) || nid
      }
    }

    const nodeElements = currentGraphData.nodes.map((node) => {
      const conf = node.confidence
      // Append confidence as a second line below the node name so it is
      // visible directly in the graph without opening the inspector.
      const confSuffix = conf != null ? `\n${(conf * 100).toFixed(0)}%` : ''
      return {
        data: {
          ...node,
          id: node.node_id ?? (node as any).id ?? '',
          label: `${nodeLabel(node)}${confSuffix}`,
        },
      }
    })

    const edgeElements = currentGraphData.edges.map((edge) => ({
      data: {
        ...edge,
        id: edge.edge_id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        label: edge.label || edge.edge_type,
      },
    }))

    // Find Sylphie anchor node to serve as gravitational center
    const sylphieNode = currentGraphData.nodes.find((n) => n.node_type === 'CoBeing')
    const anchorId = sylphieNode?.node_id ?? currentGraphData.nodes[0]?.node_id

    const connectedNodeIds = new Set<string>()
    for (const edge of currentGraphData.edges) {
      connectedNodeIds.add(edge.source_node_id)
      connectedNodeIds.add(edge.target_node_id)
    }

    const syntheticEdges: typeof edgeElements = []
    if (anchorId) {
      for (const node of currentGraphData.nodes) {
        if (node.node_id !== anchorId && !connectedNodeIds.has(node.node_id)) {
          syntheticEdges.push({
            data: {
              id: `_synth_${node.node_id}`,
              source: anchorId,
              target: node.node_id,
              label: '',
              edge_type: '_synthetic',
              edge_id: `_synth_${node.node_id}`,
              source_node_id: anchorId,
              target_node_id: node.node_id,
              properties: {},
              confidence: 0,
              created_at: '',
            },
          })
        }
      }
    }

    cy.elements().remove()
    cy.add([...nodeElements, ...edgeElements, ...syntheticEdges])

    cy.elements().style({ opacity: 1, display: 'element' })

    // Confidence-based dimming: nodes below the 0.50 retrieval threshold
    cy.nodes()
      .filter((node) => {
        const conf = node.data('confidence') as number | null
        return conf != null && conf < 0.5
      })
      .style('opacity', 0.5)

    if (graphFilters.schemaLevel !== 'all') {
      cy.nodes().filter(`[schema_level != "${graphFilters.schemaLevel}"]`).style('opacity', 0.15)
    }

    if (graphFilters.provenance !== 'all') {
      cy.nodes()
        .filter((node) => {
          const provType = (node.data('provenance_type') as string) || ''
          return provType !== graphFilters.provenance
        })
        .style('opacity', 0.15)
    }

    graphFilters.nodeTypes.forEach((nodeType) => {
      cy.nodes().filter(`[node_type = "${nodeType}"]`).style('opacity', 0.15)
    })

    if (graphFilters.search) {
      const searchTerm = graphFilters.search.toLowerCase()
      cy.nodes()
        .filter((node) => {
          const label = (node.data('label') as string) || ''
          const nodeId = (node.data('id') as string) || ''
          return (
            !label.toLowerCase().includes(searchTerm) && !nodeId.toLowerCase().includes(searchTerm)
          )
        })
        .style('opacity', 0.15)
    }

    cy.edges()
      .filter((edge) => {
        const source = cy.getElementById(edge.data('source') as string)
        const target = cy.getElementById(edge.data('target') as string)
        return Number(source.style('opacity')) < 0.5 || Number(target.style('opacity')) < 0.5
      })
      .style('opacity', 0.1)

    const anchorCyNode = anchorId ? cy.getElementById(anchorId) : null
    const fixedConstraints: Array<{ nodeId: string; position: { x: number; y: number } }> = []
    if (anchorCyNode && anchorCyNode.length > 0) {
      fixedConstraints.push({ nodeId: anchorId!, position: { x: 0, y: 0 } })
    }

    const allElements = cy.elements()
    if (allElements.length > 0) {
      cy.layout({
        name: 'fcose',
        elements: allElements,
        quality: 'default',
        randomize: true,
        animate: false,
        fit: true,
        padding: 30,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 400,
        nodeRepulsion: 100000,
        nodeOverlap: 50,
        edgeElasticity: 0.1,
        nestingFactor: 0.1,
        gravity: 0.02,
        gravityRange: 1.5,
        numIter: 5000,
        initialTemp: 400,
        coolingFactor: 0.95,
        minTemp: 1.0,
        fixedNodeConstraint: fixedConstraints.length > 0 ? fixedConstraints : undefined,
      } as unknown as cytoscape.LayoutOptions).run()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphFingerprint, graphFilters])

  return (
    <Box sx={{ height: '100%', position: 'relative' }}>
      <GraphFilterBar />
      <Box
        ref={cyRef}
        sx={{
          width: '100%',
          height: '100%',
          bgcolor: '#1a1a2e',
        }}
      />
    </Box>
  )
}
