import React, { useEffect, useMemo, useRef } from 'react'
import { Box } from '@mui/material'
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import type { GraphSnapshot } from '../../types'
import { useAppStore } from '../../store'
import { CYTOSCAPE_STYLES, nodeLabel } from './graphStyles'

cytoscape.use(fcose)

// Extra style for the center node — pulsing white ring
const CENTER_NODE_STYLE: cytoscape.StylesheetStyle = {
  selector: '.center-node',
  style: {
    'border-width': 4,
    'border-color': '#FFFFFF',
    'border-opacity': 0.9,
  },
}

interface ExplorerGraphPanelProps {
  data: GraphSnapshot
  centerNodeId: string
  onNodeSelect: (nodeId: string) => void
}

export const ExplorerGraphPanel: React.FC<ExplorerGraphPanelProps> = ({
  data,
  centerNodeId,
  onNodeSelect,
}) => {
  const cyRef = useRef<HTMLDivElement>(null)
  const cyInstance = useRef<cytoscape.Core | null>(null)
  const setNodeInspector = useAppStore((s) => s.setNodeInspector)

  const fingerprint = useMemo(() => {
    const lastNode = data.nodes[data.nodes.length - 1]
    return `${data.nodes.length}:${data.edges.length}:${lastNode?.node_id ?? ''}:${centerNodeId}`
  }, [data, centerNodeId])

  // Initialize Cytoscape
  useEffect(() => {
    if (!cyRef.current) return

    const cy = cytoscape({
      container: cyRef.current,
      style: [...CYTOSCAPE_STYLES, CENTER_NODE_STYLE],
      layout: { name: 'preset' },
    })

    // Tap node: open inspector + allow drilling
    cy.on('tap', 'node', (event) => {
      const nodeId = event.target.id()
      setNodeInspector(true, nodeId)
    })

    // Double-tap to drill into a node as new center
    cy.on('dbltap', 'node', (event) => {
      const nodeId = event.target.id()
      if (nodeId !== centerNodeId) {
        onNodeSelect(nodeId)
      }
    })

    cy.on('tap', (event) => {
      if (event.target === cy) {
        setNodeInspector(false)
      }
    })

    cyInstance.current = cy
    return () => { cy.destroy() }
  }, [setNodeInspector, onNodeSelect, centerNodeId])

  // Update graph data
  useEffect(() => {
    if (!cyInstance.current) return
    const cy = cyInstance.current

    const nodeElements = data.nodes.map((node) => {
      const conf = node.confidence
      const confSuffix = conf != null ? `\n${(conf * 100).toFixed(0)}%` : ''
      return {
        data: {
          ...node,
          id: node.node_id,
          label: `${nodeLabel(node)}${confSuffix}`,
        },
        classes: node.node_id === centerNodeId ? 'center-node' : undefined,
      }
    })

    const edgeElements = data.edges.map((edge) => ({
      data: {
        ...edge,
        id: edge.edge_id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        label: edge.label || edge.edge_type,
      },
    }))

    cy.elements().remove()
    cy.add([...nodeElements, ...edgeElements])

    // Confidence dimming
    cy.nodes()
      .filter((node) => {
        const conf = node.data('confidence') as number | null
        return conf != null && conf < 0.5
      })
      .style('opacity', 0.5)

    // Edge opacity cascade
    cy.edges()
      .filter((edge) => {
        const source = cy.getElementById(edge.data('source') as string)
        const target = cy.getElementById(edge.data('target') as string)
        return Number(source.style('opacity')) < 0.5 || Number(target.style('opacity')) < 0.5
      })
      .style('opacity', 0.1)

    // Pin center node at origin
    const fixedConstraints: Array<{ nodeId: string; position: { x: number; y: number } }> = []
    const centerCyNode = cy.getElementById(centerNodeId)
    if (centerCyNode && centerCyNode.length > 0) {
      fixedConstraints.push({ nodeId: centerNodeId, position: { x: 0, y: 0 } })
    }

    if (cy.elements().length > 0) {
      cy.layout({
        name: 'fcose',
        quality: 'default',
        randomize: true,
        animate: true,
        animationDuration: 600,
        fit: true,
        padding: 40,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 150,
        nodeRepulsion: 30000,
        nodeOverlap: 30,
        edgeElasticity: 0.15,
        nestingFactor: 0.1,
        gravity: 0.08,
        gravityRange: 2.0,
        numIter: 2500,
        initialTemp: 300,
        coolingFactor: 0.95,
        minTemp: 1.0,
        fixedNodeConstraint: fixedConstraints.length > 0 ? fixedConstraints : undefined,
      } as unknown as cytoscape.LayoutOptions).run()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  return (
    <Box
      ref={cyRef}
      sx={{
        width: '100%',
        height: '100%',
        bgcolor: '#1a1a2e',
      }}
    />
  )
}
