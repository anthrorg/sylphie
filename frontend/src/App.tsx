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
import { useAppStore } from './store'

function AuthGate() {
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
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((user) => setAuth(authToken, user))
      .catch(() => clearAuth())
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
      </Route>
      {/* Legacy dashboard — original single-page view */}
      <Route path="/*" element={<Dashboard />} />
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
