import React, { useEffect } from 'react'
import { CssBaseline, ThemeProvider, CircularProgress, Box } from '@mui/material'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import theme from './theme'
import Dashboard from './Dashboard'
import { LoginPage } from './pages/LoginPage'
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
