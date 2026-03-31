import React from 'react'
import { AppBar, Toolbar, Typography, Box, Button, Chip, Tooltip } from '@mui/material'
import {
  Circle as CircleIcon,
  Extension as ExtensionIcon,
  InsightsOutlined as InsightsIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useSessionTimer } from '../../hooks/useSessionTimer'
import { WSState } from '../../types'

// Reusable connection indicator: green=connected, yellow=reconnecting, red=disconnected
const StatusDot: React.FC<{ state: WSState; label: string }> = ({ state, label }) => {
  const getColor = (): 'success' | 'warning' | 'error' | 'default' => {
    switch (state) {
      case 'connected':
        return 'success'
      case 'reconnecting':
        return 'warning'
      case 'disconnected':
        return 'error'
      default:
        return 'default'
    }
  }

  return (
    <Tooltip title={`${label}: ${state}`}>
      <Chip
        icon={<CircleIcon />}
        label={label}
        color={getColor()}
        size="small"
        variant="outlined"
      />
    </Tooltip>
  )
}

export const TopBar: React.FC<{ onOpenObservatory?: () => void }> = ({ onOpenObservatory }) => {
  const { wsState, graphStats, toggleSkillPanel, voiceState, cameraState, sessionStart } =
    useAppStore()

  const elapsed = useSessionTimer(sessionStart)

  return (
    <AppBar position="static" sx={{ bgcolor: '#16213e' }}>
      <Toolbar>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
          Sylphie
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="body2" color="inherit">
            Session: {elapsed}
          </Typography>

          <Box sx={{ display: 'flex', gap: 1 }}>
            <StatusDot state={wsState.graph} label="Graph" />
            <StatusDot state={wsState.conversation} label="Chat" />
            <StatusDot state={wsState.telemetry} label="Telemetry" />
            {/* Audio/Video don't have WS connections; derive status from capability flags */}
            <StatusDot state={voiceState.available ? 'connected' : 'disconnected'} label="Audio" />
            <StatusDot state={cameraState.active ? 'connected' : 'disconnected'} label="Video" />
          </Box>

          <Typography variant="body2" color="inherit">
            {graphStats.nodes} nodes, {graphStats.edges} edges
          </Typography>

          {onOpenObservatory && (
            <Button
              startIcon={<InsightsIcon />}
              color="inherit"
              variant="outlined"
              size="small"
              onClick={onOpenObservatory}
            >
              Observatory
            </Button>
          )}

          <Button
            startIcon={<ExtensionIcon />}
            color="inherit"
            variant="outlined"
            size="small"
            onClick={toggleSkillPanel}
          >
            Skills
          </Button>
        </Box>
      </Toolbar>
    </AppBar>
  )
}
