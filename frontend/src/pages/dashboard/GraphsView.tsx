import React from 'react'
import { Box, Typography } from '@mui/material'
import {
  AccountTree as AccountTreeIcon,
  Person as PersonIcon,
  Psychology as PsychologyIcon,
} from '@mui/icons-material'
import { GraphPanel } from '../../components/Graph/GraphPanel'

// ---------------------------------------------------------------------------
// Shared glass-panel style for the new dashboard views
// ---------------------------------------------------------------------------
const GlassPanel: React.FC<{
  children: React.ReactNode
  sx?: Record<string, unknown>
}> = ({ children, sx }) => (
  <Box
    sx={{
      bgcolor: 'rgba(255,255,255,0.03)',
      borderRadius: 2,
      border: '1px solid rgba(184,217,198,0.12)',
      boxSizing: 'border-box',
      position: 'relative',
      overflow: 'hidden',
      ...sx,
    }}
  >
    {children}
  </Box>
)

// ---------------------------------------------------------------------------
// KGPlaceholder — shows a styled empty state for graphs not yet wired
// ---------------------------------------------------------------------------
const KGPlaceholder: React.FC<{
  title: string
  subtitle: string
  icon: React.ReactNode
  accentColor: string
}> = ({ title, subtitle, icon, accentColor }) => (
  <Box
    sx={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 1.5,
      position: 'relative',
      // Subtle grid pattern background to suggest graph space
      backgroundImage: `
        linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
      `,
      backgroundSize: '24px 24px',
    }}
  >
    {/* Ambient glow behind icon */}
    <Box
      sx={{
        position: 'absolute',
        width: 120,
        height: 120,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${accentColor}15 0%, transparent 70%)`,
        filter: 'blur(20px)',
      }}
    />

    <Box sx={{ color: accentColor, opacity: 0.5, position: 'relative', zIndex: 1 }}>
      {React.cloneElement(icon as React.ReactElement, { sx: { fontSize: 40 } })}
    </Box>

    <Typography
      sx={{
        fontSize: '0.85rem',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.5)',
        letterSpacing: 0.5,
        position: 'relative',
        zIndex: 1,
      }}
    >
      {title}
    </Typography>

    <Typography
      sx={{
        fontSize: '0.65rem',
        color: 'rgba(255,255,255,0.25)',
        textAlign: 'center',
        maxWidth: 220,
        lineHeight: 1.4,
        position: 'relative',
        zIndex: 1,
      }}
    >
      {subtitle}
    </Typography>

    {/* Corner nodes decoration — small dots to suggest graph topology */}
    {[
      { top: 16, left: 20 },
      { top: 24, right: 40 },
      { bottom: 30, left: 50 },
      { bottom: 20, right: 25 },
      { top: 50, left: 80 },
      { top: 60, right: 70 },
    ].map((pos, i) => (
      <Box
        key={i}
        sx={{
          position: 'absolute',
          ...pos,
          width: 4 + (i % 3) * 2,
          height: 4 + (i % 3) * 2,
          borderRadius: '50%',
          bgcolor: `${accentColor}${20 + (i % 3) * 10}`,
          opacity: 0.4,
        }}
      />
    ))}
  </Box>
)

// ---------------------------------------------------------------------------
// Panel header — small label with icon
// ---------------------------------------------------------------------------
const PanelHeader: React.FC<{
  icon: React.ReactNode
  label: string
  color: string
}> = ({ icon, label, color }) => (
  <Box
    sx={{
      position: 'absolute',
      top: 8,
      right: 12,
      zIndex: 5,
      display: 'flex',
      alignItems: 'center',
      gap: 0.5,
      px: 1,
      py: 0.25,
      borderRadius: 1,
      bgcolor: 'rgba(0,0,0,0.5)',
      backdropFilter: 'blur(4px)',
    }}
  >
    <Box sx={{ color, display: 'flex', '& .MuiSvgIcon-root': { fontSize: '0.75rem' } }}>
      {icon}
    </Box>
    <Typography
      sx={{
        fontSize: '0.6rem',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.5)',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </Typography>
  </Box>
)

// ---------------------------------------------------------------------------
// GraphsView
// ---------------------------------------------------------------------------
export const GraphsView: React.FC = () => {
  return (
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
      {/* ── WKG — hero panel, takes ~62% of height ──────────────── */}
      <GlassPanel sx={{ flex: 5, minHeight: 0 }}>
        <PanelHeader
          icon={<AccountTreeIcon />}
          label="World Knowledge Graph"
          color="#64B5F6"
        />
        <Box sx={{ width: '100%', height: '100%' }}>
          <GraphPanel />
        </Box>
      </GlassPanel>

      {/* ── OKG + SKG — two equal panels below ─────────────────── */}
      <Box sx={{ flex: 3, display: 'flex', gap: 1, minHeight: 0 }}>
        {/* Other Knowledge Graph (Grafeo person models) */}
        <GlassPanel sx={{ flex: 1 }}>
          <PanelHeader
            icon={<PersonIcon />}
            label="Other KG"
            color="#CE93D8"
          />
          <KGPlaceholder
            title="Other Knowledge Graph"
            subtitle="Person models via Grafeo — tracks understanding of conversation partners"
            icon={<PersonIcon />}
            accentColor="#CE93D8"
          />
        </GlassPanel>

        {/* Self Knowledge Graph (Grafeo self model) */}
        <GlassPanel sx={{ flex: 1 }}>
          <PanelHeader
            icon={<PsychologyIcon />}
            label="Self KG"
            color="#FFB74D"
          />
          <KGPlaceholder
            title="Self Knowledge Graph"
            subtitle="Grafeo self-model — Sylphie's evolving understanding of her own capabilities and traits"
            icon={<PsychologyIcon />}
            accentColor="#FFB74D"
          />
        </GlassPanel>
      </Box>
    </Box>
  )
}
