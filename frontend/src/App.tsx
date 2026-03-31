import React from 'react'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import theme from './theme'
import Dashboard from './Dashboard'

const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/*" element={<Dashboard />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
