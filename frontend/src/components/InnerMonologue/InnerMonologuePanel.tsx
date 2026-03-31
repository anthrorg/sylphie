import React, { useRef, useState } from 'react'
import { Box, Typography, List, ListItem, Collapse, Tooltip } from '@mui/material'
import { useAppStore, InnerMonologueEntry } from '../../store'
import { useAutoScroll } from '../../hooks/useAutoScroll'

const formatTimestamp = (isoString: string): string => {
  try {
    const date = new Date(isoString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return isoString
  }
}

// Individual entry — click to expand the verbatim raw payload
const MonologueEntry: React.FC<{ entry: InnerMonologueEntry }> = ({ entry }) => {
  const [open, setOpen] = useState(false)

  return (
    <ListItem disablePadding sx={{ py: 0.25, display: 'block' }}>
      <Box
        onClick={() => entry.rawPayload && setOpen((v) => !v)}
        sx={{ cursor: entry.rawPayload ? 'pointer' : 'default' }}
      >
        <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', display: 'block' }}>
          {formatTimestamp(entry.timestamp)}
          {entry.episode_id && ` [${entry.episode_id.slice(0, 8)}]`}
          {entry.rawPayload && (
            <span style={{ color: 'rgba(255,255,255,0.18)', marginLeft: 4 }}>
              {open ? '[ collapse ]' : '[ raw ]'}
            </span>
          )}
        </Typography>
        <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.3, fontFamily: 'monospace' }}>
          {entry.text}
        </Typography>
      </Box>

      {/* Verbatim raw payload — shown on click */}
      {entry.rawPayload && (
        <Collapse in={open}>
          <Box
            sx={{
              mt: 0.5,
              p: 0.75,
              bgcolor: 'rgba(0,0,0,0.3)',
              borderRadius: 0.5,
              border: '1px solid rgba(255,255,255,0.06)',
              overflow: 'auto',
              maxHeight: 160,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                fontSize: '0.58rem',
                color: 'rgba(184,217,198,0.6)',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(entry.rawPayload), null, 2)
                } catch {
                  return entry.rawPayload
                }
              })()}
            </Typography>
          </Box>
        </Collapse>
      )}
    </ListItem>
  )
}

export const InnerMonologuePanel: React.FC = () => {
  const innerMonologue = useAppStore((state) => state.innerMonologue)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useAutoScroll(scrollContainerRef, [innerMonologue])

  return (
    <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography
          variant="overline"
          sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 1 }}
        >
          Inner Monologue
        </Typography>
        <Tooltip title="Verbatim TimescaleDB event payloads. No LLM summarisation. Click an entry to expand the raw JSON.">
          <Typography
            variant="caption"
            sx={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.2)', cursor: 'help', fontStyle: 'italic' }}
          >
            verbatim
          </Typography>
        </Tooltip>
      </Box>

      <Box
        ref={scrollContainerRef}
        sx={{ flex: 1, overflow: 'auto', minHeight: 0, bgcolor: 'rgba(0,0,0,0.15)', borderRadius: 1, border: '1px solid rgba(255,255,255,0.07)' }}
      >
        {innerMonologue.length === 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
            <Typography variant="caption" sx={{ fontSize: '0.7rem', fontStyle: 'italic', color: 'rgba(255,255,255,0.2)' }}>
              Waiting for telemetry events...
            </Typography>
          </Box>
        ) : (
          <List dense disablePadding sx={{ px: 0.5 }}>
            {innerMonologue.map((entry, i) => (
              <MonologueEntry key={i} entry={entry} />
            ))}
          </List>
        )}
      </Box>
    </Box>
  )
}
