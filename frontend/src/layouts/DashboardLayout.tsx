import React, { useEffect } from 'react'
import { Box } from '@mui/material'
import { Outlet } from 'react-router-dom'
import { Sidebar } from '../components/Navigation/Sidebar'
import { useAppStore } from '../store'
import { useGraphWebSocket, useTelemetryWebSocket } from '../hooks/useWebSocket'
import { NodeInspector } from '../components/Graph/NodeInspector'
import { SkillManager } from '../components/Skills/SkillManager'
import { FEAgentPanel } from '../components/FEAgent/FEAgentPanel'

/**
 * DashboardLayout — shell for the new /dashboard/* routes.
 * Renders the Sidebar on the left, routed content on the right.
 * Initialises WebSocket connections and voice status so child views
 * can read from the Zustand store without duplicating setup logic.
 */
const DashboardLayout: React.FC = () => {
  const setVoiceState = useAppStore((s) => s.setVoiceState)

  // Connect to backend WebSockets (graph + telemetry)
  useGraphWebSocket()
  useTelemetryWebSocket()

  // Fetch voice availability on mount
  useEffect(() => {
    fetch('/api/voice/status')
      .then((r) => r.json())
      .then((d) => setVoiceState({ available: d.available === true }))
      .catch(() => setVoiceState({ available: false }))
  }, [setVoiceState])

  return (
    <>
      <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Sidebar />
        <Box
          sx={{
            flex: 1,
            height: '100vh',
            overflow: 'auto',
            bgcolor: 'background.default',
            // Subtle inner shadow from sidebar edge
            boxShadow: 'inset 4px 0 12px rgba(0,0,0,0.15)',
          }}
        >
          <Outlet />
        </Box>
      </Box>

      {/* Floating overlays — shared across all dashboard views */}
      <SkillManager />
      <NodeInspector />
      <FEAgentPanel />
    </>
  )
}

export default DashboardLayout
