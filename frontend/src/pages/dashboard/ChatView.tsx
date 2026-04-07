import React from 'react'
import { Box } from '@mui/material'
import { ConversationPanel } from '../../components/Conversation/ConversationPanel'
import { AudioPanel } from '../../components/Audio/AudioPanel'
import { CameraPanel } from '../../components/Camera/CameraPanel'

// ---------------------------------------------------------------------------
// ChatView — full-height conversation with audio strip and camera sidebar
// ---------------------------------------------------------------------------
export const ChatView: React.FC = () => {
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
      {/* Audio strip — always-on mic stream + FFT visualization */}
      <Box
        sx={{
          flexShrink: 0,
          borderRadius: 2,
          border: '1px solid rgba(184,217,198,0.12)',
          bgcolor: 'rgba(255,255,255,0.03)',
          overflow: 'hidden',
        }}
      >
        <AudioPanel />
      </Box>

      {/* Main content: conversation + camera sidebar */}
      <Box sx={{ flex: 1, display: 'flex', gap: 1, minHeight: 0 }}>
        {/* Conversation — takes most of the space */}
        <Box
          sx={{
            flex: 3,
            borderRadius: 2,
            border: '1px solid rgba(184,217,198,0.12)',
            bgcolor: 'rgba(255,255,255,0.03)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ConversationPanel />
        </Box>

        {/* Camera panel — sidebar position */}
        <Box
          sx={{
            flex: 1,
            maxWidth: 360,
            borderRadius: 2,
            border: '1px solid rgba(184,217,198,0.12)',
            bgcolor: 'rgba(255,255,255,0.03)',
            overflow: 'hidden',
          }}
        >
          <CameraPanel />
        </Box>
      </Box>
    </Box>
  )
}
