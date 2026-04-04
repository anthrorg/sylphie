import { createTheme } from '@mui/material'

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#64B5F6',
    },
    secondary: {
      main: '#CE93D8',
    },
    background: {
      default: '#111827',
      paper: '#1a1a2e',
    },
    text: {
      primary: '#E0E0E0',
      secondary: '#111827',
    },
    error: {
      main: '#EF5350',
    },
    warning: {
      main: '#FFB74D',
    },
    success: {
      main: '#66BB6A',
    },
    divider: 'rgba(255,255,255,0.12)',
  },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          padding: 0,
          height: '100vh',
          overflow: 'hidden',
        },
        '#root': {
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
        },
      },
    },
  },
})
export default theme
