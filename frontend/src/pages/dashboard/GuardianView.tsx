import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Box,
  Typography,
  Stack,
  ButtonBase,
  Chip,
  CircularProgress,
  Tooltip,
  LinearProgress,
} from '@mui/material'
import {
  CheckCircleOutline as ApproveIcon,
  HighlightOff as RejectIcon,
  Refresh as RefreshIcon,
  Gavel as GavelIcon,
  Rule as RuleIcon,
  Memory as MemoryIcon,
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

interface TensorDashboard {
  available: boolean
  health: {
    modelsLoaded: boolean
    bootstrapMode: string
    trainingEnabled: boolean
    totalParameters: number
  } | null
  bootstrap: {
    mode: string
    agreementRate: number
    perCategoryAgreement: Record<string, number>
    categoriesGraduated: string[]
    totalShadowSamples: number
    totalAuditSamples: number
  } | null
  metrics: {
    trainingSteps: number
    trainingLoss: number | null
    inferenceLatencyMs: number
    samplesInBuffer: number
    checkpointCount: number
    perCategoryConfidence: Record<string, number>
  } | null
  modelState: Record<string, unknown> | null
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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
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
              color: rule.proposedBy === 'SYSTEM' ? '#90CAF9' : '#FFB74D',
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
// Tensor Dashboard: Bootstrap Progress
// ---------------------------------------------------------------------------

const BOOTSTRAP_STEPS = ['shadow', 'audit', 'partial', 'full'] as const

const BootstrapProgressPanel: React.FC<{ data: TensorDashboard }> = ({ data }) => {
  const mode = data.bootstrap?.mode ?? data.health?.bootstrapMode ?? 'shadow'
  const currentIdx = BOOTSTRAP_STEPS.indexOf(mode as typeof BOOTSTRAP_STEPS[number])
  const agreementRate = data.bootstrap?.agreementRate ?? 0
  const totalSamples = (data.bootstrap?.totalShadowSamples ?? 0) + (data.bootstrap?.totalAuditSamples ?? 0)
  const graduated = data.bootstrap?.categoriesGraduated ?? []

  return (
    <Box sx={{ p: 1.5 }}>
      {/* Step indicator */}
      <Stack direction="row" spacing={0} alignItems="center" sx={{ mb: 2 }}>
        {BOOTSTRAP_STEPS.map((step, i) => (
          <React.Fragment key={step}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flex: 1,
              }}
            >
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: i <= currentIdx
                    ? i === currentIdx
                      ? 'rgba(102,187,106,0.3)'
                      : 'rgba(102,187,106,0.12)'
                    : 'rgba(255,255,255,0.04)',
                  border: i === currentIdx
                    ? '2px solid rgba(102,187,106,0.7)'
                    : '1px solid rgba(255,255,255,0.08)',
                  transition: 'all 0.3s ease',
                }}
              >
                <Typography
                  sx={{
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    color: i <= currentIdx ? '#81C784' : 'rgba(255,255,255,0.2)',
                  }}
                >
                  {i + 1}
                </Typography>
              </Box>
              <Typography
                sx={{
                  fontSize: '0.55rem',
                  fontFamily: 'monospace',
                  color: i === currentIdx ? '#81C784' : 'rgba(255,255,255,0.25)',
                  fontWeight: i === currentIdx ? 700 : 400,
                  mt: 0.5,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                {step}
              </Typography>
            </Box>
            {i < BOOTSTRAP_STEPS.length - 1 && (
              <Box
                sx={{
                  flex: 0.5,
                  height: 1,
                  bgcolor: i < currentIdx ? 'rgba(102,187,106,0.3)' : 'rgba(255,255,255,0.06)',
                  mb: 2.5,
                }}
              />
            )}
          </React.Fragment>
        ))}
      </Stack>

      {/* Agreement rate + samples */}
      <Stack spacing={1}>
        <Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
            <Typography sx={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
              Overall Agreement
            </Typography>
            <Typography sx={{ fontSize: '0.7rem', color: '#81C784', fontFamily: 'monospace', fontWeight: 600 }}>
              {(agreementRate * 100).toFixed(1)}%
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={agreementRate * 100}
            sx={{
              height: 4,
              borderRadius: 2,
              bgcolor: 'rgba(255,255,255,0.04)',
              '& .MuiLinearProgress-bar': {
                bgcolor: agreementRate >= 0.85 ? '#66BB6A' : agreementRate >= 0.5 ? '#FFB74D' : '#EF5350',
                borderRadius: 2,
              },
            }}
          />
        </Box>

        <Stack direction="row" spacing={2}>
          <StatChip label="Samples" value={formatNumber(totalSamples)} />
          <StatChip label="Graduated" value={String(graduated.length)} />
        </Stack>

        {graduated.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
            {graduated.map((cat) => (
              <Chip
                key={cat}
                label={cat}
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.55rem',
                  fontFamily: 'monospace',
                  bgcolor: 'rgba(102,187,106,0.12)',
                  color: '#81C784',
                  border: 'none',
                }}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Tensor Dashboard: Category Agreement
// ---------------------------------------------------------------------------

const CategoryAgreementPanel: React.FC<{ data: TensorDashboard }> = ({ data }) => {
  const categories = data.bootstrap?.perCategoryAgreement ?? {}
  const graduated = new Set(
    (data.bootstrap?.categoriesGraduated ?? []).map((c) => c.toLowerCase()),
  )

  const sorted = Object.entries(categories).sort(([, a], [, b]) => b - a)

  if (sorted.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)' }}>
          No category data yet
        </Typography>
      </Box>
    )
  }

  return (
    <Box>
      {sorted.map(([category, rate]) => {
        const isGraduated = graduated.has(category.toLowerCase())
        return (
          <Box
            key={category}
            sx={{
              px: 1.5,
              py: 0.75,
              borderBottom: '1px solid rgba(255,255,255,0.03)',
              '&:last-child': { borderBottom: 'none' },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography
                sx={{
                  fontSize: '0.68rem',
                  fontFamily: 'monospace',
                  color: isGraduated ? '#81C784' : 'rgba(255,255,255,0.6)',
                  fontWeight: isGraduated ? 600 : 400,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {isGraduated ? '\u2713 ' : ''}{category}
              </Typography>
              <Box sx={{ width: 80, flexShrink: 0 }}>
                <LinearProgress
                  variant="determinate"
                  value={rate * 100}
                  sx={{
                    height: 3,
                    borderRadius: 1.5,
                    bgcolor: 'rgba(255,255,255,0.04)',
                    '& .MuiLinearProgress-bar': {
                      bgcolor: rate >= 0.85 ? '#66BB6A' : rate >= 0.5 ? '#FFB74D' : 'rgba(239,83,80,0.6)',
                      borderRadius: 1.5,
                    },
                  }}
                />
              </Box>
              <Typography
                sx={{
                  fontSize: '0.6rem',
                  fontFamily: 'monospace',
                  color: rate >= 0.85 ? '#81C784' : 'rgba(255,255,255,0.4)',
                  fontWeight: 600,
                  width: 38,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {(rate * 100).toFixed(0)}%
              </Typography>
            </Stack>
          </Box>
        )
      })}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Tensor Dashboard: Training Metrics
// ---------------------------------------------------------------------------

const TrainingMetricsPanel: React.FC<{ data: TensorDashboard }> = ({ data }) => {
  const m = data.metrics
  const h = data.health

  return (
    <Box sx={{ p: 1.5 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 1,
          mb: 1.5,
        }}
      >
        <StatChip label="Steps" value={m ? formatNumber(m.trainingSteps) : '-'} />
        <StatChip label="Loss" value={m?.trainingLoss != null ? m.trainingLoss.toFixed(4) : '-'} />
        <StatChip label="Latency" value={m ? `${m.inferenceLatencyMs.toFixed(0)}ms` : '-'} />
        <StatChip label="Buffer" value={m ? formatNumber(m.samplesInBuffer) : '-'} />
        <StatChip label="Checkpoints" value={m ? String(m.checkpointCount) : '-'} />
        <StatChip
          label="Training"
          value={h?.trainingEnabled ? 'ON' : 'OFF'}
          color={h?.trainingEnabled ? '#81C784' : '#EF5350'}
        />
      </Box>

      {/* Per-category confidence */}
      {m && Object.keys(m.perCategoryConfidence).length > 0 && (
        <>
          <Typography
            sx={{
              fontSize: '0.55rem',
              fontWeight: 700,
              color: 'rgba(255,255,255,0.2)',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              mb: 0.5,
            }}
          >
            Per-Category Confidence
          </Typography>
          {Object.entries(m.perCategoryConfidence)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, conf]) => (
              <Stack
                key={cat}
                direction="row"
                justifyContent="space-between"
                sx={{
                  py: 0.25,
                  borderBottom: '1px solid rgba(255,255,255,0.02)',
                }}
              >
                <Typography
                  sx={{
                    fontSize: '0.62rem',
                    fontFamily: 'monospace',
                    color: 'rgba(255,255,255,0.5)',
                  }}
                >
                  {cat}
                </Typography>
                <Typography
                  sx={{
                    fontSize: '0.62rem',
                    fontFamily: 'monospace',
                    color: 'rgba(184,217,198,0.6)',
                    fontWeight: 600,
                  }}
                >
                  {(conf * 100).toFixed(1)}%
                </Typography>
              </Stack>
            ))}
        </>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Tensor Dashboard: Model Architecture
// ---------------------------------------------------------------------------

const ModelArchitecturePanel: React.FC<{ data: TensorDashboard }> = ({ data }) => {
  const totalParams = data.health?.totalParameters ?? 0
  const state = data.modelState as Record<string, { parameters?: number }> | null

  // Extract per-model param counts from modelState if available
  const models: Array<{ name: string; params: number }> = []
  if (state) {
    for (const [key, value] of Object.entries(state)) {
      if (value && typeof value === 'object' && 'parameters' in value) {
        models.push({ name: key, params: Number(value.parameters) || 0 })
      }
    }
  }

  return (
    <Box sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 1.5 }}>
        <Typography
          sx={{
            fontSize: '1.2rem',
            fontFamily: 'monospace',
            fontWeight: 700,
            color: 'rgba(184,217,198,0.8)',
          }}
        >
          {formatNumber(totalParams)}
        </Typography>
        <Typography
          sx={{
            fontSize: '0.6rem',
            color: 'rgba(255,255,255,0.3)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          total parameters
        </Typography>
      </Stack>

      {models.length > 0 ? (
        models.sort((a, b) => b.params - a.params).map((m) => (
          <Stack
            key={m.name}
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{
              py: 0.5,
              borderBottom: '1px solid rgba(255,255,255,0.03)',
              '&:last-child': { borderBottom: 'none' },
            }}
          >
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontFamily: 'monospace',
                color: 'rgba(255,255,255,0.55)',
              }}
            >
              {m.name}
            </Typography>
            <Typography
              sx={{
                fontSize: '0.65rem',
                fontFamily: 'monospace',
                color: 'rgba(184,217,198,0.5)',
                fontWeight: 600,
              }}
            >
              {formatNumber(m.params)}
            </Typography>
          </Stack>
        ))
      ) : (
        <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.2)' }}>
          Model details unavailable
        </Typography>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// StatChip — compact key-value display
// ---------------------------------------------------------------------------

const StatChip: React.FC<{ label: string; value: string; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <Box
    sx={{
      bgcolor: 'rgba(255,255,255,0.03)',
      borderRadius: 1,
      px: 1,
      py: 0.5,
      textAlign: 'center',
    }}
  >
    <Typography
      sx={{
        fontSize: '0.8rem',
        fontFamily: 'monospace',
        fontWeight: 700,
        color: color ?? 'rgba(184,217,198,0.8)',
        lineHeight: 1.2,
      }}
    >
      {value}
    </Typography>
    <Typography
      sx={{
        fontSize: '0.5rem',
        color: 'rgba(255,255,255,0.25)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        lineHeight: 1.4,
      }}
    >
      {label}
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// GuardianView
// ---------------------------------------------------------------------------

export const GuardianView: React.FC = () => {
  const authToken = useAppStore((s) => s.authToken)

  // --- Rules state ---
  const [proposedRules, setProposedRules] = useState<ProposedRule[]>([])
  const [activeRules, setActiveRules] = useState<ActiveRule[]>([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)

  // --- Tensor state ---
  const [tensorData, setTensorData] = useState<TensorDashboard | null>(null)
  const tensorRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const headers = useCallback(
    () => ({
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  )

  // --- Fetch rules ---
  const fetchRules = useCallback(async () => {
    try {
      const [proposedRes, activeRes] = await Promise.all([
        fetch('/api/rules/proposed', { headers: headers() }),
        fetch('/api/rules/active', { headers: headers() }),
      ])
      if (proposedRes.ok) setProposedRules(await proposedRes.json())
      if (activeRes.ok) setActiveRules(await activeRes.json())
    } catch {
      // Silent
    } finally {
      setLoading(false)
    }
  }, [headers])

  // --- Fetch tensor dashboard ---
  const fetchTensor = useCallback(async () => {
    try {
      const res = await fetch('/api/cognition/dashboard', { headers: headers() })
      if (res.ok) {
        setTensorData(await res.json())
      }
    } catch {
      // Silent — panel shows unavailable state
    }
  }, [headers])

  // Initial fetch + 30s auto-refresh for tensor data
  useEffect(() => {
    fetchRules()
    fetchTensor()
    tensorRefreshRef.current = setInterval(fetchTensor, 30_000)
    return () => {
      if (tensorRefreshRef.current) clearInterval(tensorRefreshRef.current)
    }
  }, [fetchRules, fetchTensor])

  // --- Actions ---
  const handleApprove = async (id: string) => {
    setActionBusy(true)
    try {
      const res = await fetch(`/api/rules/${id}/approve`, {
        method: 'POST',
        headers: headers(),
      })
      if (res.ok) await fetchRules()
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
      if (res.ok) await fetchRules()
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

  const tensorAvailable = tensorData?.available === true

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        gap: 1,
        p: 1.5,
        boxSizing: 'border-box',
      }}
    >
      {/* ── Left Column: Rules ─────────────────────────────────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
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
                  color: proposedRules.length > 0 ? '#FFB74D' : 'rgba(255,255,255,0.3)',
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
                {['Trigger', 'Effect'].map((h, i) => (
                  <Typography
                    key={h}
                    sx={{
                      flex: i === 0 ? 2 : 3,
                      fontSize: '0.55rem',
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.2)',
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                    }}
                  >
                    {h}
                  </Typography>
                ))}
                <Typography sx={{ width: 50, fontSize: '0.55rem', fontWeight: 700, color: 'rgba(255,255,255,0.2)', letterSpacing: 0.5, textTransform: 'uppercase', textAlign: 'right' }}>
                  Conf
                </Typography>
                <Typography sx={{ width: 100, fontSize: '0.55rem', fontWeight: 700, color: 'rgba(255,255,255,0.2)', letterSpacing: 0.5, textTransform: 'uppercase', textAlign: 'right' }}>
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

      {/* ── Right Column: Tensor Cognition ─────────────────────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        {!tensorAvailable ? (
          <GlassPanel
            title="Tensor Cognition"
            sx={{ flex: 1 }}
          >
            <EmptyState
              icon={<MemoryIcon />}
              text="Cognition sidecar not available"
            />
          </GlassPanel>
        ) : (
          <>
            <GlassPanel
              title="Bootstrap Progress"
              sx={{ flex: 3, minHeight: 0 }}
              action={
                <ButtonBase
                  onClick={fetchTensor}
                  sx={{
                    p: 0.25,
                    borderRadius: 0.5,
                    color: 'rgba(255,255,255,0.3)',
                    '&:hover': { color: 'rgba(255,255,255,0.6)' },
                  }}
                >
                  <RefreshIcon sx={{ fontSize: '0.85rem' }} />
                </ButtonBase>
              }
            >
              <BootstrapProgressPanel data={tensorData!} />
            </GlassPanel>

            <GlassPanel
              title="Category Agreement"
              sx={{ flex: 3, minHeight: 0 }}
            >
              <CategoryAgreementPanel data={tensorData!} />
            </GlassPanel>

            <GlassPanel
              title="Training Metrics"
              sx={{ flex: 3, minHeight: 0 }}
            >
              <TrainingMetricsPanel data={tensorData!} />
            </GlassPanel>

            <GlassPanel
              title="Model Architecture"
              sx={{ flex: 2, minHeight: 0 }}
            >
              <ModelArchitecturePanel data={tensorData!} />
            </GlassPanel>
          </>
        )}
      </Box>
    </Box>
  )
}
