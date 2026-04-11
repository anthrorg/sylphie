import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Box } from '@mui/material'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import { useAppStore } from '../../store'
import { NODE_TYPE_COLORS, DEFAULT_NODE_COLOR, nodeLabel as getNodeLabel } from './graphStyles'

// ---------------------------------------------------------------------------
// Data types for the force-graph
// ---------------------------------------------------------------------------
interface FGNode {
  id: string
  group: string
  color: string
  degree: number
  name: string
}

interface FGLink {
  source: string
  target: string
}

interface FGData {
  nodes: FGNode[]
  links: FGLink[]
}

// Shared geometries & materials — one per color, instanced for performance
const sphereGeo = new THREE.SphereGeometry(0.5, 8, 8)
const materialCache = new Map<string, THREE.MeshBasicMaterial>()

function getMaterial(color: string): THREE.MeshBasicMaterial {
  let mat = materialCache.get(color)
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    materialCache.set(color, mat)
  }
  return mat
}

// ---------------------------------------------------------------------------
// AmbientView — purely visual 3D force graph
// ---------------------------------------------------------------------------
const AmbientView: React.FC = () => {
  const fgRef = useRef<any>(null)
  const angleRef = useRef(0)
  const distanceRef = useRef(200)
  const heightRef = useRef(60)
  const animRef = useRef<number>(0)
  const keysRef = useRef(new Set<string>())
  const userControlRef = useRef(false) // true while user is pressing keys
  const hoverNodeRef = useRef<FGNode | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = React.useState({ width: 800, height: 600 })

  const graphData = useAppStore((s) => s.graphData)

  // Observe container size
  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setDimensions({ width: Math.floor(width), height: Math.floor(height) })
    })
    observer.observe(el)
    setDimensions({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  // Transform GraphSnapshot -> ForceGraph data
  const fgData: FGData = useMemo(() => {
    const nodeIdSet = new Set(graphData.nodes.map((n) => n.node_id))

    // Pre-compute degree (number of connected edges) per node
    const degreeMap = new Map<string, number>()
    for (const e of graphData.edges) {
      if (nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id)) {
        degreeMap.set(e.source_node_id, (degreeMap.get(e.source_node_id) ?? 0) + 1)
        degreeMap.set(e.target_node_id, (degreeMap.get(e.target_node_id) ?? 0) + 1)
      }
    }

    return {
      nodes: graphData.nodes.map((n) => ({
        id: n.node_id,
        group: n.node_type,
        color: NODE_TYPE_COLORS[n.node_type] ?? DEFAULT_NODE_COLOR,
        degree: degreeMap.get(n.node_id) ?? 0,
        name: getNodeLabel(n),
      })),
      links: graphData.edges
        .filter((e) => nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id))
        .map((e) => ({
          source: e.source_node_id,
          target: e.target_node_id,
        })),
    }
  }, [graphData])

  // Custom node rendering — glowing spheres sized by connectivity
  const nodeThreeObject = useCallback((node: any) => {
    const fgNode = node as FGNode
    const color = fgNode.color || DEFAULT_NODE_COLOR
    const mesh = new THREE.Mesh(sphereGeo, getMaterial(color))

    const group = new THREE.Group()
    group.add(mesh)

    // Base scale from node type importance
    const typeScale = fgNode.group === 'CoBeing' ? 4
      : fgNode.group === 'PrimitiveSymbol' ? 2.5
      : fgNode.group === 'DriveCategory' ? 2
      : fgNode.group === 'ActionProcedure' ? 1.8
      : fgNode.group === 'ConceptPrimitive' ? 1.6
      : fgNode.group === 'PhraseNode' ? 1.3
      : 1

    // Degree-based scaling: sqrt to dampen explosion on hub nodes.
    // 0 edges = 1x, 5 edges = ~1.5x, 20 edges = ~2.2x, 100 edges = ~3.6x
    const degreeScale = 1 + Math.sqrt(fgNode.degree) * 0.25

    group.scale.setScalar(typeScale * degreeScale)
    return group
  }, [])

  // Hover handler — highlight node + pause orbit
  const handleNodeHover = useCallback((node: any) => {
    const fgNode = node as FGNode | null
    const prev = hoverNodeRef.current
    hoverNodeRef.current = fgNode

    // Restore previous node
    if (prev && fgRef.current) {
      const prevObj = fgRef.current.scene().getObjectByName(`node-${prev.id}`)
      if (prevObj) prevObj.scale.setScalar(1)
    }

    // Scale up hovered node
    if (fgNode && fgRef.current) {
      const obj = fgRef.current.scene().getObjectByName(`node-${fgNode.id}`)
      if (obj) obj.scale.setScalar(1.4)
    }

    // Change cursor
    if (containerRef.current) {
      containerRef.current.style.cursor = fgNode ? 'pointer' : 'default'
    }
  }, [])

  // HTML tooltip content
  const nodeTooltip = useCallback((node: any) => {
    const fgNode = node as FGNode
    return `<div style="
      background: rgba(10,14,23,0.9);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      padding: 6px 10px;
      font-family: -apple-system, sans-serif;
      font-size: 11px;
      color: #E0E0E0;
      pointer-events: none;
      max-width: 200px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    ">
      <div style="font-weight:600; color:${fgNode.color}; margin-bottom:2px;">
        ${fgNode.name}
      </div>
      <div style="font-size:9px; color:rgba(255,255,255,0.4);">
        ${fgNode.group}${fgNode.degree > 0 ? ` &middot; ${fgNode.degree} edges` : ''}
      </div>
    </div>`
  }, [])

  // Configure d3 forces for a denser layout
  useEffect(() => {
    if (!fgRef.current) return
    const fg = fgRef.current
    // Stronger charge pulls nodes together; default is -30
    fg.d3Force('charge')?.strength(-15)
    // Shorter link distance keeps connected nodes close
    fg.d3Force('link')?.distance(20)
    // Add a gentle centering force so the graph doesn't drift
    fg.d3Force('center')?.strength(0.05)
  }, [fgData])

  // WASD keyboard controls
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if ('wasdqe'.includes(key)) {
        keysRef.current.add(key)
        userControlRef.current = true
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keysRef.current.delete(key)
      if (keysRef.current.size === 0) userControlRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // Camera loop: auto-orbit + WASD
  useEffect(() => {
    const animate = () => {
      const keys = keysRef.current
      const speed = 1.8

      // WASD: A/D = orbit left/right, W/S = zoom in/out, Q/E = altitude
      if (keys.has('a')) angleRef.current -= 0.02 * speed
      if (keys.has('d')) angleRef.current += 0.02 * speed
      if (keys.has('w')) distanceRef.current = Math.max(40, distanceRef.current - 2 * speed)
      if (keys.has('s')) distanceRef.current = Math.min(600, distanceRef.current + 2 * speed)
      if (keys.has('q')) heightRef.current -= 2 * speed
      if (keys.has('e')) heightRef.current += 2 * speed

      // Slow auto-orbit when user isn't pressing keys and not hovering
      if (!userControlRef.current && !hoverNodeRef.current) {
        angleRef.current += 0.0015
      }

      const dist = distanceRef.current
      const h = heightRef.current
      if (fgRef.current) {
        fgRef.current.cameraPosition({
          x: dist * Math.sin(angleRef.current),
          z: dist * Math.cos(angleRef.current),
          y: h + 20 * Math.sin(angleRef.current * 0.3),
        })
      }
      animRef.current = requestAnimationFrame(animate)
    }
    animRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  return (
    <Box
      ref={containerRef}
      sx={{
        width: '100%',
        height: '100%',
        bgcolor: '#0a0e17',
        overflow: 'hidden',
      }}
    >
      <ForceGraph3D
        ref={fgRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={fgData}
        backgroundColor="#0a0e17"
        nodeThreeObject={nodeThreeObject}
        nodeThreeObjectExtend={false}
        nodeLabel={nodeTooltip}
        onNodeHover={handleNodeHover}
        linkColor={() => 'rgba(120,144,156,0.15)'}
        linkWidth={0.3}
        linkOpacity={0.15}
        enableNodeDrag={false}
        enableNavigationControls={false}
        showNavInfo={false}
        warmupTicks={100}
        cooldownTicks={300}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        d3AlphaMin={0.005}
        nodeRelSize={3}
      />
    </Box>
  )
}

export default AmbientView
