import React, { useEffect, useMemo, useRef } from 'react'
import { Box, Chip, Stack, Tooltip } from '@mui/material'
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useAppStore } from '../../store'
import type { ProvenanceFilter, SchemaLevel } from '../../types'
import { PROVENANCE_COLORS, CYTOSCAPE_STYLES, nodeLabel } from './graphStyles'

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
      style: CYTOSCAPE_STYLES,
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
