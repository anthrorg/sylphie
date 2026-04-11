import React, { useCallback, useState } from 'react'
import { Box, Chip, CircularProgress, Typography } from '@mui/material'
import {
  WarningAmber as WarningIcon,
  TravelExplore as ExploreIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useNeighborhood } from '../../hooks/useNeighborhood'
import { ExplorerSearchBar } from './ExplorerSearchBar'
import { ExplorerGraphPanel } from './ExplorerGraphPanel'
import { ExplorerBreadcrumbs } from './ExplorerBreadcrumbs'

export const ExplorerView: React.FC = () => {
  const [centerNodeId, setCenterNodeId] = useState<string | null>(null)
  const [centerNodeType, setCenterNodeType] = useState<string | undefined>()
  const { explorerDepth, pushExplorerHistory, explorerHistory } = useAppStore()
  const { data, loading, truncated } = useNeighborhood(centerNodeId, explorerDepth)

  const handleNodeSelect = useCallback(
    (nodeId: string, label: string) => {
      setCenterNodeId(nodeId)
      pushExplorerHistory(nodeId, label)
      const node = data?.nodes.find((n) => n.node_id === nodeId)
      setCenterNodeType(node?.node_type)
    },
    [pushExplorerHistory, data],
  )

  const handleDrill = useCallback(
    (nodeId: string) => {
      const node = data?.nodes.find((n) => n.node_id === nodeId)
      const label = node?.label || nodeId
      setCenterNodeId(nodeId)
      pushExplorerHistory(nodeId, label)
      setCenterNodeType(node?.node_type)
    },
    [pushExplorerHistory, data],
  )

  const handleBreadcrumbNav = useCallback(
    (nodeId: string, _label: string) => {
      setCenterNodeId(nodeId)
      const idx = explorerHistory.findIndex((e) => e.nodeId === nodeId)
      if (idx >= 0) {
        const store = useAppStore.getState()
        for (let i = explorerHistory.length - 1; i > idx; i--) {
          store.popExplorerHistory()
        }
      }
    },
    [explorerHistory],
  )

  return (
    <Box sx={{ height: '100%', position: 'relative' }}>
      {/* ── Graph area (full size) ─────────────────────────────── */}
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 5,
            bgcolor: 'rgba(26,26,46,0.7)',
          }}
        >
          <CircularProgress size={24} sx={{ color: 'rgba(255,255,255,0.4)' }} />
        </Box>
      )}

      {!centerNodeId && !loading && (
        <Box
          sx={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            color: 'rgba(255,255,255,0.3)',
          }}
        >
          <ExploreIcon sx={{ fontSize: 40, opacity: 0.3 }} />
          <Typography sx={{ fontSize: '0.8rem' }}>
            Search for a node to explore its neighborhood
          </Typography>
          <Typography sx={{ fontSize: '0.65rem', opacity: 0.5 }}>
            Double-click nodes to drill deeper
          </Typography>
        </Box>
      )}

      {centerNodeId && data && data.nodes.length > 0 && (
        <ExplorerGraphPanel
          data={data}
          centerNodeId={centerNodeId}
          onNodeSelect={handleDrill}
        />
      )}

      {centerNodeId && data && data.nodes.length === 0 && !loading && (
        <Box
          sx={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.3)',
            fontSize: '0.8rem',
          }}
        >
          No neighborhood found for this node.
        </Box>
      )}

      {/* ── Floating control panel ─────────────────────────────── */}
      <Box
        sx={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          zIndex: 10,
          width: 220,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
          p: 1.25,
          borderRadius: 2,
          bgcolor: 'rgba(10,14,23,0.85)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
        }}
      >
        <ExplorerSearchBar onNodeSelect={handleNodeSelect} />

        {/* Stats row */}
        {data && centerNodeId && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            <Chip
              label={`${data.nodes.length}n`}
              size="small"
              sx={{
                fontSize: '0.55rem',
                height: 16,
                bgcolor: 'rgba(100,181,246,0.12)',
                color: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(100,181,246,0.2)',
                '& .MuiChip-label': { px: 0.5 },
              }}
            />
            <Chip
              label={`${data.edges.length}e`}
              size="small"
              sx={{
                fontSize: '0.55rem',
                height: 16,
                bgcolor: 'rgba(100,181,246,0.12)',
                color: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(100,181,246,0.2)',
                '& .MuiChip-label': { px: 0.5 },
              }}
            />
            {truncated && (
              <Chip
                icon={<WarningIcon sx={{ fontSize: 9 }} />}
                label="500 cap"
                size="small"
                sx={{
                  fontSize: '0.55rem',
                  height: 16,
                  bgcolor: 'rgba(255,152,0,0.15)',
                  color: '#FFB74D',
                  border: '1px solid rgba(255,152,0,0.3)',
                  '& .MuiChip-label': { px: 0.5 },
                }}
              />
            )}
          </Box>
        )}

        {/* History */}
        {explorerHistory.length > 0 && (
          <Box>
            <Typography
              sx={{
                fontSize: '0.5rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: 'rgba(255,255,255,0.2)',
                mb: 0.25,
              }}
            >
              History
            </Typography>
            <ExplorerBreadcrumbs
              onNavigate={handleBreadcrumbNav}
              currentNodeType={centerNodeType}
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}
