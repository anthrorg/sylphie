// ---------------------------------------------------------------------------
// SupervisorPanel — full supervisor dialog with Live Feed and Controls tabs.
// Opened from the Dashboard TopBar via the "Supervisor" button.
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Slider,
  Stack,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  Close as CloseIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material'
import { useSupervisorStore, SamplingPolicy } from '../../store/supervisorSlice'
import { useSupervisorWebSocket } from '../../hooks/useSupervisorWebSocket'
import { VerdictCard } from './VerdictCard'

// ---------------------------------------------------------------------------
// Section wrapper — reuses the Observatory styling convention
// ---------------------------------------------------------------------------

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box
    sx={{
      mb: 2,
      p: 1.5,
      bgcolor: 'rgba(0,0,0,0.15)',
      borderRadius: 1,
      border: '1px solid rgba(255,255,255,0.07)',
    }}
  >
    <Typography
      variant="overline"
      sx={{
        fontSize: '0.65rem',
        fontWeight: 700,
        color: 'rgba(255,255,255,0.4)',
        letterSpacing: 1,
        display: 'block',
        mb: 1,
      }}
    >
      {title}
    </Typography>
    {children}
  </Box>
)

// ---------------------------------------------------------------------------
// Budget bar
// ---------------------------------------------------------------------------

const BudgetBar: React.FC<{ used: number; remaining: number }> = ({ used, remaining }) => {
  const total = used + remaining
  const pct = total > 0 ? Math.round((used / total) * 100) : 0
  const barColor = pct >= 90 ? '#EF5350' : pct >= 70 ? '#FFB74D' : '#66BB6A'

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.65rem' }}>
          Used today: ${used.toFixed(4)}
        </Typography>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.65rem' }}>
          Remaining: ${remaining.toFixed(4)}
        </Typography>
      </Box>
      <Box
        sx={{
          height: 6,
          bgcolor: 'rgba(255,255,255,0.08)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            width: `${pct}%`,
            height: '100%',
            bgcolor: barColor,
            borderRadius: 3,
            transition: 'width 0.4s ease',
          }}
        />
      </Box>
      <Typography
        variant="caption"
        sx={{ mt: 0.25, display: 'block', color: 'rgba(255,255,255,0.25)', fontSize: '0.6rem' }}
      >
        {pct}% of daily budget consumed
      </Typography>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Live Feed tab
// ---------------------------------------------------------------------------

const LiveFeedTab: React.FC = () => {
  const { recentVerdicts, flaggedCount, totalVerdicts, clearVerdicts } = useSupervisorStore()
  const feedEndRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to newest verdict
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [recentVerdicts.length])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Summary row */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, px: 0.5, flexShrink: 0 }}>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>
          {totalVerdicts} verdicts total
        </Typography>
        {flaggedCount > 0 && (
          <Chip
            label={`${flaggedCount} flagged`}
            color="error"
            size="small"
            sx={{ fontSize: '0.6rem', height: 18 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Clear feed">
          <IconButton
            size="small"
            onClick={clearVerdicts}
            sx={{ color: 'rgba(255,255,255,0.3)', '&:hover': { color: 'rgba(255,255,255,0.6)' } }}
          >
            <RefreshIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Scrolling verdict list */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {recentVerdicts.length === 0 ? (
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.2)',
              fontSize: '0.75rem',
              fontStyle: 'italic',
              py: 4,
              textAlign: 'center',
            }}
          >
            No verdicts yet. Waiting for supervisor activity.
          </Typography>
        ) : (
          recentVerdicts.map((v) => <VerdictCard key={`${v.cycleId}-${v.timestamp}`} verdict={v} />)
        )}
        <div ref={feedEndRef} />
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Controls tab
// ---------------------------------------------------------------------------

const ControlsTab: React.FC = () => {
  const { enabled, sampleRate, burstMode, budgetRemaining, budgetUsedToday, setStatus } =
    useSupervisorStore()

  const [localRate, setLocalRate] = useState(sampleRate)
  const [isSaving, setIsSaving] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Keep local slider in sync when the store updates from a status poll
  useEffect(() => {
    setLocalRate(sampleRate)
  }, [sampleRate])

  const postAndRefresh = useCallback(
    async (url: string, body?: unknown) => {
      setIsSaving(true)
      setStatusError(null)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Re-fetch status to sync store
        const statusRes = await fetch('/api/supervisor/status')
        if (statusRes.ok) {
          const data = await statusRes.json()
          setStatus(data)
        }
      } catch (err) {
        setStatusError(err instanceof Error ? err.message : 'Request failed')
      } finally {
        setIsSaving(false)
      }
    },
    [setStatus],
  )

  const handleToggleEnabled = useCallback(() => {
    const url = enabled ? '/api/supervisor/disable' : '/api/supervisor/enable'
    void postAndRefresh(url)
  }, [enabled, postAndRefresh])

  const handleApplyPolicy = useCallback(() => {
    const policy: SamplingPolicy = { sampleRate: localRate, burstMode }
    void postAndRefresh('/api/supervisor/policy', policy)
  }, [localRate, burstMode, postAndRefresh])

  const handleBurstToggle = useCallback(() => {
    const policy: SamplingPolicy = { sampleRate: localRate, burstMode: !burstMode }
    void postAndRefresh('/api/supervisor/policy', policy)
  }, [localRate, burstMode, postAndRefresh])

  return (
    <Box sx={{ overflow: 'auto', pb: 2 }}>
      {statusError && (
        <Typography
          sx={{ mb: 1.5, color: '#EF5350', fontSize: '0.7rem', fontFamily: 'monospace' }}
        >
          Error: {statusError}
        </Typography>
      )}

      {/* Enable/Disable */}
      <Section title="Supervisor State">
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography sx={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.8rem' }}>
              {enabled ? 'Enabled' : 'Disabled'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.65rem' }}>
              Toggle DeepSeek reasoning supervisor on / off
            </Typography>
          </Box>
          <Switch
            checked={enabled}
            onChange={handleToggleEnabled}
            disabled={isSaving}
            color="success"
          />
        </Box>
      </Section>

      {/* Sampling rate */}
      <Section title="Sampling Rate">
        <Box sx={{ px: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.65rem' }}>
              Every cycle
            </Typography>
            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.65rem', fontWeight: 700 }}>
              {localRate}%
            </Typography>
          </Box>
          <Slider
            value={localRate}
            onChange={(_e, v) => setLocalRate(v as number)}
            min={1}
            max={100}
            step={1}
            disabled={isSaving}
            size="small"
            sx={{ color: '#64B5F6' }}
          />
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.6rem' }}>
            Probability each cognitive cycle is supervised
          </Typography>
        </Box>
        <Box sx={{ mt: 1.5 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={handleApplyPolicy}
            disabled={isSaving || localRate === sampleRate}
            sx={{ fontSize: '0.65rem', borderColor: 'rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.7)' }}
          >
            {isSaving ? <CircularProgress size={12} sx={{ mr: 0.5 }} /> : null}
            Apply Rate
          </Button>
        </Box>
      </Section>

      {/* Burst mode */}
      <Section title="Burst Mode">
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography sx={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.8rem' }}>
              Supervise All
            </Typography>
            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.65rem' }}>
              Temporarily supervise every cycle (100% rate override)
            </Typography>
          </Box>
          <Switch
            checked={burstMode}
            onChange={handleBurstToggle}
            disabled={isSaving}
            color="warning"
          />
        </Box>
      </Section>

      {/* Budget */}
      <Section title="Daily Budget">
        <BudgetBar used={budgetUsedToday} remaining={budgetRemaining} />
      </Section>

      {/* Future actions — disabled with Coming Soon label */}
      <Section title="Interventions">
        <Stack direction="row" spacing={1}>
          <Tooltip title="Coming Soon">
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled
                sx={{
                  fontSize: '0.65rem',
                  borderColor: 'rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.25)',
                }}
              >
                Freeze
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Coming Soon">
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled
                sx={{
                  fontSize: '0.65rem',
                  borderColor: 'rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.25)',
                }}
              >
                Rollback
              </Button>
            </span>
          </Tooltip>
        </Stack>
        <Typography
          variant="caption"
          sx={{ mt: 0.75, display: 'block', color: 'rgba(255,255,255,0.2)', fontSize: '0.6rem' }}
        >
          Intervention controls will be enabled in a future release.
        </Typography>
      </Section>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

interface SupervisorPanelProps {
  open: boolean
  onClose: () => void
}

export const SupervisorPanel: React.FC<SupervisorPanelProps> = ({ open, onClose }) => {
  const [tab, setTab] = useState(0)
  const { setStatus, enabled, totalVerdicts, flaggedCount } = useSupervisorStore()
  const [loadingStatus, setLoadingStatus] = useState(false)

  // Start the WebSocket connection as soon as the panel is used
  useSupervisorWebSocket()

  // Poll status on open
  useEffect(() => {
    if (!open) return

    setLoadingStatus(true)
    fetch('/api/supervisor/status')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setStatus(data)
      })
      .catch((err) => {
        console.warn('[Supervisor] Status fetch failed:', err)
      })
      .finally(() => setLoadingStatus(false))
  }, [open, setStatus])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      PaperProps={{ sx: { height: '75vh', bgcolor: '#1a1a2e' } }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pb: 0,
          pt: 1.5,
          px: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Typography variant="h6" sx={{ fontSize: '1rem' }}>
            Supervisor
          </Typography>
          {loadingStatus ? (
            <CircularProgress size={14} sx={{ color: 'rgba(255,255,255,0.3)' }} />
          ) : (
            <Chip
              label={enabled ? 'ACTIVE' : 'INACTIVE'}
              color={enabled ? 'success' : 'default'}
              size="small"
              sx={{ fontSize: '0.6rem', height: 18 }}
            />
          )}
          {flaggedCount > 0 && (
            <Chip
              label={`${flaggedCount} flagged`}
              color="error"
              size="small"
              sx={{ fontSize: '0.6rem', height: 18 }}
            />
          )}
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.6rem' }}>
            {totalVerdicts} verdicts
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" aria-label="Close supervisor panel">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <Box sx={{ px: 2, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <Tabs
          value={tab}
          onChange={(_e, v: number) => setTab(v)}
          sx={{
            minHeight: 36,
            '& .MuiTab-root': { fontSize: '0.7rem', minHeight: 36, py: 0 },
          }}
        >
          <Tab label="Live Feed" />
          <Tab label="Controls" />
        </Tabs>
      </Box>

      <DialogContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {tab === 0 && <LiveFeedTab />}
        {tab === 1 && <ControlsTab />}
      </DialogContent>
    </Dialog>
  )
}
