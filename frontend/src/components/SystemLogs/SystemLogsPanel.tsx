import React, { useRef, useState } from 'react'
import { Box, Typography, ToggleButtonGroup, ToggleButton } from '@mui/material'
import { useAppStore } from '../../store'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import type { SystemLogEntry } from '../../store'

const LEVEL_COLORS: Record<string, string> = {
  info: '#81C784',
  warn: '#FFB74D',
  error: '#EF5350',
}

// Maximum entries retained in the store — matches the store's slice cap
const MAX_ENTRIES = 200

type LevelFilter = 'all' | 'warn' | 'error'

export const SystemLogsPanel: React.FC = () => {
  const systemLogs = useAppStore((s) => s.systemLogs)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')

  const filteredLogs: SystemLogEntry[] =
    levelFilter === 'all'
      ? systemLogs
      : systemLogs.filter((e) =>
          levelFilter === 'error' ? e.level === 'error' : e.level === 'warn' || e.level === 'error',
        )

  useAutoScroll(scrollContainerRef, [filteredLogs.length])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1,
          py: 0.5,
          borderBottom: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <Typography variant="subtitle2" sx={{ color: '#B0BEC5' }}>
          System Logs
          <Typography component="span" variant="caption" sx={{ ml: 1, color: 'rgba(255,255,255,0.3)' }}>
            ({filteredLogs.length}/{MAX_ENTRIES})
          </Typography>
        </Typography>

        <ToggleButtonGroup
          value={levelFilter}
          exclusive
          onChange={(_e, v) => v !== null && setLevelFilter(v as LevelFilter)}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              py: 0,
              px: 0.75,
              fontSize: '0.6rem',
              color: 'rgba(255,255,255,0.4)',
              border: '1px solid rgba(255,255,255,0.12)',
              '&.Mui-selected': { color: '#B0BEC5', bgcolor: 'rgba(255,255,255,0.08)' },
            },
          }}
        >
          <ToggleButton value="all">all</ToggleButton>
          <ToggleButton value="warn" sx={{ '&.Mui-selected': { color: '#FFB74D !important' } }}>warn+</ToggleButton>
          <ToggleButton value="error" sx={{ '&.Mui-selected': { color: '#EF5350 !important' } }}>error</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box
        ref={scrollContainerRef}
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
        {filteredLogs.length === 0 && (
          <Typography
            sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '11px', fontStyle: 'italic', mt: 1 }}
          >
            {systemLogs.length === 0 ? 'Waiting for telemetry...' : 'No entries match filter'}
          </Typography>
        )}
        {filteredLogs.map((entry, i) => {
          const time = entry.timestamp.slice(11, 19)
          return (
            <Box
              key={i}
              sx={{ display: 'flex', gap: 1, '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' } }}
            >
              <span style={{ color: '#546E7A', flexShrink: 0 }}>{time}</span>
              <span style={{ color: LEVEL_COLORS[entry.level] ?? '#E0E0E0' }}>{entry.text}</span>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
