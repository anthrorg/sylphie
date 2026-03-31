import React, { useEffect, useState } from 'react'
import {
  AppBar,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Theme,
  Toolbar,
  Typography,
} from '@mui/material'
import { BarChart as BarChartIcon, Close as CloseIcon, Extension as ExtensionIcon } from '@mui/icons-material'

import { useAppStore } from './store'
import { useSessionTimer } from './hooks/useSessionTimer'
import { WSState } from './types'
import { useDevMode } from './hooks/useDevMode'
import { DriveRadarChart } from './components/Drives/DriveRadarChart'
import { GraphPanel } from './components/Graph/GraphPanel'
import { ConversationPanel } from './components/Conversation/ConversationPanel'
import { MaintenanceLogsPanel } from './components/MaintenanceLogs/MaintenanceLogsPanel'
import {
  ExecutorStatePanel,
  DriveEnginePanel,
} from './components/Metrics/MetricsPanel'
import { SystemLogsPanel } from './components/SystemLogs/SystemLogsPanel'
import { ObservatoryPanel } from './components/Observatory/ObservatoryDashboard'
import { SkillManager } from './components/Skills/SkillManager'
import { NodeInspector } from './components/Graph/NodeInspector'
import { FEAgentPanel } from './components/FEAgent/FEAgentPanel'
import { useGraphWebSocket, useTelemetryWebSocket } from './hooks/useWebSocket'

const GAP = 8

const VideoWidget: React.FC = () => {
  const { cameraState } = useAppStore()
  return (
    <Box sx={{ width: '100%', height: '100%', bgcolor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 1, overflow: 'hidden' }}>
      {cameraState.active ? (
        <img src="/api/debug/camera/stream?annotated=1" alt="Camera feed" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
      ) : (
        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.4)' }}>Camera Not Available</Typography>
      )}
    </Box>
  )
}

const Dashboard = () => {
  const { setVoiceState, setCameraState } = useAppStore()
  const [observatoryOpen, setObservatoryOpen] = useState(false)

  useGraphWebSocket()
  useTelemetryWebSocket()

  useEffect(() => {
    fetch('/api/voice/status')
      .then((r) => r.json())
      .then((d) => setVoiceState({ available: d.available === true }))
      .catch(() => setVoiceState({ available: false }))

    fetch('/api/debug/camera/status')
      .then((r) => r.json())
      .then((d) => setCameraState({ active: d.active === true }))
      .catch(() => setCameraState({ active: false }))
  }, [setVoiceState, setCameraState])

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <TopBar onOpenObservatory={() => setObservatoryOpen(true)} />
        <Box sx={{ p: `${GAP}px`, overflow: 'auto', flex: 1 }}>

          {/* Row 1: graph | chat | radar */}
          <Box sx={{ display: 'flex', gap: `${GAP}px`, mb: `${GAP}px`, alignItems: 'stretch' }}>
            <Panel sx={{ flex: 5, overflow: 'hidden', height: 500 }}>
              <GraphPanel />
            </Panel>
            <Panel sx={{ flex: 4, overflow: 'hidden', height: 500 }}>
              <ConversationPanel />
            </Panel>
            <Panel sx={{ flex: 3, height: 500 }}>
              <DriveRadarChart />
            </Panel>
          </Box>

          {/* Row 2: video | maintenance | system-logs | sidebar */}
          <Box sx={{ display: 'flex', gap: `${GAP}px`, mb: `${GAP}px`, alignItems: 'stretch' }}>
            <Panel sx={{ flex: 4, overflow: 'hidden', height: 500 }}>
              <VideoWidget />
            </Panel>
            <Panel sx={{ flex: 3, overflow: 'hidden', height: 500 }}>
              <MaintenanceLogsPanel />
            </Panel>
            <Panel sx={{ flex: 5, height: 500, overflow: 'hidden' }}>
              <SystemLogsPanel />
            </Panel>
            <Box sx={{ flex: 2, minWidth: 220, display: 'flex', flexDirection: 'column', gap: `${GAP}px` }}>
              <Panel sx={{ flex: 1 }}><ExecutorStatePanel /></Panel>
              <Panel sx={{ flex: 1 }}><DriveEnginePanel /></Panel>
            </Box>
          </Box>

        </Box>
      </Box>

      <SkillManager />
      <NodeInspector />
      <FEAgentPanel />

      <Dialog
        open={observatoryOpen}
        onClose={() => setObservatoryOpen(false)}
        fullWidth
        maxWidth="lg"
        PaperProps={{ sx: { height: '80vh' } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
          <Typography variant="h6">Observatory</Typography>
          <IconButton onClick={() => setObservatoryOpen(false)} size="small" aria-label="Close Observatory">
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

export default Dashboard

const TopBar: React.FC<{ onOpenObservatory: () => void }> = ({ onOpenObservatory }) => {
  const { wsState, graphStats, toggleSkillPanel, voiceState, cameraState, sessionStart } = useAppStore()
  const isDevMode = useDevMode()
  const elapsed = useSessionTimer(sessionStart)

  return (
    <AppBar position="static" sx={{ backgroundColor: '#B8D9C6' }}>
      <Toolbar>
        <Stack justifyContent="space-between" direction="row" spacing={2} width="100%">
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="h6" color="text.secondary">Sylphie</Typography>
            <Typography variant="body2" color="text.secondary">Session: {elapsed}</Typography>
            <Typography variant="body2" color="text.secondary">{graphStats.nodes} nodes, {graphStats.edges} edges</Typography>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={2}>
            <StatusDot state={wsState.graph} label="Graph" />
            <StatusDot state={wsState.conversation} label="Chat" />
            <StatusDot state={wsState.telemetry} label="Telemetry" />
            <StatusDot state={voiceState.available ? 'connected' : 'disconnected'} label="Audio" />
            <StatusDot state={cameraState.active ? 'connected' : 'disconnected'} label="Video" />
            <Button
              startIcon={<BarChartIcon />}
              color="inherit"
              variant="outlined"
              size="small"
              onClick={onOpenObservatory}
              sx={{ color: (theme) => theme.palette.background.default }}
            >
              Observatory
            </Button>
            {isDevMode && (
              <Button startIcon={<ExtensionIcon />} color="inherit" variant="outlined" size="small" onClick={toggleSkillPanel} sx={{ color: (theme) => theme.palette.background.default }}>
                Skills
              </Button>
            )}
          </Stack>
        </Stack>
      </Toolbar>
    </AppBar>
  )
}

const Panel = ({ children, sx: sxOverride }: { children: React.ReactNode; sx?: Record<string, unknown> }) => (
  <Box
    sx={{
      backgroundColor: 'rgb(117 191 156 / 20%)',
      borderRadius: 2,
      border: '2px dashed rgba(184, 217, 198, 0.3)',
      boxSizing: 'border-box',
      p: 1,
      ...sxOverride,
    }}
  >
    {children}
  </Box>
)

const StatusDot: React.FC<{ state: WSState; label: string }> = ({ state, label }) => {
  const getColor = (theme: Theme) => {
    switch (state) {
      case 'connected': return theme.palette.success.main
      case 'reconnecting': return theme.palette.warning.main
      case 'disconnected': return theme.palette.error.main
      default: return theme.palette.info.main
    }
  }
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Box sx={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: (theme) => getColor(theme) }} />
      <Typography sx={{ lineHeight: 1.8, fontWeight: 700 }} color="text.secondary">{label}</Typography>
    </Stack>
  )
}
