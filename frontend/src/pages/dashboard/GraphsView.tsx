import React, { useEffect } from 'react'
import { Box, LinearProgress, Typography } from '@mui/material'
import {
  AccountTree as AccountTreeIcon,
  Person as PersonIcon,
  Psychology as PsychologyIcon,
} from '@mui/icons-material'
import { GraphPanel } from '../../components/Graph/GraphPanel'
import { MiniGraphPanel } from '../../components/Graph/MiniGraphPanel'
import { useAppStore } from '../../store'
import { useProgressiveSnapshot } from '../../hooks/useProgressiveSnapshot'

// ---------------------------------------------------------------------------
// Shared glass-panel style for the new dashboard views
// ---------------------------------------------------------------------------
const GlassPanel: React.FC<{
  children: React.ReactNode
  sx?: Record<string, unknown>
}> = ({ children, sx }) => (
  <Box
    sx={{
      bgcolor: 'rgba(255,255,255,0.03)',
      borderRadius: 2,
      border: '1px solid rgba(184,217,198,0.12)',
      boxSizing: 'border-box',
      position: 'relative',
      overflow: 'hidden',
      ...sx,
    }}
  >
    {children}
  </Box>
)

// ---------------------------------------------------------------------------
// Panel header — label with icon and optional count + progress bar
// ---------------------------------------------------------------------------
const PanelHeader: React.FC<{
  icon: React.ReactNode
  label: string
  color: string
  nodeCount?: number
  edgeCount?: number
  progress?: number
  loading?: boolean
  status?: string
}> = ({ icon, label, color, nodeCount, edgeCount, progress, loading, status }) => (
  <Box
    sx={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 5,
      pointerEvents: 'none',
    }}
  >
    {/* Loading bar — thin, spans full width */}
    {loading && progress != null && progress < 1 && (
      <LinearProgress
        variant="determinate"
        value={progress * 100}
        sx={{
          height: 2,
          bgcolor: 'transparent',
          '& .MuiLinearProgress-bar': {
            bgcolor: color,
            transition: 'transform 0.3s ease',
          },
        }}
      />
    )}
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.25,
        position: 'absolute',
        top: loading ? 4 : 8,
        right: 12,
        borderRadius: 1,
        bgcolor: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{ color, display: 'flex', '& .MuiSvgIcon-root': { fontSize: '0.75rem' } }}>
        {icon}
      </Box>
      <Typography
        sx={{
          fontSize: '0.6rem',
          fontWeight: 600,
          color: 'rgba(255,255,255,0.5)',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Typography>
      {nodeCount != null && (
        <Typography sx={{ fontSize: '0.55rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>
          {nodeCount}n {edgeCount ?? 0}e
        </Typography>
      )}
      {loading && status && (
        <Typography sx={{ fontSize: '0.5rem', fontFamily: 'monospace', color: `${color}90` }}>
          {status}
        </Typography>
      )}
    </Box>
  </Box>
)

// ---------------------------------------------------------------------------
// GraphsView — uses progressive loading for OKG/SKG
// WKG continues to use the WebSocket-based GraphPanel.
// ---------------------------------------------------------------------------
export const GraphsView: React.FC = () => {
  // Progressive loading for OKG and SKG (poll every 15s)
  const okg = useProgressiveSnapshot('okg', 15_000)
  const skg = useProgressiveSnapshot('skg', 15_000)

  // Push progressive data into the store so other components can access it
  const setOkgData = useAppStore((s) => s.setOkgData)
  const setOkgStats = useAppStore((s) => s.setOkgStats)
  const setSkgData = useAppStore((s) => s.setSkgData)
  const setSkgStats = useAppStore((s) => s.setSkgStats)

  useEffect(() => {
    if (okg.data) {
      setOkgData(okg.data)
      setOkgStats({ nodes: okg.data.nodes.length, edges: okg.data.edges.length })
    }
  }, [okg.data, setOkgData, setOkgStats])

  useEffect(() => {
    if (skg.data) {
      setSkgData(skg.data)
      setSkgStats({ nodes: skg.data.nodes.length, edges: skg.data.edges.length })
    }
  }, [skg.data, setSkgData, setSkgStats])

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.5,
        boxSizing: 'border-box',
      }}
    >
      {/* WKG — hero panel, takes ~62% of height */}
      <GlassPanel sx={{ flex: 5, minHeight: 0 }}>
        <PanelHeader
          icon={<AccountTreeIcon />}
          label="World Knowledge Graph"
          color="#64B5F6"
        />
        <Box sx={{ width: '100%', height: '100%' }}>
          <GraphPanel />
        </Box>
      </GlassPanel>

      {/* OKG + SKG — two equal panels below */}
      <Box sx={{ flex: 3, display: 'flex', gap: 1, minHeight: 0 }}>
        {/* Other Knowledge Graph (Neo4j OTHER — person models) */}
        <GlassPanel sx={{ flex: 1 }}>
          <PanelHeader
            icon={<PersonIcon />}
            label="Other KG"
            color="#CE93D8"
            nodeCount={okg.totalNodes}
            edgeCount={okg.totalEdges}
            progress={okg.progress}
            loading={okg.loading}
            status={okg.status}
          />
          <Box sx={{ width: '100%', height: '100%' }}>
            <MiniGraphPanel
              data={okg.data ?? { nodes: [], edges: [] }}
              accentColor="#CE93D8"
              emptyMessage={okg.loading ? 'Loading...' : 'No person model data yet. Start a conversation to build the Other Knowledge Graph.'}
            />
          </Box>
        </GlassPanel>

        {/* Self Knowledge Graph (Neo4j SELF — Sylphie's self-model) */}
        <GlassPanel sx={{ flex: 1 }}>
          <PanelHeader
            icon={<PsychologyIcon />}
            label="Self KG"
            color="#FFB74D"
            nodeCount={skg.totalNodes}
            edgeCount={skg.totalEdges}
            progress={skg.progress}
            loading={skg.loading}
            status={skg.status}
          />
          <Box sx={{ width: '100%', height: '100%' }}>
            <MiniGraphPanel
              data={skg.data ?? { nodes: [], edges: [] }}
              accentColor="#FFB74D"
              emptyMessage={skg.loading ? 'Loading...' : 'No self-model data yet. Teach Sylphie about herself to build the Self Knowledge Graph.'}
            />
          </Box>
        </GlassPanel>
      </Box>
    </Box>
  )
}
