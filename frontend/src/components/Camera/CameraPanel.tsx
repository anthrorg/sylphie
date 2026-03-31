import React, { useCallback } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import {
  Fullscreen as ExpandIcon,
  FullscreenExit as CollapseIcon,
  VideocamOff as VideocamOffIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useWebRTC } from '../../hooks/useWebRTC'

// MJPEG stream endpoint (served by the backend camera controller)
const MJPEG_STREAM_URL = '/api/camera/stream'

export const CameraPanel: React.FC = () => {
  const { cameraState, setCameraState } = useAppStore()

  // Attempt getUserMedia on mount via autoConnect.
  // The hook sets feedMode='local' on success, feedMode='mjpeg' on getUserMedia failure.
  const { localVideoRef } = useWebRTC({ video: true, audio: false, autoConnect: true })

  const isPip = cameraState.mode === 'pip'

  const handleExpand = useCallback(() => {
    setCameraState({ mode: 'main' })
  }, [setCameraState])

  const handleCollapse = useCallback(() => {
    setCameraState({ mode: 'pip' })
  }, [setCameraState])

  // When the MJPEG <img> produces a network error, mark total failure.
  const handleMjpegError = useCallback(() => {
    setCameraState({ active: false, feedMode: 'unavailable' })
  }, [setCameraState])

  // When the MJPEG <img> delivers its first frame, the feed is live.
  const handleMjpegLoad = useCallback(() => {
    setCameraState({ active: true })
  }, [setCameraState])

  // ---------------------------------------------------------------------------
  // Sub-renderers — each returns the inner feed element sized to fill its parent
  // ---------------------------------------------------------------------------

  const feedContent = (() => {
    switch (cameraState.feedMode) {
      case 'local':
        return (
          <video
            ref={localVideoRef as React.RefObject<HTMLVideoElement>}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )

      case 'mjpeg':
        return (
          <img
            src={MJPEG_STREAM_URL}
            alt="Camera feed"
            onError={handleMjpegError}
            onLoad={handleMjpegLoad}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )

      default:
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
            <Typography variant={isPip ? 'caption' : 'body2'}>Camera Not Available</Typography>
          </Box>
        )
    }
  })()

  const hasFeed = cameraState.feedMode !== 'unavailable'

  // ---------------------------------------------------------------------------
  // PIP layout
  // ---------------------------------------------------------------------------

  if (isPip) {
    return (
      <Box
        onClick={hasFeed ? handleExpand : undefined}
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
          cursor: hasFeed ? 'pointer' : 'default',
          bgcolor: '#1a1a2e',
          ...(hasFeed ? { '&:hover': { boxShadow: 6 } } : {}),
        }}
      >
        {feedContent}
        {hasFeed && (
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

  const modeLabel =
    cameraState.feedMode === 'local'
      ? 'Camera Feed (Local)'
      : cameraState.feedMode === 'mjpeg'
        ? 'Camera Feed (MJPEG)'
        : 'Camera Feed'

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
          {modeLabel}
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
          // For the main panel the feed should be contained (letterboxed), not cropped.
          // Override the cover sizing used in feedContent for PIP.
        }}
      >
        {cameraState.feedMode === 'local' && (
          <video
            ref={localVideoRef as React.RefObject<HTMLVideoElement>}
            autoPlay
            playsInline
            muted
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        )}
        {cameraState.feedMode === 'mjpeg' && (
          <img
            src={MJPEG_STREAM_URL}
            alt="Camera feed"
            onError={handleMjpegError}
            onLoad={handleMjpegLoad}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        )}
        {cameraState.feedMode === 'unavailable' && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              width: '100%',
              bgcolor: '#2a2a3e',
              color: 'rgba(255,255,255,0.5)',
              gap: 1,
            }}
          >
            <VideocamOffIcon sx={{ fontSize: 48 }} />
            <Typography variant="body2">Camera Not Available</Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}
