// ---------------------------------------------------------------------------
// VerdictCard — displays a single supervisor verdict with color-coded rating,
// confidence bar, reasoning text, and optional flag banner.
// ---------------------------------------------------------------------------

import React from 'react'
import { Box, Chip, Typography, Tooltip } from '@mui/material'
import { Warning as WarningIcon } from '@mui/icons-material'
import { SupervisorVerdict, VerdictRating } from '../../store/supervisorSlice'

// ---------------------------------------------------------------------------
// Rating colour map
// ---------------------------------------------------------------------------

const RATING_COLORS: Record<VerdictRating, { border: string; chip: 'success' | 'warning' | 'default' | 'error'; chipLabel: string }> = {
  good:         { border: '#66BB6A', chip: 'success',  chipLabel: 'GOOD' },
  acceptable:   { border: '#FFB74D', chip: 'warning',  chipLabel: 'ACCEPTABLE' },
  questionable: { border: '#FF8A65', chip: 'default',  chipLabel: 'QUESTIONABLE' },
  wrong:        { border: '#EF5350', chip: 'error',    chipLabel: 'WRONG' },
}

// Chip for 'questionable' needs manual colour since MUI doesn't have 'orange'
const QUESTIONABLE_CHIP_SX = {
  bgcolor: 'rgba(255,138,101,0.2)',
  color: '#FF8A65',
  borderColor: '#FF8A65',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VerdictCardProps {
  verdict: SupervisorVerdict
}

export const VerdictCard: React.FC<VerdictCardProps> = ({ verdict }) => {
  const meta = RATING_COLORS[verdict.rating] ?? RATING_COLORS.questionable
  const ts = new Date(verdict.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const confidencePct = Math.round(verdict.confidence * 100)

  return (
    <Box
      sx={{
        borderLeft: `3px solid ${meta.border}`,
        borderRadius: '0 4px 4px 0',
        bgcolor: 'rgba(0,0,0,0.18)',
        p: 1,
        mb: 0.75,
      }}
    >
      {/* Top row: rating chip + timestamp + cost */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        {verdict.rating === 'questionable' ? (
          <Chip
            label={meta.chipLabel}
            size="small"
            variant="outlined"
            sx={{ ...QUESTIONABLE_CHIP_SX, fontSize: '0.6rem', height: 20 }}
          />
        ) : (
          <Chip
            label={meta.chipLabel}
            color={meta.chip}
            size="small"
            sx={{ fontSize: '0.6rem', height: 20 }}
          />
        )}

        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.6rem', fontFamily: 'monospace' }}>
          {ts}
        </Typography>

        <Box sx={{ flex: 1 }} />

        <Tooltip title={`${verdict.inputTokens} in / ${verdict.outputTokens} out`}>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.58rem', fontFamily: 'monospace' }}>
            ${verdict.costUsd.toFixed(4)}
          </Typography>
        </Tooltip>
      </Box>

      {/* Confidence bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.58rem', minWidth: 60 }}>
          conf {confidencePct}%
        </Typography>
        <Box
          sx={{
            flex: 1,
            height: 4,
            bgcolor: 'rgba(255,255,255,0.08)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              width: `${confidencePct}%`,
              height: '100%',
              bgcolor: meta.border,
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </Box>
      </Box>

      {/* Reasoning */}
      <Typography
        variant="caption"
        sx={{
          color: 'rgba(255,255,255,0.65)',
          fontSize: '0.68rem',
          display: 'block',
          lineHeight: 1.4,
          wordBreak: 'break-word',
        }}
      >
        {verdict.reasoning}
      </Typography>

      {/* Flag banner — only shown when flagForGuardian is true */}
      {verdict.flagForGuardian && (
        <Box
          sx={{
            mt: 0.5,
            px: 1,
            py: 0.375,
            bgcolor: 'rgba(239,83,80,0.12)',
            border: '1px solid rgba(239,83,80,0.3)',
            borderRadius: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
          }}
        >
          <WarningIcon sx={{ fontSize: 13, color: '#EF5350' }} />
          <Typography
            variant="caption"
            sx={{ color: '#EF5350', fontSize: '0.6rem', lineHeight: 1.3 }}
          >
            {verdict.flagReason ?? 'Flagged for guardian review'}
          </Typography>
        </Box>
      )}

      {/* Cycle ID — small, monospace, dimmed */}
      <Typography
        variant="caption"
        sx={{
          mt: 0.25,
          display: 'block',
          color: 'rgba(255,255,255,0.15)',
          fontSize: '0.55rem',
          fontFamily: 'monospace',
        }}
      >
        {verdict.cycleId}
      </Typography>
    </Box>
  )
}
