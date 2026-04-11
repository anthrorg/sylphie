import React from 'react'
import { Box, Typography } from '@mui/material'
import { useAppStore } from '../../store'
import type { WkgViewMode } from '../../types'

const modes: Array<{ key: WkgViewMode; label: string }> = [
  { key: 'ambient', label: 'Ambient' },
  { key: 'explorer', label: 'Explorer' },
]

export const WkgViewSwitcher: React.FC = () => {
  const { wkgViewMode, setWkgViewMode } = useAppStore()

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 10,
        display: 'flex',
        gap: 0.25,
        borderRadius: 1,
        bgcolor: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        p: '2px',
        pointerEvents: 'auto',
      }}
    >
      {modes.map(({ key, label }) => {
        const isActive = wkgViewMode === key
        return (
          <Box
            key={key}
            onClick={() => setWkgViewMode(key)}
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: 0.5,
              cursor: 'pointer',
              bgcolor: isActive ? 'rgba(100,181,246,0.18)' : 'transparent',
              transition: 'background-color 0.15s',
              '&:hover': { bgcolor: isActive ? 'rgba(100,181,246,0.22)' : 'rgba(255,255,255,0.05)' },
            }}
          >
            <Typography
              sx={{
                fontSize: '0.6rem',
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: isActive ? '#64B5F6' : 'rgba(255,255,255,0.35)',
                transition: 'color 0.15s',
              }}
            >
              {label}
            </Typography>
          </Box>
        )
      })}
    </Box>
  )
}
