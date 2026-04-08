import React from 'react'
import { Box, Chip, Typography } from '@mui/material'
import {
  Visibility as EyeIcon,
  Face as FaceIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'

export const RecognitionChips: React.FC = () => {
  const recognizedItems = useAppStore((s) => s.recognizedItems)

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          flexShrink: 0,
        }}
      >
        <EyeIcon sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.35)' }} />
        <Typography
          sx={{
            fontSize: '0.65rem',
            fontWeight: 700,
            color: 'rgba(255,255,255,0.35)',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          Recognized
        </Typography>
      </Box>

      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5,
          p: 1,
          alignContent: 'flex-start',
        }}
      >
        {recognizedItems.length === 0 ? (
          <Typography
            variant="caption"
            sx={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.2)',
              fontStyle: 'italic',
              width: '100%',
              textAlign: 'center',
              mt: 1,
            }}
          >
            Nothing detected yet
          </Typography>
        ) : (
          recognizedItems.map((item) => {
            const isUnknown = item.discovered !== true
            const isFace = item.type === 'face'

            // Color scheme: known = green/blue, unknown = orange/amber
            let bgcolor: string
            let textColor: string
            let borderColor: string

            if (isUnknown) {
              bgcolor = isFace ? 'rgba(255, 152, 0, 0.15)' : 'rgba(255, 183, 77, 0.12)'
              textColor = isFace ? '#FFB74D' : '#FFB74D'
              borderColor = isFace ? 'rgba(255, 152, 0, 0.35)' : 'rgba(255, 183, 77, 0.25)'
            } else if (isFace) {
              bgcolor = 'rgba(0, 191, 255, 0.15)'
              textColor = '#00bfff'
              borderColor = 'rgba(0, 191, 255, 0.3)'
            } else {
              bgcolor = 'rgba(0, 255, 0, 0.1)'
              textColor = '#81C784'
              borderColor = 'rgba(0, 255, 0, 0.2)'
            }

            // Duration suffix for stable items
            let suffix = ''
            if (item.duration && item.duration > 5000) {
              const secs = Math.floor(item.duration / 1000)
              suffix = secs >= 60 ? ` ${Math.floor(secs / 60)}m` : ` ${secs}s`
            }

            return (
              <Chip
                key={item.id}
                icon={
                  isFace ? (
                    <FaceIcon sx={{ fontSize: '0.75rem !important' }} />
                  ) : undefined
                }
                label={`${item.label}${suffix}`}
                size="small"
                sx={{
                  height: 22,
                  fontSize: '0.65rem',
                  fontWeight: 500,
                  bgcolor,
                  color: textColor,
                  borderColor,
                  border: '1px solid',
                  // Pulse animation for undiscovered items
                  ...(isUnknown ? {
                    animation: 'pulse 2s ease-in-out infinite',
                    '@keyframes pulse': {
                      '0%, 100%': { opacity: 1 },
                      '50%': { opacity: 0.6 },
                    },
                  } : {}),
                  '& .MuiChip-icon': {
                    color: 'inherit',
                  },
                }}
              />
            )
          })
        )}
      </Box>
    </Box>
  )
}
