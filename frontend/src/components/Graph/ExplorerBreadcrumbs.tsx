import React from 'react'
import { Box, Chip } from '@mui/material'
import { useAppStore } from '../../store'
import { NODE_TYPE_COLORS, DEFAULT_NODE_COLOR } from './graphStyles'

interface ExplorerBreadcrumbsProps {
  onNavigate: (nodeId: string, label: string) => void
  currentNodeType?: string
}

export const ExplorerBreadcrumbs: React.FC<ExplorerBreadcrumbsProps> = ({
  onNavigate,
  currentNodeType,
}) => {
  const explorerHistory = useAppStore((s) => s.explorerHistory)

  if (explorerHistory.length === 0) return null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, px: 0.5 }}>
      {explorerHistory.map((entry, i) => {
        const isLast = i === explorerHistory.length - 1
        return (
          <Chip
            key={`${entry.nodeId}-${i}`}
            label={entry.label}
            size="small"
            onClick={isLast ? undefined : () => onNavigate(entry.nodeId, entry.label)}
            sx={{
              fontSize: '0.6rem',
              height: 20,
              maxWidth: '100%',
              justifyContent: 'flex-start',
              cursor: isLast ? 'default' : 'pointer',
              bgcolor: isLast
                ? `${NODE_TYPE_COLORS[currentNodeType ?? ''] ?? DEFAULT_NODE_COLOR}30`
                : 'rgba(0,0,0,0.3)',
              color: isLast ? '#fff' : 'rgba(255,255,255,0.5)',
              border: `1px solid ${isLast ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)'}`,
              '& .MuiChip-label': { px: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' },
              '&:hover': isLast ? {} : { bgcolor: 'rgba(255,255,255,0.08)' },
            }}
          />
        )
      })}
    </Box>
  )
}
