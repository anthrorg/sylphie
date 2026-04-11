import type cytoscape from 'cytoscape'

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

// ---------------------------------------------------------------------------
// Simplified node_type -> color map (reused by Ambient 3D + Explorer)
// ---------------------------------------------------------------------------
export const NODE_TYPE_COLORS: Record<string, string> = {
  PhraseNode: '#FF6B6B',
  WordNode: '#26C6DA',
  WordFormNode: '#FFD54F',
  WordSenseNode: '#7C4DFF',
  InterpretationNode: '#FFAB40',
  DriveCategory: '#FF1744',
  ActionProcedure: '#FF6D00',
  ConceptPrimitive: '#E040FB',
  ProceduralTemplate: '#7B1FA2',
  ProcedureStep: '#F50057',
  WorkedExample: '#AEEA00',
  ValueNode: '#00E676',
  GroundingFailure: '#8D6E63',
  CoBeing: '#FFD740',
  PrimitiveSymbol: '#39FF14',
}

export const DEFAULT_NODE_COLOR = '#7986CB'

// ---------------------------------------------------------------------------
// Smart node label extraction — type-specific with fallback chains
// ---------------------------------------------------------------------------
export function nodeLabel(node: { node_id: string; node_type: string; label: string; properties: Record<string, unknown> }): string {
  const p = node.properties ?? {}
  const nid = node.node_id ?? ''
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

// ---------------------------------------------------------------------------
// Full Cytoscape style array — shared by GraphPanel + ExplorerGraphPanel
// ---------------------------------------------------------------------------
export const CYTOSCAPE_STYLES: cytoscape.StylesheetStyle[] = [
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
  // ── Provenance border ring ──────────────────────────────────
  {
    selector: 'node[provenance_type = "SENSOR"]',
    style: { 'border-width': 2.5, 'border-color': '#2196F3' },
  },
  {
    selector: 'node[provenance_type = "GUARDIAN"]',
    style: { 'border-width': 2.5, 'border-color': '#FFD700' },
  },
  {
    selector: 'node[provenance_type = "LLM_GENERATED"]',
    style: { 'border-width': 2.5, 'border-color': '#9C27B0' },
  },
  {
    selector: 'node[provenance_type = "INFERENCE"]',
    style: { 'border-width': 2.5, 'border-color': '#009688' },
  },
  {
    selector: 'node[provenance_type = "SYSTEM_BOOTSTRAP"]',
    style: { 'border-width': 2.5, 'border-color': '#607D8B' },
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
  // ── Edge types ─────────────────────────────────────────────
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
  // Synthetic gravity edges — invisible
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
]
