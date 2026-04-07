import React, { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box,
  ButtonBase,
  Stack,
  Typography,
} from '@mui/material'
import {
  Hub as HubIcon,
  Insights as InsightsIcon,
  ChatBubbleOutline as ChatIcon,
  Logout as LogoutIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useSessionTimer } from '../../hooks/useSessionTimer'

// ---------------------------------------------------------------------------
// Sidebar width — exported so DashboardLayout can offset the content area
// ---------------------------------------------------------------------------
export const SIDEBAR_WIDTH = 232

// ---------------------------------------------------------------------------
// Drive-pressure → hue mapping for the pulse ribbon
// Dominant drive pressure tints the ribbon:
//   curiosity/focus → blue, anxiety/guilt → orange-red, satisfaction → green
// Falls back to calm sage green (#B8D9C6) when idle / low pressure.
// ---------------------------------------------------------------------------
const DRIVE_HUE_MAP: Record<string, number> = {
  curiosity: 210,
  focus: 220,
  social: 200,
  anxiety: 20,
  guilt: 10,
  sadness: 240,
  boredom: 50,
  satisfaction: 140,
  system_health: 160,
  moral_valence: 45,
  integrity: 170,
  cognitive_awareness: 190,
}

function useDominantHue(): { hue: number; intensity: number } {
  const pressure = useAppStore((s) => s.pressure)

  return useMemo(() => {
    let maxKey = 'system_health'
    let maxVal = 0
    for (const [key, val] of Object.entries(pressure)) {
      const v = typeof val === 'number' ? val : 0
      if (v > maxVal) {
        maxVal = v
        maxKey = key
      }
    }
    return {
      hue: DRIVE_HUE_MAP[maxKey] ?? 160,
      intensity: Math.min(maxVal, 1),
    }
  }, [pressure])
}

// ---------------------------------------------------------------------------
// Executor-state → animation speed mapping
// ---------------------------------------------------------------------------
const EXECUTOR_PULSE_SPEED: Record<string, string> = {
  idle: '4s',
  categorizing: '2s',
  executing: '1.2s',
  observing: '2.5s',
  learning: '1.8s',
  cooling_down: '3.5s',
}

// ---------------------------------------------------------------------------
// PulseRibbon — thin animated gradient on the sidebar's right edge
// ---------------------------------------------------------------------------
const PulseRibbon: React.FC = () => {
  const executorState = useAppStore((s) => s.executorState)
  const { hue, intensity } = useDominantHue()
  const speed = EXECUTOR_PULSE_SPEED[executorState] ?? '4s'

  // Intensity drives opacity — low pressure = barely visible, high = vivid
  const alpha = 0.15 + intensity * 0.6

  return (
    <Box
      sx={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '2px',
        zIndex: 2,
        background: `linear-gradient(
          180deg,
          hsla(${hue}, 80%, 65%, 0) 0%,
          hsla(${hue}, 80%, 65%, ${alpha}) 30%,
          hsla(${hue}, 90%, 55%, ${alpha * 0.8}) 50%,
          hsla(${hue}, 80%, 65%, ${alpha}) 70%,
          hsla(${hue}, 80%, 65%, 0) 100%
        )`,
        animation: `pulseSlide ${speed} ease-in-out infinite`,
        '@keyframes pulseSlide': {
          '0%': { opacity: 0.4, transform: 'scaleY(0.85)' },
          '50%': { opacity: 1, transform: 'scaleY(1)' },
          '100%': { opacity: 0.4, transform: 'scaleY(0.85)' },
        },
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// StatusMicro — tiny connection indicator dot
// ---------------------------------------------------------------------------
const StatusMicro: React.FC<{ label: string; connected: boolean }> = ({ label, connected }) => (
  <Stack direction="row" alignItems="center" spacing={0.5}>
    <Box
      sx={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        bgcolor: connected ? '#66BB6A' : '#EF5350',
        boxShadow: connected ? '0 0 4px rgba(102,187,106,0.5)' : 'none',
        transition: 'all 0.4s ease',
      }}
    />
    <Typography
      sx={{
        fontSize: '0.55rem',
        fontFamily: 'monospace',
        color: 'rgba(255,255,255,0.35)',
        letterSpacing: 0.3,
        lineHeight: 1,
      }}
    >
      {label}
    </Typography>
  </Stack>
)

// ---------------------------------------------------------------------------
// NavItem — single navigation link with active state glow
// ---------------------------------------------------------------------------
interface NavItemProps {
  icon: React.ReactNode
  label: string
  to: string
  accentHue?: number // HSL hue for active glow
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, to, accentHue = 152 }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const isActive = location.pathname === to || location.pathname.startsWith(to + '/')

  return (
    <ButtonBase
      onClick={() => navigate(to)}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.5,
        py: 1,
        borderRadius: 1.5,
        position: 'relative',
        overflow: 'hidden',
        textAlign: 'left',
        transition: 'all 0.2s ease',
        // Active: radial glow background + left accent
        bgcolor: isActive
          ? `hsla(${accentHue}, 40%, 45%, 0.12)`
          : 'transparent',
        '&:hover': {
          bgcolor: isActive
            ? `hsla(${accentHue}, 40%, 45%, 0.16)`
            : 'rgba(255,255,255,0.04)',
        },
        // Left accent bar
        '&::before': isActive
          ? {
              content: '""',
              position: 'absolute',
              left: 0,
              top: '15%',
              bottom: '15%',
              width: 3,
              borderRadius: '0 2px 2px 0',
              bgcolor: `hsl(${accentHue}, 45%, 65%)`,
              boxShadow: `0 0 8px hsla(${accentHue}, 60%, 55%, 0.4)`,
            }
          : {},
      }}
    >
      <Box
        sx={{
          color: isActive ? `hsl(${accentHue}, 45%, 70%)` : 'rgba(255,255,255,0.4)',
          display: 'flex',
          alignItems: 'center',
          fontSize: '1.15rem',
          transition: 'color 0.2s ease',
          '& .MuiSvgIcon-root': { fontSize: '1.15rem' },
        }}
      >
        {icon}
      </Box>
      <Typography
        sx={{
          fontSize: '0.8rem',
          fontWeight: isActive ? 600 : 400,
          color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
          letterSpacing: 0.2,
          transition: 'color 0.2s ease',
        }}
      >
        {label}
      </Typography>
    </ButtonBase>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
export const Sidebar: React.FC = () => {
  const wsState = useAppStore((s) => s.wsState)
  const graphStats = useAppStore((s) => s.graphStats)
  const executorState = useAppStore((s) => s.executorState)
  const sessionStart = useAppStore((s) => s.sessionStart)
  const clearAuth = useAppStore((s) => s.clearAuth)
  const navigate = useNavigate()
  const elapsed = useSessionTimer(sessionStart)

  const handleLogout = () => {
    clearAuth()
    navigate('/')
  }

  return (
    <Box
      sx={{
        width: SIDEBAR_WIDTH,
        minWidth: SIDEBAR_WIDTH,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#0a0e17',
        position: 'relative',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
        // Subtle noise texture via CSS
        '&::after': {
          content: '""',
          position: 'absolute',
          inset: 0,
          opacity: 0.015,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          pointerEvents: 'none',
          zIndex: 0,
        },
      }}
    >
      <PulseRibbon />

      {/* ── Brand section ─────────────────────────────────────────── */}
      <Box sx={{ px: 2, pt: 2.5, pb: 1.5, position: 'relative', zIndex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
          {/* Executor state pulse dot */}
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              bgcolor: executorState === 'idle' ? 'rgba(184,217,198,0.6)' : '#66BB6A',
              boxShadow:
                executorState !== 'idle'
                  ? '0 0 8px rgba(102,187,106,0.5)'
                  : '0 0 4px rgba(184,217,198,0.3)',
              animation:
                executorState !== 'idle'
                  ? 'dotPulse 1.5s ease-in-out infinite'
                  : 'dotPulse 3s ease-in-out infinite',
              '@keyframes dotPulse': {
                '0%': { transform: 'scale(1)', opacity: 0.7 },
                '50%': { transform: 'scale(1.3)', opacity: 1 },
                '100%': { transform: 'scale(1)', opacity: 0.7 },
              },
            }}
          />
          <Typography
            sx={{
              fontSize: '1.1rem',
              fontWeight: 700,
              color: '#B8D9C6',
              letterSpacing: 1.5,
              textTransform: 'uppercase',
            }}
          >
            Sylphie
          </Typography>
        </Box>

        {/* Connection status micro-dots */}
        <Stack direction="row" spacing={1.5} sx={{ pl: 0.25 }}>
          <StatusMicro label="WKG" connected={wsState.graph === 'connected'} />
          <StatusMicro label="Chat" connected={wsState.conversation === 'connected'} />
          <StatusMicro label="Telem" connected={wsState.telemetry === 'connected'} />
        </Stack>
      </Box>

      {/* ── Divider ───────────────────────────────────────────────── */}
      <Box
        sx={{
          mx: 2,
          height: '1px',
          bgcolor: 'rgba(184,217,198,0.1)',
          mb: 1,
        }}
      />

      {/* ── Navigation ────────────────────────────────────────────── */}
      <Box sx={{ flex: 1, px: 1, position: 'relative', zIndex: 1 }}>
        <Typography
          sx={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: 'rgba(255,255,255,0.2)',
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            px: 1.5,
            mb: 0.75,
            mt: 0.5,
          }}
        >
          Dashboard
        </Typography>

        <Stack spacing={0.25}>
          <NavItem
            icon={<HubIcon />}
            label="Knowledge Graphs"
            to="/dashboard/graphs"
            accentHue={210} // blue — knowledge/structure
          />
          <NavItem
            icon={<InsightsIcon />}
            label="Analytics"
            to="/dashboard/analytics"
            accentHue={35} // amber — metrics/data
          />
          <NavItem
            icon={<ChatIcon />}
            label="Chat"
            to="/dashboard/chat"
            accentHue={152} // sage green — conversation/organic
          />
        </Stack>
      </Box>

      {/* ── Session vitals strip ──────────────────────────────────── */}
      <Box
        sx={{
          mx: 2,
          height: '1px',
          bgcolor: 'rgba(184,217,198,0.1)',
          mb: 1,
        }}
      />
      <Box sx={{ px: 2, pb: 1, position: 'relative', zIndex: 1 }}>
        <Stack direction="row" spacing={1.5} sx={{ mb: 0.5 }}>
          <Typography
            sx={{
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.3)',
              lineHeight: 1.2,
            }}
          >
            {elapsed}
          </Typography>
          <Typography
            sx={{
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.25)',
              lineHeight: 1.2,
            }}
          >
            {graphStats.nodes}n {graphStats.edges}e
          </Typography>
        </Stack>
        <Typography
          sx={{
            fontSize: '0.55rem',
            fontFamily: 'monospace',
            color: 'rgba(255,255,255,0.2)',
            lineHeight: 1.2,
          }}
        >
          executor: {executorState}
        </Typography>
      </Box>

      {/* ── Logout ────────────────────────────────────────────────── */}
      <Box sx={{ px: 1, pb: 2, position: 'relative', zIndex: 1 }}>
        <ButtonBase
          onClick={handleLogout}
          sx={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 1.5,
            py: 0.75,
            borderRadius: 1.5,
            transition: 'all 0.2s ease',
            '&:hover': {
              bgcolor: 'rgba(239,83,80,0.08)',
              '& .logout-icon': { color: '#EF5350' },
              '& .logout-text': { color: 'rgba(239,83,80,0.8)' },
            },
          }}
        >
          <LogoutIcon
            className="logout-icon"
            sx={{
              fontSize: '1rem',
              color: 'rgba(255,255,255,0.25)',
              transition: 'color 0.2s ease',
            }}
          />
          <Typography
            className="logout-text"
            sx={{
              fontSize: '0.78rem',
              color: 'rgba(255,255,255,0.3)',
              transition: 'color 0.2s ease',
            }}
          >
            Logout
          </Typography>
        </ButtonBase>
      </Box>
    </Box>
  )
}
