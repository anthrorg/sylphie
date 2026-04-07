import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  Box,
  Chip,
  LinearProgress,
  Stack,
  Typography,
  Tooltip,
} from '@mui/material'
import { UnfoldLess as CollapseIcon, UnfoldMore as ExpandIcon } from '@mui/icons-material'
import cytoscape from 'cytoscape'
import { useProgressiveSnapshot } from '../../hooks/useProgressiveSnapshot'
import { SearchBar, type SearchResult } from '../../components/Codebase/SearchBar'
import { ContextPanel } from '../../components/Codebase/ContextPanel'
import type { GraphSnapshot, GraphNode, GraphEdge } from '../../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHierarchy(data: GraphSnapshot) {
  const moduleChildren = new Map<string, GraphNode[]>()
  const serviceModules = new Map<string, GraphNode[]>()
  const nodeById = new Map<string, GraphNode>()
  const edgeIndex = new Map<string, GraphEdge[]>()

  for (const n of data.nodes) nodeById.set(n.node_id, n)

  for (const e of data.edges) {
    if (!edgeIndex.has(e.source_node_id)) edgeIndex.set(e.source_node_id, [])
    edgeIndex.get(e.source_node_id)!.push(e)

    if (e.edge_type === 'CONTAINS') {
      const child = nodeById.get(e.target_node_id)
      if (child) {
        if (!moduleChildren.has(e.source_node_id)) moduleChildren.set(e.source_node_id, [])
        moduleChildren.get(e.source_node_id)!.push(child)
      }
    }
    if (e.edge_type === 'BELONGS_TO') {
      const module = nodeById.get(e.source_node_id)
      const service = nodeById.get(e.target_node_id)
      if (module && service) {
        if (!serviceModules.has(service.node_id)) serviceModules.set(service.node_id, [])
        serviceModules.get(service.node_id)!.push(module)
      }
    }
  }
  return { moduleChildren, serviceModules, nodeById, edgeIndex }
}

function shortPath(fp: string): string {
  return fp.split('/').pop() || fp
}

function nodeLabel(node: GraphNode): string {
  const p = node.properties ?? {}
  switch (node.node_type) {
    case 'Service': return (p.name as string) || node.label || node.node_id
    case 'Module': return shortPath((p.filePath as string) || node.node_id)
    case 'Function': return (p.name as string) || node.label || node.node_id
    case 'Type': return (p.name as string) || node.label || node.node_id
    case 'Change': return (p.shortHash as string) || (p.message as string)?.slice(0, 20) || node.node_id
    case 'Constraint': return (p.description as string)?.slice(0, 30) || node.node_id
    default: return node.label || (p.name as string) || node.node_id
  }
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const NODE_STYLES: Record<string, { color: string }> = {
  Service: { color: '#FF6B6B' }, Module: { color: '#4ECDC4' },
  Function: { color: '#45B7D1' }, Type: { color: '#CE93D8' },
  Change: { color: '#FFB74D' }, Constraint: { color: '#EF5350' },
}
const LEGEND_TYPES = Object.keys(NODE_STYLES)

const Legend: React.FC<{
  stats: { nodes: number; edges: number }
  expandedCount: number
  onCollapseAll: () => void
}> = ({ stats, expandedCount, onCollapseAll }) => (
  <Box sx={{ position: 'absolute', top: 8, left: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 0.5, pointerEvents: 'auto' }}>
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {LEGEND_TYPES.map((type) => (
        <Chip key={type} size="small"
          label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Box component="span" sx={{ width: 6, height: 6, borderRadius: type === 'Function' ? '50%' : '2px', bgcolor: NODE_STYLES[type].color, flexShrink: 0 }} />
            {type}
          </Box>}
          sx={{ fontSize: '0.6rem', height: 20, cursor: 'default', bgcolor: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.7)', border: `1px solid ${NODE_STYLES[type].color}40`, '& .MuiChip-label': { px: 0.75 } }}
        />
      ))}
      {expandedCount > 0 && (
        <Tooltip title="Collapse all modules">
          <Chip size="small" icon={<CollapseIcon sx={{ fontSize: '0.75rem !important', color: 'rgba(255,255,255,0.5) !important' }} />}
            label="Collapse all" onClick={onCollapseAll}
            sx={{ fontSize: '0.6rem', height: 20, cursor: 'pointer', bgcolor: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)', '& .MuiChip-label': { px: 0.5 } }}
          />
        </Tooltip>
      )}
    </Stack>
    <Typography sx={{ fontSize: '0.5rem', color: 'rgba(255,255,255,0.2)', pl: 0.5 }}>
      {stats.nodes} total · {expandedCount > 0 ? `${expandedCount} expanded · ` : ''}click module to expand
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// CodebaseView
// ---------------------------------------------------------------------------

export const CodebaseView: React.FC = () => {
  const pkg = useProgressiveSnapshot('pkg', 30_000)
  const pkgData = pkg.data ?? { nodes: [], edges: [] }
  const pkgStats = { nodes: pkg.totalNodes, edges: pkg.totalEdges }

  const cyRef = useRef<HTMLDivElement>(null)
  const cyInstance = useRef<cytoscape.Core | null>(null)
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set())
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const hierarchy = useMemo(() => {
    if (pkgData.nodes.length === 0) return null
    return buildHierarchy(pkgData)
  }, [pkgData])

  const handleCollapseAll = useCallback(() => setExpandedModules(new Set()), [])

  // Compute visible elements
  const visibleElements = useMemo(() => {
    if (!hierarchy) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[], moduleChildCounts: new Map<string, number>() }
    const { moduleChildren } = hierarchy
    const visibleNodeIds = new Set<string>()
    const moduleChildCounts = new Map<string, number>()

    for (const n of pkgData.nodes) {
      if (n.node_type === 'Service' || n.node_type === 'Module') visibleNodeIds.add(n.node_id)
    }
    for (const [moduleId, children] of moduleChildren) {
      moduleChildCounts.set(moduleId, children.length)
      if (expandedModules.has(moduleId)) {
        for (const child of children) visibleNodeIds.add(child.node_id)
      }
    }
    return {
      nodes: pkgData.nodes.filter((n) => visibleNodeIds.has(n.node_id)),
      edges: pkgData.edges.filter((e) => visibleNodeIds.has(e.source_node_id) && visibleNodeIds.has(e.target_node_id)),
      moduleChildCounts,
    }
  }, [pkgData, hierarchy, expandedModules])

  const fingerprint = useMemo(
    () => `${visibleElements.nodes.length}:${visibleElements.edges.length}:${expandedModules.size}`,
    [visibleElements, expandedModules],
  )

  // ── Search handlers ──────────────────────────────────────
  const handleSearchSelect = useCallback((result: SearchResult) => {
    if (!hierarchy) return
    // Find which module contains this function/type and expand it
    const { moduleChildren, nodeById } = hierarchy
    for (const [moduleId, children] of moduleChildren) {
      const match = children.find((c) => {
        const name = (c.properties?.name as string) || c.label
        return name === result.name
      })
      if (match) {
        setExpandedModules((prev) => { const next = new Set(prev); next.add(moduleId); return next })
        // Select the node after expansion
        const node = nodeById.get(match.node_id)
        if (node) {
          setSelectedNode(node)
          setPanelOpen(true)
          // Pan to the node after a short delay (layout needs to settle)
          setTimeout(() => {
            const cy = cyInstance.current
            if (cy) {
              const cyNode = cy.getElementById(match.node_id)
              if (cyNode.length > 0) {
                cy.animate({ center: { eles: cyNode }, zoom: cy.zoom() }, { duration: 300 })
                cy.elements().removeClass('highlighted dimmed search-match')
                cyNode.addClass('highlighted')
              }
            }
          }, 500)
        }
        return
      }
    }
  }, [hierarchy])

  const handleHighlightSearch = useCallback((names: string[]) => {
    const cy = cyInstance.current
    if (!cy) return
    cy.elements().removeClass('search-match')
    if (names.length === 0) return
    const nameSet = new Set(names)
    cy.nodes().forEach((n) => {
      const label = n.data('label') as string
      const name = n.data('name') as string
      if (nameSet.has(label) || nameSet.has(name)) n.addClass('search-match')
    })
  }, [])

  const handleHighlightDataFlow = useCallback((names: string[]) => {
    const cy = cyInstance.current
    if (!cy) return
    cy.elements().removeClass('dataflow')
    if (names.length === 0) return
    const nameSet = new Set(names)
    cy.nodes().forEach((n) => {
      const name = n.data('name') as string
      if (nameSet.has(name)) n.addClass('dataflow')
    })
  }, [])

  const handleNavigateToNode = useCallback((name: string) => {
    if (!hierarchy) return
    const { nodeById } = hierarchy
    // Find by name property
    for (const [, node] of nodeById) {
      const nodeName = (node.properties?.name as string) || node.label
      if (nodeName === name) {
        setSelectedNode(node)
        setPanelOpen(true)
        const cy = cyInstance.current
        if (cy) {
          const cyNode = cy.getElementById(node.node_id)
          if (cyNode.length > 0) {
            cy.animate({ center: { eles: cyNode }, zoom: Math.max(cy.zoom(), 0.8) }, { duration: 300 })
          }
        }
        return
      }
    }
  }, [hierarchy])

  // ── Initialize Cytoscape ─────────────────────────────────
  useEffect(() => {
    if (!cyRef.current) return
    const cy = cytoscape({
      container: cyRef.current,
      style: ([
        { selector: 'node', style: {
          label: 'data(label)', 'text-valign': 'bottom', 'text-halign': 'center',
          'font-size': '8px', 'text-wrap': 'wrap', 'text-max-width': '100px',
          color: '#E0E0E0', 'text-margin-y': 5,
          'text-background-color': '#0d1117', 'text-background-opacity': 0.8, 'text-background-padding': '2px',
          'background-color': '#556270', width: '20px', height: '20px',
        }},
        { selector: 'node[node_type = "Service"]', style: {
          'background-color': '#FF6B6B', shape: 'round-rectangle', width: '60px', height: '36px',
          'font-size': '12px', 'font-weight': 'bold', color: '#FFCDD2', 'border-width': 2, 'border-color': '#D32F2F',
        }},
        { selector: 'node[node_type = "Module"][?collapsed]', style: {
          'background-color': '#4ECDC4', shape: 'round-rectangle', width: '52px', height: '34px',
          'font-size': '9px', 'font-weight': 'bold', color: '#E0F7FA', 'border-width': 1.5, 'border-color': '#00897B', 'border-style': 'dashed',
        }},
        { selector: 'node[node_type = "Module"][!collapsed]', style: {
          'background-color': '#4ECDC4', shape: 'round-rectangle', width: '52px', height: '34px',
          'font-size': '9px', 'font-weight': 'bold', color: '#E0F7FA', 'border-width': 2, 'border-color': '#00E676', 'border-style': 'solid',
        }},
        { selector: 'node[node_type = "Function"]', style: { 'background-color': '#45B7D1', shape: 'ellipse', width: '20px', height: '20px', 'font-size': '7px' }},
        { selector: 'node[node_type = "Type"]', style: { 'background-color': '#CE93D8', shape: 'diamond', width: '22px', height: '22px', 'font-size': '7px' }},
        { selector: 'node[node_type = "Change"]', style: { 'background-color': '#FFB74D', shape: 'hexagon', width: '18px', height: '18px', 'font-size': '7px' }},
        { selector: 'node[node_type = "Constraint"]', style: { 'background-color': '#EF5350', shape: 'octagon', width: '20px', height: '20px', 'font-size': '7px' }},
        // Edges
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': 'rgba(120,144,156,0.5)', 'line-color': 'rgba(120,144,156,0.3)', width: 0.8, opacity: 0.6, 'arrow-scale': 0.5 }},
        { selector: 'edge[edge_type = "BELONGS_TO"]', style: { 'line-color': 'rgba(255,107,107,0.4)', 'target-arrow-color': 'rgba(255,107,107,0.4)', width: 1.2 }},
        { selector: 'edge[edge_type = "CONTAINS"]', style: { 'line-color': 'rgba(78,205,196,0.4)', 'target-arrow-color': 'rgba(78,205,196,0.4)', width: 1 }},
        { selector: 'edge[edge_type = "CALLS"]', style: { 'line-color': 'rgba(69,183,209,0.6)', 'target-arrow-color': 'rgba(69,183,209,0.6)', width: 1.5 }},
        { selector: 'edge[edge_type = "USES_TYPE"]', style: { 'line-color': 'rgba(206,147,216,0.4)', 'target-arrow-color': 'rgba(206,147,216,0.4)', 'line-style': 'dashed' }},
        { selector: 'edge[edge_type = "IMPORTS"]', style: { 'line-color': 'rgba(102,187,106,0.4)', 'target-arrow-color': 'rgba(102,187,106,0.4)', 'line-style': 'dashed' }},
        { selector: 'edge[edge_type = "EXTENDS"]', style: { 'line-color': 'rgba(255,215,64,0.5)', 'target-arrow-color': 'rgba(255,215,64,0.5)' }},
        { selector: 'edge[edge_type = "IMPLEMENTS"]', style: { 'line-color': 'rgba(255,152,0,0.5)', 'target-arrow-color': 'rgba(255,152,0,0.5)', 'line-style': 'dashed' }},
        { selector: 'edge[edge_type = "INJECTS"]', style: { 'line-color': 'rgba(255,87,34,0.5)', 'target-arrow-color': 'rgba(255,87,34,0.5)', 'line-style': 'dashed' }},
        // Interaction states
        { selector: ':selected', style: { 'border-width': 3, 'border-color': '#FFFFFF', 'overlay-opacity': 0.12 }},
        { selector: '.highlighted', style: { opacity: 1, 'border-width': 2, 'border-color': '#FFD740' }},
        { selector: '.dimmed', style: { opacity: 0.15 }},
        { selector: '.search-match', style: { 'border-width': 2, 'border-color': '#45B7D1', 'border-style': 'solid' }},
        { selector: '.dataflow', style: { 'border-width': 2, 'border-color': '#66BB6A' }},
      ] as unknown) as cytoscape.StylesheetCSS[],
      layout: { name: 'preset' } as cytoscape.LayoutOptions,
      textureOnViewport: true,
      hideEdgesOnViewport: true,
      hideLabelsOnViewport: true,
    })

    cy.on('tap', 'node', (event) => {
      const tappedId = event.target.id()
      const tappedType = event.target.data('node_type') as string

      if (tappedType === 'Module' && event.target.data('collapsed')) {
        setExpandedModules((prev) => { const next = new Set(prev); next.add(tappedId); return next })
        return
      }

      const hookData = pkg.data
      const node = hookData?.nodes.find((n) => n.node_id === tappedId)
      if (node) { setSelectedNode(node); setPanelOpen(true) }

      cy.elements().removeClass('highlighted dimmed')
      const selected = cy.getElementById(tappedId)
      const neighborhood = selected.neighborhood().add(selected)
      cy.elements().not(neighborhood).addClass('dimmed')
      neighborhood.addClass('highlighted')
    })

    cy.on('dbltap', 'node[node_type = "Module"]', (event) => {
      setExpandedModules((prev) => { const next = new Set(prev); next.delete(event.target.id()); return next })
    })

    cy.on('tap', (event) => {
      if (event.target === cy) {
        setPanelOpen(false)
        cy.elements().removeClass('highlighted dimmed search-match dataflow')
      }
    })

    cy.on('zoom', () => {
      const z = cy.zoom()
      if (z < 0.4) {
        cy.nodes('[node_type = "Function"], [node_type = "Type"], [node_type = "Change"]').style('label', '')
      } else {
        cy.nodes().style('label', 'data(label)')
      }
    })

    cyInstance.current = cy
    return () => { cy.destroy() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Render visible elements ──────────────────────────────
  useEffect(() => {
    if (!cyInstance.current || !hierarchy) return
    const cy = cyInstance.current
    const { moduleChildCounts } = visibleElements

    const nodeEls = visibleElements.nodes.map((node) => {
      const isModule = node.node_type === 'Module'
      const isCollapsed = isModule && !expandedModules.has(node.node_id)
      const childCount = moduleChildCounts.get(node.node_id) ?? 0
      const label = isCollapsed && childCount > 0
        ? `${nodeLabel(node)}\n(${childCount})`
        : nodeLabel(node)
      return {
        data: {
          id: node.node_id, node_type: node.node_type, label, collapsed: isCollapsed,
          name: (node.properties?.name as string) || node.label || '',
          ...node.properties,
        },
      }
    })

    const edgeEls = visibleElements.edges.map((edge) => ({
      data: { id: edge.edge_id, source: edge.source_node_id, target: edge.target_node_id, edge_type: edge.edge_type },
    }))

    cy.batch(() => { cy.elements().remove(); cy.add([...nodeEls, ...edgeEls]) })

    if (cy.nodes().length > 0) {
      cy.layout({
        name: 'cose', animate: false, fit: true, padding: 50,
        nodeRepulsion: () => 12000, idealEdgeLength: () => expandedModules.size > 0 ? 80 : 120,
        nodeOverlap: 30, gravity: 0.3, numIter: 200,
        randomize: expandedModules.size === 0,
      } as unknown as cytoscape.LayoutOptions).run()
    }

    cy.elements().removeClass('highlighted dimmed search-match dataflow')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', p: 1.5, gap: 1, boxSizing: 'border-box' }}>
      {/* Search bar */}
      <SearchBar onSelect={handleSearchSelect} onHighlightResults={handleHighlightSearch} />

      {/* Main content: graph + context panel */}
      <Box sx={{ flex: 1, display: 'flex', gap: 1, minHeight: 0 }}>
        {/* Graph */}
        <Box
          sx={{
            flex: 1, borderRadius: 2,
            border: '1px solid rgba(184,217,198,0.12)',
            bgcolor: 'rgba(255,255,255,0.03)',
            overflow: 'hidden', position: 'relative',
          }}
        >
          {pkg.loading && pkg.progress < 1 && (
            <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 15 }}>
              <LinearProgress variant="determinate" value={pkg.progress * 100}
                sx={{ height: 2, bgcolor: 'transparent', '& .MuiLinearProgress-bar': { bgcolor: '#45B7D1' } }} />
              <Typography sx={{
                position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
                fontSize: '0.55rem', fontFamily: 'monospace', color: 'rgba(69,183,209,0.6)',
                bgcolor: 'rgba(0,0,0,0.6)', px: 1, borderRadius: 0.5,
              }}>
                {pkg.status}
              </Typography>
            </Box>
          )}

          <Legend stats={pkgStats} expandedCount={expandedModules.size} onCollapseAll={handleCollapseAll} />

          {pkgData.nodes.length === 0 && !pkg.loading && (
            <Box sx={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 1.5, zIndex: 5,
              backgroundImage: `linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)`,
              backgroundSize: '32px 32px',
            }}>
              <ExpandIcon sx={{ fontSize: 40, color: 'rgba(69,183,209,0.3)' }} />
              <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600 }}>
                Package Knowledge Graph
              </Typography>
              <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.2)', textAlign: 'center', maxWidth: 300 }}>
                Ensure the PKG Neo4j instance is running and the backend has been restarted.
              </Typography>
            </Box>
          )}

          <Box ref={cyRef} sx={{ width: '100%', height: '100%', bgcolor: '#0d1117' }} />
        </Box>

        {/* Context panel (slides in when a node is selected) */}
        {panelOpen && (
          <ContextPanel
            node={selectedNode}
            open={panelOpen}
            onClose={() => { setPanelOpen(false); cyInstance.current?.elements().removeClass('highlighted dimmed') }}
            childCount={selectedNode ? (visibleElements.moduleChildCounts.get(selectedNode.node_id) ?? undefined) : undefined}
            onNavigateToNode={handleNavigateToNode}
            onHighlightDataFlow={handleHighlightDataFlow}
          />
        )}
      </Box>
    </Box>
  )
}
