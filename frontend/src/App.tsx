import React, { useEffect } from 'react'
import { CssBaseline, ThemeProvider, CircularProgress, Box } from '@mui/material'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import theme from './theme'
import Dashboard from './Dashboard'
import DashboardLayout from './layouts/DashboardLayout'
import { LoginPage } from './pages/LoginPage'
import { GraphsView } from './pages/dashboard/GraphsView'
import { AnalyticsView } from './pages/dashboard/AnalyticsView'
import { ChatView } from './pages/dashboard/ChatView'
import { GuardianView } from './pages/dashboard/GuardianView'
import { useAppStore } from './store'
import { useAnalyticsPageviews } from './lib/analytics'
import { classifyAuthMeStatus } from './lib/authMeOutcome'

function AuthGate() {
  // Must run inside <BrowserRouter> so it can call useLocation().
  useAnalyticsPageviews()


  const authToken = useAppStore((s) => s.authToken)
  const authChecked = useAppStore((s) => s.authChecked)
  const setAuth = useAppStore((s) => s.setAuth)
  const clearAuth = useAppStore((s) => s.clearAuth)
  const setAuthChecked = useAppStore((s) => s.setAuthChecked)

  useEffect(() => {
    if (!authToken) {
      setAuthChecked(true)
      return
    }

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((res) => {
        // TK-147: only a 401 (the token itself is invalid/expired) means the
        // guardian is actually logged out. A transient 5xx or a network
        // blip is NOT a reason to delete the stored token and boot them back
        // to the login page — that used to happen unconditionally in the
        // .catch() below for ANY failure, including a momentary backend hiccup.
        const outcome = classifyAuthMeStatus(res.status)
        if (outcome === 'unauthenticated') {
          clearAuth()
          return null
        }
        if (outcome === 'transient') {
          // Leave the token intact and stop the auth spinner. The stored
          // authToken (already in state from localStorage) still lets the
          // app render; retrying /api/auth/me happens naturally on the next
          // reload or WS reconnect.
          setAuthChecked(true)
          return null
        }
        return res.json()
      })
      .then((user) => {
        if (user) setAuth(authToken, user)
      })
      .catch(() => {
        // Network error (offline, DNS, etc.) — also transient; do NOT clear auth.
        setAuthChecked(true)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!authChecked) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (!authToken) {
    return <LoginPage />
  }

  return (
    <Routes>
      {/* New dashboard with left sidebar navigation */}
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<Navigate to="graphs" replace />} />
        <Route path="graphs" element={<GraphsView />} />
        <Route path="analytics" element={<AnalyticsView />} />
        <Route path="chat" element={<ChatView />} />
        <Route path="guardian" element={<GuardianView />} />
      </Route>
      {/* Legacy dashboard — original single-page view at /legacy */}
      <Route path="/legacy" element={<Dashboard />} />
      {/* Default: redirect to new dashboard */}
      <Route path="/*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
