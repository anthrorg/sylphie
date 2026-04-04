import React from 'react'
import { Box, Typography, Chip, List, ListItem, ListItemText } from '@mui/material'
import { Circle as CircleIcon } from '@mui/icons-material'
import { useAppStore } from '../../store'

const stateColors: Record<string, string> = {
  idle: 'rgba(255,255,255,0.3)',
  categorizing: '#2196f3',
  executing: '#4caf50',
  observing: '#ff9800',
  learning: '#9c27b0',
  cooling_down: '#607d8b',
}

const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now() / 1000
  const diff = Math.max(0, Math.floor(now - timestamp))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography variant="overline" sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 1, display: 'block', mb: 0.25 }}>
    {children}
  </Typography>
)

interface MetricRowProps {
  label: string
  value: string
  valueColor?: string
}

const MetricRow: React.FC<MetricRowProps> = ({ label, value, valueColor }) => (
  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
    <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>
      {label}
    </Typography>
    <Typography variant="caption" sx={{ fontSize: '0.7rem', fontFamily: 'monospace', fontWeight: 500, color: valueColor || 'rgba(255,255,255,0.8)' }}>
      {value}
    </Typography>
  </Box>
)

export const ExecutorStatePanel: React.FC = () => {
  const executorState = useAppStore((state) => state.executorState)
  const currentCategory = useAppStore((state) => state.currentCategory)
  const currentAction = useAppStore((state) => state.currentAction)
  const actionConfidence = useAppStore((state) => state.actionConfidence)
  const transitionCount = useAppStore((state) => state.transitionCount)
  const dynamicThreshold = useAppStore((state) => state.dynamicThreshold)

  const dotColor = stateColors[executorState] || 'rgba(255,255,255,0.3)'

  return (
    <Box sx={{ px: 1.5, py: 1 }}>
      <SectionLabel>Executor State</SectionLabel>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
          <CircleIcon sx={{ fontSize: 10, color: dotColor }} />
          <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
            {executorState}
          </Typography>
        </Box>
        <MetricRow label="Category" value={currentCategory || 'none'} />
        <MetricRow label="Action" value={currentAction || 'none'} />
        <MetricRow label="Confidence" value={actionConfidence !== null ? actionConfidence.toFixed(3) : '--'} />
        <MetricRow label="Transitions" value={String(transitionCount)} />
        <MetricRow label="Threshold" value={(dynamicThreshold ?? 0).toFixed(3)} />
      </Box>
    </Box>
  )
}

export const DriveEnginePanel: React.FC = () => {
  const pressure = useAppStore((state) => state.pressure)
  const pressureSequenceNumber = useAppStore((state) => state.pressureSequenceNumber)
  const pressureTimestampMs = useAppStore((state) => state.pressureTimestampMs)
  const pressureIsStale = useAppStore((state) => state.pressureIsStale)

  const pressureValues = Object.values(pressure).filter((v): v is number => typeof v === 'number')
  const totalPressure = pressureValues.reduce((sum, v) => sum + v, 0)
  const fillRatio = pressureValues.length > 0 ? totalPressure / pressureValues.length : 0

  return (
    <Box sx={{ px: 1.5, py: 1 }}>
      <SectionLabel>Drive Engine</SectionLabel>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        <MetricRow label="Sequence" value={String(pressureSequenceNumber)} />
        <MetricRow label="Timestamp" value={pressureTimestampMs > 0 ? `${pressureTimestampMs}ms` : '--'} />
        <MetricRow label="Stale" value={pressureIsStale ? 'YES' : 'no'} valueColor={pressureIsStale ? '#f44336' : undefined} />
        <MetricRow label="Total pressure" value={totalPressure.toFixed(2)} />
        <MetricRow label="Fill ratio" value={fillRatio.toFixed(3)} />
      </Box>
    </Box>
  )
}

export const RecentActionsPanel: React.FC = () => {
  const actionHistory = useAppStore((state) => state.actionHistory)
  const recentActions = actionHistory.slice(0, 20)

  return (
    <Box sx={{ px: 1.5, py: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <SectionLabel>Recent Actions</SectionLabel>
      {recentActions.length === 0 ? (
        <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)' }}>No actions yet</Typography>
      ) : (
        <List dense disablePadding sx={{ flex: 1, overflow: 'auto' }}>
          {recentActions.map((entry, i) => (
            <ListItem key={i} disablePadding sx={{ py: 0.25 }}>
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.1 }}>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.2 }}>
                      {entry.action}
                    </Typography>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Chip label={entry.confidence.toFixed(2)} size="small" sx={{ height: 14, fontSize: '0.58rem', fontFamily: 'monospace', bgcolor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }} />
                      <Typography variant="caption" sx={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>
                        {formatRelativeTime(entry.timestamp)}
                      </Typography>
                    </Box>
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  )
}

export const PredictionAccuracyPanel: React.FC = () => {
  const predictionHistory = useAppStore((state) => state.predictionHistory)
  const recentPredictions = predictionHistory.slice(0, 20)

  return (
    <Box sx={{ px: 1.5, py: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <SectionLabel>Prediction Accuracy</SectionLabel>
      {recentPredictions.length === 0 ? (
        <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)' }}>No predictions yet</Typography>
      ) : (
        <List dense disablePadding sx={{ flex: 1, overflow: 'auto' }}>
          {recentPredictions.map((entry, i) => (
            <ListItem key={i} disablePadding sx={{ py: 0.25 }}>
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.1 }}>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.2 }}>
                      {entry.action}
                    </Typography>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Chip
                        label={`${((1 - entry.accuracy) * 100).toFixed(0)}%`}
                        size="small"
                        color={1 - entry.accuracy > 0.7 ? 'success' : 1 - entry.accuracy > 0.4 ? 'warning' : 'error'}
                        sx={{ height: 14, fontSize: '0.58rem', fontFamily: 'monospace' }}
                      />
                      <Typography variant="caption" sx={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>
                        {formatRelativeTime(entry.timestamp)}
                      </Typography>
                    </Box>
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  )
}

/** @deprecated Use the four individual panels instead */
export const MetricsPanel: React.FC = () => (
  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <ExecutorStatePanel />
    <RecentActionsPanel />
    <PredictionAccuracyPanel />
    <DriveEnginePanel />
  </Box>
)
