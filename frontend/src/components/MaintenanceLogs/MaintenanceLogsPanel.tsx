import React, { useRef, useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import { useAppStore } from '../../store'
import { useAutoScroll } from '../../hooks/useAutoScroll'

/**
 * MaintenanceLogsPanel — shows maintenance_cycle events from the shared
 * telemetry WebSocket stream.
 *
 * Maintenance entries are stored in innerMonologue (InnerMonologueEntry) since
 * the telemetry WS handler routes maintenance_cycle events there with verbatim
 * payloads. This panel filters those entries to display only maintenance events,
 * extracting them from entries whose text starts with "maintenance_cycle:".
 *
 * Separate WebSocket connection removed — we share the telemetry stream.
 */

const LEVEL_COLORS: Record<string, string> = {
  info: '#81C784',
  warn: '#FFB74D',
  error: '#EF5350',
}

interface MaintenanceRow {
  timestamp: string
  text: string
  level: 'info' | 'warn' | 'error'
  rawPayload?: string
}

// Parse a maintenance_cycle verbatim text into structured fields
function parseMaintenanceEntry(text: string, rawPayload?: string): MaintenanceRow {
  // text format: "maintenance_cycle: jobs_run=N committed=N phrase_consolidation=true/false"
  const jobsMatch = text.match(/jobs_run=(\d+)/)
  const committedMatch = text.match(/committed=(\d+)/)
  const phraseMatch = text.match(/phrase_consolidation=(true|false)/)

  const jobsRun = jobsMatch ? parseInt(jobsMatch[1], 10) : 0
  const committed = committedMatch ? parseInt(committedMatch[1], 10) : 0
  const phraseConsolidation = phraseMatch ? phraseMatch[1] === 'true' : false

  let level: 'info' | 'warn' | 'error' = 'warn'
  if (committed > 0) level = 'info'

  const displayText = rawPayload
    ? `maintenance: ${jobsRun} jobs run, ${committed} committed${phraseConsolidation ? ', phrases consolidated' : ''}`
    : text

  return { timestamp: '', text: displayText, level, rawPayload }
}

export const MaintenanceLogsPanel: React.FC = () => {
  const innerMonologue = useAppStore((s) => s.innerMonologue)
  const wsState = useAppStore((s) => s.wsState.telemetry)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Extract only maintenance_cycle entries
  const maintenanceRows: MaintenanceRow[] = useMemo(() => {
    return innerMonologue
      .filter((e) => e.text.startsWith('maintenance_cycle:'))
      .map((e) => ({
        ...parseMaintenanceEntry(e.text, e.rawPayload),
        timestamp: e.timestamp,
      }))
  }, [innerMonologue])

  useAutoScroll(scrollRef, [maintenanceRows.length])

  const connected = wsState === 'connected'

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          borderBottom: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <Typography variant="subtitle2" sx={{ color: '#B0BEC5', flex: 1 }}>
          Maintenance
        </Typography>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: connected ? '#81C784' : '#EF5350',
            flexShrink: 0,
          }}
        />
        <Typography variant="caption" sx={{ fontSize: '0.6rem', color: connected ? '#81C784' : '#EF5350' }}>
          {connected ? 'live' : wsState}
        </Typography>
      </Box>

      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          overflow: 'auto',
          fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
          fontSize: '11px',
          lineHeight: 1.5,
          px: 1,
          py: 0.5,
          bgcolor: '#0d1117',
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.15)', borderRadius: 3 },
        }}
      >
        {maintenanceRows.length === 0 && (
          <Typography
            sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '11px', fontStyle: 'italic', mt: 1 }}
          >
            {connected
              ? 'Connected — waiting for maintenance activity...'
              : `Telemetry ${wsState}...`}
          </Typography>
        )}
        {maintenanceRows.map((row, i) => {
          const time = row.timestamp.slice(11, 19)
          return (
            <Box
              key={i}
              sx={{ display: 'flex', gap: 1, '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' } }}
            >
              <span style={{ color: '#546E7A', flexShrink: 0 }}>{time}</span>
              <span style={{ color: LEVEL_COLORS[row.level] ?? '#E0E0E0' }}>{row.text}</span>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
