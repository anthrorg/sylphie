import React from 'react'
import { Box } from '@mui/material'
import { ConversationPanel } from '../../components/Conversation/ConversationPanel'
import { AudioPanel } from '../../components/Audio/AudioPanel'
import { CameraPanel } from '../../components/Camera/CameraPanel'
import { RecognitionChips } from '../../components/Camera/RecognitionChips'
import { MiniDriveChart } from '../../components/Drives/MiniDriveChart'

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

      {/* Main content: conversation + camera column */}
      <Box sx={{ flex: 1, display: 'flex', gap: 1, minHeight: 0 }}>
        {/* Conversation */}
        <Box
          sx={{
            flex: 1,
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

        {/* Camera column: feed + recognition chips */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minHeight: 0,
          }}
        >
          {/* Camera feed */}
          <Box
            sx={{
              flex: 3,
              borderRadius: 2,
              border: '1px solid rgba(184,217,198,0.12)',
              bgcolor: 'rgba(255,255,255,0.03)',
              overflow: 'hidden',
              minHeight: 0,
            }}
          >
            <CameraPanel />
          </Box>

          {/* Recognition chips + mini drive chart */}
          <Box sx={{ flex: 1, display: 'flex', gap: 1, minHeight: 0 }}>
            <Box
              sx={{
                flex: 1,
                borderRadius: 2,
                border: '1px solid rgba(184,217,198,0.12)',
                bgcolor: 'rgba(255,255,255,0.03)',
                overflow: 'hidden',
                minHeight: 0,
              }}
            >
              <RecognitionChips />
            </Box>
            <Box
              sx={{
                flex: 1,
                borderRadius: 2,
                border: '1px solid rgba(184,217,198,0.12)',
                bgcolor: 'rgba(255,255,255,0.03)',
                overflow: 'hidden',
                minHeight: 0,
              }}
            >
              <MiniDriveChart />
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
