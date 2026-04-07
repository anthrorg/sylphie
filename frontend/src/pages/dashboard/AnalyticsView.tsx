import React, { useState } from 'react'
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from '@mui/material'
import {
  BarChart as BarChartIcon,
  Close as CloseIcon,
} from '@mui/icons-material'
import {
  ExecutorStatePanel,
  DriveEnginePanel,
  RecentActionsPanel,
  PredictionAccuracyPanel,
} from '../../components/Metrics/MetricsPanel'
import { DriveRadarChart } from '../../components/Drives/DriveRadarChart'
import { DrivesPanel } from '../../components/Drives/DrivesPanel'
import { CoreDrivesChart, ComplementDrivesChart } from '../../components/Drives/DriveBarChart'
import { InnerMonologuePanel } from '../../components/InnerMonologue/InnerMonologuePanel'
import { SystemLogsPanel } from '../../components/SystemLogs/SystemLogsPanel'
import { MaintenanceLogsPanel } from '../../components/MaintenanceLogs/MaintenanceLogsPanel'
import { ObservatoryPanel } from '../../components/Observatory/ObservatoryDashboard'

// ---------------------------------------------------------------------------
// Shared glass-panel
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
// AnalyticsView
// ---------------------------------------------------------------------------
export const AnalyticsView: React.FC = () => {
  const [observatoryOpen, setObservatoryOpen] = useState(false)

  return (
    <>
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
        {/* ── Top row: Executor + Drives + Radar ──────────────────── */}
        <Box sx={{ flex: 4, display: 'flex', gap: 1, minHeight: 0 }}>
          {/* Left column: Executor state + Drive engine metrics */}
          <Box sx={{ flex: 2, display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
            <GlassPanel title="Executor State" sx={{ flex: 1 }}>
              <ExecutorStatePanel />
            </GlassPanel>
            <GlassPanel title="Drive Engine" sx={{ flex: 1 }}>
              <DriveEnginePanel />
            </GlassPanel>
          </Box>

          {/* Center: Full drive panel with controls */}
          <GlassPanel sx={{ flex: 4 }}>
            <DrivesPanel />
          </GlassPanel>

          {/* Right: Radar chart */}
          <GlassPanel
            title="Drive Radar"
            sx={{ flex: 3 }}
            action={
              <IconButton
                size="small"
                onClick={() => setObservatoryOpen(true)}
                sx={{
                  p: 0.25,
                  color: 'rgba(255,255,255,0.3)',
                  '&:hover': { color: 'rgba(255,255,255,0.6)' },
                }}
              >
                <BarChartIcon sx={{ fontSize: '0.85rem' }} />
              </IconButton>
            }
          >
            <Box sx={{ height: '100%', p: 1 }}>
              <DriveRadarChart />
            </Box>
          </GlassPanel>
        </Box>

        {/* ── Middle row: Bar charts ──────────────────────────────── */}
        <Box sx={{ flex: 2, display: 'flex', gap: 1, minHeight: 0 }}>
          <GlassPanel sx={{ flex: 1, p: 1.5 }}>
            <CoreDrivesChart />
          </GlassPanel>
          <GlassPanel sx={{ flex: 2, p: 1.5 }}>
            <ComplementDrivesChart />
          </GlassPanel>
        </Box>

        {/* ── Bottom row: Actions + Predictions + Monologue + Logs ── */}
        <Box sx={{ flex: 3, display: 'flex', gap: 1, minHeight: 0 }}>
          <GlassPanel title="Recent Actions" sx={{ flex: 1 }}>
            <RecentActionsPanel />
          </GlassPanel>
          <GlassPanel title="Prediction Accuracy" sx={{ flex: 1 }}>
            <PredictionAccuracyPanel />
          </GlassPanel>
          <GlassPanel title="Inner Monologue" sx={{ flex: 1.5 }}>
            <InnerMonologuePanel />
          </GlassPanel>
          <Box sx={{ flex: 1.5, display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
            <GlassPanel title="System Logs" sx={{ flex: 1 }}>
              <SystemLogsPanel />
            </GlassPanel>
            <GlassPanel title="Maintenance" sx={{ flex: 1 }}>
              <MaintenanceLogsPanel />
            </GlassPanel>
          </Box>
        </Box>
      </Box>

      {/* Observatory dialog */}
      <Dialog
        open={observatoryOpen}
        onClose={() => setObservatoryOpen(false)}
        fullWidth
        maxWidth="lg"
        PaperProps={{ sx: { height: '80vh' } }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pb: 1,
          }}
        >
          <Typography variant="h6">Observatory</Typography>
          <IconButton
            onClick={() => setObservatoryOpen(false)}
            size="small"
            aria-label="Close Observatory"
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ overflow: 'auto', p: 2 }}>
          <ObservatoryPanel />
        </DialogContent>
      </Dialog>
    </>
  )
}
