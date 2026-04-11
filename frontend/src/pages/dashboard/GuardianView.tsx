import React, { useEffect, useState, useCallback } from 'react'
import {
  Box,
  Typography,
  Stack,
  ButtonBase,
  Chip,
  CircularProgress,
  Tooltip,
} from '@mui/material'
import {
  CheckCircleOutline as ApproveIcon,
  HighlightOff as RejectIcon,
  Refresh as RefreshIcon,
  Gavel as GavelIcon,
  Rule as RuleIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProposedRule {
  id: string
  triggerPattern: string
  effect: string
  confidence: number
  proposedBy: string
  reasoning: string | null
  status: string
  createdAt: string
}

interface ActiveRule {
  id: string
  triggerPattern: string
  effect: string
  enabled: boolean
  confidence: number
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Glass panel (matches AnalyticsView pattern)
// ---------------------------------------------------------------------------

const GlassPanel: React.FC<{
  children: React.ReactNode
  title?: string
  sx?: Record<string, unknown>
  action?: React.ReactNode
}> = ({ children, title, sx, action }) => (
  <Box
    sx={{
      bgcolor: 'rgba(255,255,255,0.03)',
      borderRadius: 2,
      border: '1px solid rgba(184,217,198,0.12)',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      ...sx,
    }}
  >
    {title && (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
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
          {title}
        </Typography>
        {action}
      </Box>
    )}
    <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      {children}
    </Box>
  </Box>
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEffect(effect: string): string {
  try {
    const parsed = JSON.parse(effect)
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.entries(parsed)
        .map(([drive, delta]) => {
          const n = Number(delta)
          return `${drive} ${n >= 0 ? '+' : ''}${n.toFixed(2)}`
        })
        .join(', ')
    }
  } catch {
    // Not JSON — return as DSL string
  }
  return effect
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// ProposedRuleCard
// ---------------------------------------------------------------------------

const ProposedRuleCard: React.FC<{
  rule: ProposedRule
  onApprove: (id: string) => void
  onReject: (id: string) => void
  busy: boolean
}> = ({ rule, onApprove, onReject, busy }) => (
  <Box
    sx={{
      p: 1.5,
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      '&:last-child': { borderBottom: 'none' },
      '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
      transition: 'background 0.15s ease',
    }}
  >
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* Trigger pattern */}
        <Typography
          sx={{
            fontSize: '0.82rem',
            fontFamily: 'monospace',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.85)',
            mb: 0.5,
          }}
        >
          {rule.triggerPattern}
        </Typography>

        {/* Effect */}
        <Typography
          sx={{
            fontSize: '0.72rem',
            fontFamily: 'monospace',
            color: 'rgba(184,217,198,0.7)',
            mb: 0.75,
          }}
        >
          {parseEffect(rule.effect)}
        </Typography>

        {/* Reasoning */}
        {rule.reasoning && (
          <Typography
            sx={{
              fontSize: '0.7rem',
              color: 'rgba(255,255,255,0.4)',
              fontStyle: 'italic',
              mb: 0.75,
              lineHeight: 1.4,
            }}
          >
            {rule.reasoning}
          </Typography>
        )}

        {/* Metadata chips */}
        <Stack direction="row" spacing={0.75} flexWrap="wrap">
          <Chip
            label={rule.proposedBy}
            size="small"
            sx={{
              height: 18,
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              bgcolor: rule.proposedBy === 'SYSTEM'
                ? 'rgba(100,181,246,0.15)'
                : 'rgba(255,183,77,0.15)',
              color: rule.proposedBy === 'SYSTEM'
                ? '#90CAF9'
                : '#FFB74D',
              border: 'none',
            }}
          />
          <Chip
            label={`conf ${rule.confidence.toFixed(2)}`}
            size="small"
            sx={{
              height: 18,
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              bgcolor: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.4)',
              border: 'none',
            }}
          />
          <Typography
            sx={{
              fontSize: '0.58rem',
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.25)',
              alignSelf: 'center',
            }}
          >
            {formatDate(rule.createdAt)}
          </Typography>
        </Stack>
      </Box>

      {/* Approve / Reject buttons */}
      <Stack direction="row" spacing={0.5} sx={{ ml: 1.5, flexShrink: 0 }}>
        <Tooltip title="Approve" arrow>
          <ButtonBase
            onClick={() => onApprove(rule.id)}
            disabled={busy}
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1,
              bgcolor: 'rgba(102,187,106,0.08)',
              transition: 'all 0.15s ease',
              '&:hover': {
                bgcolor: 'rgba(102,187,106,0.2)',
                '& .MuiSvgIcon-root': { color: '#66BB6A' },
              },
            }}
          >
            <ApproveIcon sx={{ fontSize: 18, color: 'rgba(102,187,106,0.6)', transition: 'color 0.15s' }} />
          </ButtonBase>
        </Tooltip>
        <Tooltip title="Reject" arrow>
          <ButtonBase
            onClick={() => onReject(rule.id)}
            disabled={busy}
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1,
              bgcolor: 'rgba(239,83,80,0.08)',
              transition: 'all 0.15s ease',
              '&:hover': {
                bgcolor: 'rgba(239,83,80,0.2)',
                '& .MuiSvgIcon-root': { color: '#EF5350' },
              },
            }}
          >
            <RejectIcon sx={{ fontSize: 18, color: 'rgba(239,83,80,0.5)', transition: 'color 0.15s' }} />
          </ButtonBase>
        </Tooltip>
      </Stack>
    </Stack>
  </Box>
)

// ---------------------------------------------------------------------------
// ActiveRuleRow
// ---------------------------------------------------------------------------

const ActiveRuleRow: React.FC<{ rule: ActiveRule }> = ({ rule }) => (
  <Box
    sx={{
      px: 1.5,
      py: 1,
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      '&:last-child': { borderBottom: 'none' },
      display: 'flex',
      alignItems: 'center',
      gap: 2,
    }}
  >
    <Box sx={{ flex: 2, minWidth: 0 }}>
      <Typography
        sx={{
          fontSize: '0.78rem',
          fontFamily: 'monospace',
          fontWeight: 600,
          color: 'rgba(255,255,255,0.75)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {rule.triggerPattern}
      </Typography>
    </Box>
    <Box sx={{ flex: 3, minWidth: 0 }}>
      <Typography
        sx={{
          fontSize: '0.72rem',
          fontFamily: 'monospace',
          color: 'rgba(184,217,198,0.6)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {parseEffect(rule.effect)}
      </Typography>
    </Box>
    <Typography
      sx={{
        fontSize: '0.65rem',
        fontFamily: 'monospace',
        color: 'rgba(255,255,255,0.3)',
        flexShrink: 0,
        width: 50,
        textAlign: 'right',
      }}
    >
      {rule.confidence.toFixed(2)}
    </Typography>
    <Typography
      sx={{
        fontSize: '0.58rem',
        fontFamily: 'monospace',
        color: 'rgba(255,255,255,0.2)',
        flexShrink: 0,
        width: 100,
        textAlign: 'right',
      }}
    >
      {formatDate(rule.createdAt)}
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

const EmptyState: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      py: 6,
      gap: 1.5,
    }}
  >
    <Box sx={{ color: 'rgba(255,255,255,0.12)', '& .MuiSvgIcon-root': { fontSize: 36 } }}>
      {icon}
    </Box>
    <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.25)' }}>
      {text}
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// GuardianView
// ---------------------------------------------------------------------------

export const GuardianView: React.FC = () => {
  const authToken = useAppStore((s) => s.authToken)

  const [proposedRules, setProposedRules] = useState<ProposedRule[]>([])
  const [activeRules, setActiveRules] = useState<ActiveRule[]>([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)

  const headers = useCallback(
    () => ({
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  )

  const fetchRules = useCallback(async () => {
    try {
      const [proposedRes, activeRes] = await Promise.all([
        fetch('/api/rules/proposed', { headers: headers() }),
        fetch('/api/rules/active', { headers: headers() }),
      ])

      if (proposedRes.ok) {
        setProposedRules(await proposedRes.json())
      }
      if (activeRes.ok) {
        setActiveRules(await activeRes.json())
      }
    } catch {
      // Silently fail — panel shows empty state
    } finally {
      setLoading(false)
    }
  }, [headers])

  useEffect(() => {
    fetchRules()
  }, [fetchRules])

  const handleApprove = async (id: string) => {
    setActionBusy(true)
    try {
      const res = await fetch(`/api/rules/${id}/approve`, {
        method: 'POST',
        headers: headers(),
      })
      if (res.ok) {
        await fetchRules()
      }
    } catch {
      // silent
    } finally {
      setActionBusy(false)
    }
  }

  const handleReject = async (id: string) => {
    setActionBusy(true)
    try {
      const res = await fetch(`/api/rules/${id}/reject`, {
        method: 'POST',
        headers: headers(),
      })
      if (res.ok) {
        await fetchRules()
      }
    } catch {
      // silent
    } finally {
      setActionBusy(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress size={28} sx={{ color: 'rgba(184,217,198,0.4)' }} />
      </Box>
    )
  }

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
      {/* Pending Rules — top section */}
      <GlassPanel
        title="Pending Rules"
        sx={{ flex: 5, minHeight: 0 }}
        action={
          <Stack direction="row" alignItems="center" spacing={1}>
            <Chip
              label={`${proposedRules.length} pending`}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.6rem',
                fontFamily: 'monospace',
                bgcolor: proposedRules.length > 0
                  ? 'rgba(255,183,77,0.15)'
                  : 'rgba(255,255,255,0.06)',
                color: proposedRules.length > 0
                  ? '#FFB74D'
                  : 'rgba(255,255,255,0.3)',
                border: 'none',
              }}
            />
            <ButtonBase
              onClick={() => { setLoading(true); fetchRules() }}
              sx={{
                p: 0.25,
                borderRadius: 0.5,
                color: 'rgba(255,255,255,0.3)',
                '&:hover': { color: 'rgba(255,255,255,0.6)' },
              }}
            >
              <RefreshIcon sx={{ fontSize: '0.85rem' }} />
            </ButtonBase>
          </Stack>
        }
      >
        {proposedRules.length === 0 ? (
          <EmptyState icon={<GavelIcon />} text="No pending rules to review" />
        ) : (
          proposedRules.map((rule) => (
            <ProposedRuleCard
              key={rule.id}
              rule={rule}
              onApprove={handleApprove}
              onReject={handleReject}
              busy={actionBusy}
            />
          ))
        )}
      </GlassPanel>

      {/* Active Rules — bottom section */}
      <GlassPanel
        title="Active Rules"
        sx={{ flex: 4, minHeight: 0 }}
        action={
          <Chip
            label={`${activeRules.length} active`}
            size="small"
            sx={{
              height: 18,
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              bgcolor: 'rgba(102,187,106,0.12)',
              color: '#81C784',
              border: 'none',
            }}
          />
        }
      >
        {activeRules.length === 0 ? (
          <EmptyState icon={<RuleIcon />} text="No active drive rules" />
        ) : (
          <>
            {/* Column headers */}
            <Box
              sx={{
                px: 1.5,
                py: 0.5,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <Typography
                sx={{
                  flex: 2,
                  fontSize: '0.55rem',
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.2)',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Trigger
              </Typography>
              <Typography
                sx={{
                  flex: 3,
                  fontSize: '0.55rem',
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.2)',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Effect
              </Typography>
              <Typography
                sx={{
                  width: 50,
                  fontSize: '0.55rem',
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.2)',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  textAlign: 'right',
                }}
              >
                Conf
              </Typography>
              <Typography
                sx={{
                  width: 100,
                  fontSize: '0.55rem',
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.2)',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  textAlign: 'right',
                }}
              >
                Created
              </Typography>
            </Box>
            {activeRules.map((rule) => (
              <ActiveRuleRow key={rule.id} rule={rule} />
            ))}
          </>
        )}
      </GlassPanel>
    </Box>
  )
}
