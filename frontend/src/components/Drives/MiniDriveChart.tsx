import React from 'react'
import { Box, Typography, Tooltip } from '@mui/material'
import { useAppStore } from '../../store'
import { TelemetryPressure } from '../../types'

const DRIVES: Array<{ key: keyof TelemetryPressure; label: string; core?: boolean }> = [
  { key: 'system_health', label: 'HLT', core: true },
  { key: 'moral_valence', label: 'MRL', core: true },
  { key: 'integrity', label: 'INT', core: true },
  { key: 'cognitive_awareness', label: 'COG', core: true },
  { key: 'guilt', label: 'GLT' },
  { key: 'curiosity', label: 'CUR' },
  { key: 'boredom', label: 'BOR' },
  { key: 'anxiety', label: 'ANX' },
  { key: 'satisfaction', label: 'SAT' },
  { key: 'sadness', label: 'SAD' },
  { key: 'focus', label: 'FOC' },
  { key: 'social', label: 'SOC' },
]

const getBarColor = (value: number): string => {
  if (value < 0) return 'rgba(0, 188, 212, 0.8)'
  if (value < 0.3) return 'rgba(76, 175, 80, 0.8)'
  if (value < 0.6) return 'rgba(255, 152, 0, 0.8)'
  if (value < 0.8) return 'rgba(245, 124, 0, 0.8)'
  return 'rgba(244, 67, 54, 0.8)'
}

export const MiniDriveChart: React.FC = () => {
  const pressure = useAppStore((s) => s.pressure)
  const seq = useAppStore((s) => s.pressureSequenceNumber)

  const hasData = seq > 0

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
        <Typography
          sx={{
            fontSize: '0.65rem',
            fontWeight: 700,
            color: 'rgba(255,255,255,0.35)',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          Drives
        </Typography>
      </Box>

      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          p: 1,
          justifyContent: 'center',
        }}
      >
        {!hasData ? (
          <Typography
            variant="caption"
            sx={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.2)',
              fontStyle: 'italic',
              textAlign: 'center',
            }}
          >
            Waiting for drive data...
          </Typography>
        ) : (
          DRIVES.map(({ key, label, core }) => {
            const raw = pressure[key] ?? 0
            // Map [-10, 1] → [0, 1] for bar width
            const norm = Math.max(0, Math.min(1, (raw + 10) / 11))
            return (
              <Tooltip key={key} title={`${key.replace(/_/g, ' ')}: ${raw.toFixed(3)}`} placement="left" arrow>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Typography
                    sx={{
                      fontSize: '0.55rem',
                      fontFamily: 'monospace',
                      color: core ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)',
                      fontWeight: core ? 600 : 400,
                      width: 22,
                      flexShrink: 0,
                      textAlign: 'right',
                    }}
                  >
                    {label}
                  </Typography>
                  <Box
                    sx={{
                      flex: 1,
                      height: 6,
                      bgcolor: 'rgba(255,255,255,0.04)',
                      borderRadius: 0.5,
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      sx={{
                        width: `${norm * 100}%`,
                        height: '100%',
                        bgcolor: getBarColor(raw),
                        borderRadius: 0.5,
                        transition: 'width 0.3s ease, background-color 0.3s ease',
                      }}
                    />
                  </Box>
                </Box>
              </Tooltip>
            )
          })
        )}
      </Box>
    </Box>
  )
}
