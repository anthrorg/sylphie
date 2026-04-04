import React, { useCallback } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import {
  Fullscreen as ExpandIcon,
  FullscreenExit as CollapseIcon,
  VideocamOff as VideocamOffIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { usePerception } from '../../hooks/usePerception'

export const CameraPanel: React.FC = () => {
  const { cameraState, setCameraState } = useAppStore()
  const { canvasRef, active, error } = usePerception()

  const isPip = cameraState.mode === 'pip'

  const handleExpand = useCallback(() => {
    setCameraState({ mode: 'main' })
  }, [setCameraState])

  const handleCollapse = useCallback(() => {
    setCameraState({ mode: 'pip' })
  }, [setCameraState])

  // ---------------------------------------------------------------------------
  // Feed content — canvas with annotated YOLO frames, or unavailable placeholder
  // ---------------------------------------------------------------------------

  const feedContent = (() => {
    if (active) {
      return (
        <canvas
          ref={canvasRef as React.RefObject<HTMLCanvasElement>}
          style={{
            width: '100%',
            height: '100%',
            objectFit: isPip ? 'cover' : 'contain',
            display: 'block',
          }}
        />
      )
    }

    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          bgcolor: '#2a2a3e',
          color: 'rgba(255,255,255,0.5)',
          gap: 1,
        }}
      >
        <VideocamOffIcon sx={{ fontSize: isPip ? 32 : 48 }} />
        <Typography variant={isPip ? 'caption' : 'body2'}>
          {error || 'Camera Not Available'}
        </Typography>
      </Box>
    )
  })()

  // ---------------------------------------------------------------------------
  // PIP layout
  // ---------------------------------------------------------------------------

  if (isPip) {
    return (
      <Box
        onClick={active ? handleExpand : undefined}
        sx={{
          position: 'absolute',
          bottom: 16,
          left: 16,
          width: 200,
          height: 150,
          borderRadius: 2,
          overflow: 'hidden',
          boxShadow: 3,
          zIndex: 10,
          cursor: active ? 'pointer' : 'default',
          bgcolor: '#1a1a2e',
          ...(active ? { '&:hover': { boxShadow: 6 } } : {}),
        }}
      >
        {feedContent}
        {active && (
          <IconButton
            onClick={(e) => {
              e.stopPropagation()
              handleExpand()
            }}
            size="small"
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              bgcolor: 'rgba(0,0,0,0.5)',
              color: 'white',
              padding: '2px',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' },
            }}
          >
            <ExpandIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
    )
  }

  // ---------------------------------------------------------------------------
  // Main layout
  // ---------------------------------------------------------------------------

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: '#1a1a2e' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 0.5,
          bgcolor: '#111827',
          minHeight: 40,
        }}
      >
        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.8)' }}>
          Camera Feed {active ? '(YOLO)' : ''}
        </Typography>
        <IconButton
          onClick={handleCollapse}
          size="small"
          sx={{
            color: 'white',
            '&:hover': { bgcolor: 'rgba(255,255,255,0.1)' },
          }}
        >
          <CollapseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {feedContent}
      </Box>
    </Box>
  )
}
