import React, { useEffect, useMemo, useRef } from 'react'
import { Box, Typography } from '@mui/material'
import cytoscape from 'cytoscape'
import type { GraphSnapshot } from '../../types'

/** Convert a hex color to rgba with given alpha (Cytoscape doesn't support 8-char hex). */
function hexRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * MiniGraphPanel — compact Cytoscape visualization for OKG/SKG.
 * Takes graph data as props (no store dependency), uses a simplified
 * style palette, and has no filter bar.
 */

interface MiniGraphPanelProps {
  data: GraphSnapshot
  accentColor: string   // Primary color for nodes
  emptyMessage: string  // Shown when no data
}

export const MiniGraphPanel: React.FC<MiniGraphPanelProps> = ({
  data,
  accentColor,
  emptyMessage,
}) => {
  const cyRef = useRef<HTMLDivElement>(null)
  const cyInstance = useRef<cytoscape.Core | null>(null)

  // Fingerprint to avoid re-layout on identical data
  const fingerprint = useMemo(() => {
    const last = data.nodes[data.nodes.length - 1]
    return `${data.nodes.length}:${data.edges.length}:${last?.node_id ?? ''}`
  }, [data])

  // Initialize Cytoscape
  useEffect(() => {
    if (!cyRef.current) return

    const cy = cytoscape({
      container: cyRef.current,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '9px',
            'text-wrap': 'wrap',
            'text-max-width': '80px',
            color: '#E0E0E0',
            'text-outline-width': 0,
            'text-margin-y': 5,
            'text-background-color': '#1a1a2e',
            'text-background-opacity': 0.7,
            'text-background-padding': '1px',
            'background-color': accentColor,
            width: '22px',
            height: '22px',
          },
        },
        // Person anchor nodes — larger, brighter
        {
          selector: 'node[node_type = "Person"]',
          style: {
            'background-color': accentColor,
            shape: 'star',
            width: '36px',
            height: '36px',
            'font-size': '11px',
            'font-weight': 'bold',
          },
        },
        // CoBeing anchor (SKG)
        {
          selector: 'node[node_type = "CoBeing"]',
          style: {
            'background-color': '#FFD740',
            shape: 'star',
            width: '40px',
            height: '40px',
            'font-size': '12px',
            'font-weight': 'bold',
            color: '#FFD740',
          },
        },
        // Attribute nodes
        {
          selector: 'node[node_type = "Attribute"]',
          style: {
            'background-color': hexRgba(accentColor, 0.8),
            shape: 'round-rectangle',
            width: '28px',
            height: '20px',
            'font-size': '8px',
          },
        },
        // Edges
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            'curve-style': 'unbundled-bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': hexRgba(accentColor, 0.5),
            'line-color': hexRgba(accentColor, 0.38),
            width: 1,
            opacity: 0.6,
            'arrow-scale': 0.6,
            'font-size': '7px',
            color: '#B0BEC5',
            'text-rotation': 'autorotate',
            'text-margin-y': -6,
            'text-background-color': '#1a1a2e',
            'text-background-opacity': 0.7,
            'text-background-padding': '1px',
          },
        },
        {
          selector: 'edge[edge_type = "HAS_FACT"]',
          style: {
            'line-color': hexRgba(accentColor, 0.56),
            'target-arrow-color': hexRgba(accentColor, 0.56),
            'line-style': 'dashed',
          },
        },
      ],
      layout: { name: 'cose', animate: false } as cytoscape.LayoutOptions,
    })

    cyInstance.current = cy
    return () => { cy.destroy() }
  }, [accentColor])

  // Update data
  useEffect(() => {
    if (!cyInstance.current) return
    const cy = cyInstance.current

    const nodeLabel = (node: GraphSnapshot['nodes'][number]): string => {
      const p = node.properties ?? {}
      if (node.node_type === 'Person') return (p.username as string) || node.node_id
      if (node.node_type === 'CoBeing') return node.label || 'Sylphie'
      if (node.node_type === 'Attribute') {
        const key = (p.key as string) || ''
        const val = (p.value as string) || ''
        return key ? `${key}: ${val}` : node.label || node.node_id
      }
      return node.label || (p.name as string) || (p.value as string) || node.node_id
    }

    const nodeElements = data.nodes.map((node) => ({
      data: {
        ...node,
        id: node.node_id,
        label: nodeLabel(node),
      },
    }))

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

    if (cy.elements().length > 0) {
      cy.layout({
        name: 'cose',
        animate: false,
        fit: true,
        padding: 20,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 80,
        nodeOverlap: 20,
      } as unknown as cytoscape.LayoutOptions).run()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  const isEmpty = data.nodes.length === 0

  return (
    <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Always render the Cytoscape container so cyRef is available on mount */}
      <Box
        ref={cyRef}
        sx={{
          width: '100%',
          height: '100%',
          bgcolor: '#1a1a2e',
          visibility: isEmpty ? 'hidden' : 'visible',
        }}
      />
      {/* Empty state overlay */}
      {isEmpty && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
            `,
            backgroundSize: '24px 24px',
          }}
        >
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: `${accentColor}40`,
              animation: 'pulse 2s ease-in-out infinite',
              '@keyframes pulse': {
                '0%': { transform: 'scale(1)', opacity: 0.4 },
                '50%': { transform: 'scale(1.5)', opacity: 0.8 },
                '100%': { transform: 'scale(1)', opacity: 0.4 },
              },
            }}
          />
          <Typography
            sx={{
              fontSize: '0.7rem',
              color: 'rgba(255,255,255,0.3)',
              textAlign: 'center',
              maxWidth: 200,
              lineHeight: 1.4,
            }}
          >
            {emptyMessage}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
