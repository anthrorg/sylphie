import React from 'react'
import { Box, CircularProgress, Typography, Chip } from '@mui/material'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  type ChartOptions,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useAppStore } from '../../store'
import { TelemetryPressure } from '../../types'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

// Core drives split into two horizontal bar pairs for compact side-by-side display
const CORE_LEFT: Array<{ key: keyof TelemetryPressure; label: string }> = [
  { key: 'system_health', label: 'Health' },
  { key: 'moral_valence', label: 'Moral' },
]

const CORE_RIGHT: Array<{ key: keyof TelemetryPressure; label: string }> = [
  { key: 'integrity', label: 'Integrity' },
  { key: 'cognitive_awareness', label: 'Cognitive' },
]

// 8 complement drives (CANON A.17: 7 original + social added in A.25.1)
const COMPLEMENT_DRIVES: Array<{ key: keyof TelemetryPressure; label: string }> = [
  { key: 'guilt', label: 'Guilt' },
  { key: 'curiosity', label: 'Curiosity' },
  { key: 'boredom', label: 'Boredom' },
  { key: 'anxiety', label: 'Anxiety' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'sadness', label: 'Sadness' },
  { key: 'information_integrity', label: 'Info Integ.' },
  { key: 'social', label: 'Social' },
]

// Color coding per spec:
//   relief  (< 0)   => blue/teal
//   low     (< 0.3) => green
//   medium  (< 0.6) => amber
//   high    (< 0.8) => orange
//   critical(>= 0.8)=> red
const getBarColor = (value: number): string => {
  if (value < 0) return 'rgba(0, 188, 212, 0.8)' // teal -- extended relief
  if (value < 0.3) return 'rgba(76, 175, 80, 0.8)' // green
  if (value < 0.6) return 'rgba(255, 152, 0, 0.8)' // amber
  if (value < 0.8) return 'rgba(245, 124, 0, 0.8)' // orange
  return 'rgba(244, 67, 54, 0.8)' // red
}

// Staleness threshold in milliseconds
const STALE_THRESHOLD_MS = 5000

// Vertical bars for the 8 complement drives (wide aspect ratio)
// CANON range: [-10.0, 1.0]; zero line marks the neutral/pressure boundary
const compOptions: ChartOptions<'bar'> = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 4,
  layout: { padding: 0 },
  plugins: {
    tooltip: {
      callbacks: {
        // Show exact numeric value -- never smooth or round
        label: (ctx) => `${ctx.label}: ${(ctx.parsed.y ?? 0).toFixed(3)}`,
      },
    },
  },
  scales: {
    y: {
      min: -10,
      max: 1,
      display: true,
      ticks: {
        font: { size: 8 },
        color: (ctx) => {
          const v = ctx.tick?.value ?? 0
          // Highlight the zero tick so the neutral boundary is visually distinct
          if (v === 0) return 'rgba(255, 152, 0, 0.9)'
          return 'rgba(255,255,255,0.4)'
        },
        callback: (value) => {
          const v = Number(value)
          if (v === -10 || v === -5 || v === 0 || v === 1) return String(v)
          return null
        },
      },
      grid: {
        color: (ctx) => {
          const v = ctx.tick?.value ?? 0
          if (v === 0) return 'rgba(255, 152, 0, 0.45)'
          return 'rgba(255,255,255,0.06)'
        },
        lineWidth: (ctx) => {
          const v = ctx.tick?.value ?? 0
          return v === 0 ? 2 : 1
        },
      },
      border: { display: false },
    },
    x: {
      ticks: { font: { size: 10 } },
      grid: { display: false },
      border: { display: false },
    },
  },
}

// Horizontal bars for the core drive pairs
// CANON range: [-10.0, 1.0]; zero line marks the neutral/pressure boundary
const horizontalPairOptions: ChartOptions<'bar'> = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 2.5,
  indexAxis: 'y',
  layout: { padding: 0 },
  plugins: {
    tooltip: {
      callbacks: {
        // Show exact numeric value
        label: (ctx) => `${ctx.label}: ${(ctx.parsed.x ?? 0).toFixed(3)}`,
      },
    },
  },
  scales: {
    x: {
      min: -10,
      max: 1,
      display: true,
      ticks: {
        font: { size: 8 },
        color: (ctx) => {
          const v = ctx.tick?.value ?? 0
          if (v === 0) return 'rgba(255, 152, 0, 0.9)'
          return 'rgba(255,255,255,0.4)'
        },
        callback: (value) => {
          const v = Number(value)
          if (v === -10 || v === -5 || v === 0 || v === 1) return String(v)
          return null
        },
      },
      grid: {
        color: (ctx) => {
          const v = ctx.tick?.value ?? 0
          if (v === 0) return 'rgba(255, 152, 0, 0.45)'
          return 'rgba(255,255,255,0.06)'
        },
        lineWidth: (ctx) => {
          const v = ctx.tick?.value ?? 0
          return v === 0 ? 2 : 1
        },
      },
      border: { display: false },
    },
    y: {
      ticks: { font: { size: 11 }, crossAlign: 'center' },
      grid: { display: false },
      border: { display: false },
      // Force consistent label column width so the two side-by-side charts align
      afterFit: (axis) => {
        axis.width = 60
      },
    },
  },
}

// Shared loading placeholder used by both CoreDrivesChart and ComplementDrivesChart
const LoadingPlaceholder: React.FC<{ label: string }> = ({ label }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0.5,
      py: 2,
    }}
  >
    <CircularProgress size={18} sx={{ color: 'rgba(255,255,255,0.35)' }} />
    <Typography
      variant="caption"
      sx={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: '0.65rem' }}
    >
      {label}
    </Typography>
  </Box>
)

// Stale badge shown when telemetry has not updated within STALE_THRESHOLD_MS
const StaleBadge: React.FC = () => (
  <Chip
    label="Stale"
    size="small"
    sx={{
      position: 'absolute',
      top: 2,
      right: 2,
      fontSize: '0.58rem',
      height: 16,
      bgcolor: 'rgba(244, 67, 54, 0.12)',
      color: '#f44336',
      border: '1px solid rgba(244, 67, 54, 0.35)',
      fontFamily: 'monospace',
    }}
  />
)

export const CoreDrivesChart: React.FC = () => {
  const pressure = useAppStore((s) => s.pressure)
  const pressureSeq = useAppStore((s) => s.pressureSequenceNumber)
  const pressureTimestampMs = useAppStore((s) => s.pressureTimestampMs)
  const pressureIsStale = useAppStore((s) => s.pressureIsStale)

  const hasData = pressureSeq > 0
  const isStale =
    pressureIsStale ||
    (pressureTimestampMs > 0 && Date.now() - pressureTimestampMs > STALE_THRESHOLD_MS)

  if (!hasData) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography
          variant="overline"
          sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
        >
          Core Drives
        </Typography>
        <LoadingPlaceholder label="Waiting for drive data..." />
      </Box>
    )
  }

  const leftValues = CORE_LEFT.map((d) => pressure[d.key] ?? 0)
  const rightValues = CORE_RIGHT.map((d) => pressure[d.key] ?? 0)

  const coreLeftData = {
    labels: CORE_LEFT.map((d) => d.label),
    datasets: [
      {
        data: leftValues,
        backgroundColor: leftValues.map(getBarColor),
        borderRadius: 3,
        barPercentage: 0.6,
      },
    ],
  }

  const coreRightData = {
    labels: CORE_RIGHT.map((d) => d.label),
    datasets: [
      {
        data: rightValues,
        backgroundColor: rightValues.map(getBarColor),
        borderRadius: 3,
        barPercentage: 0.6,
      },
    ],
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography
        variant="overline"
        sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
      >
        Core Drives
      </Typography>
      <Box
        sx={{
          display: 'flex',
          gap: 1,
          position: 'relative',
          opacity: isStale ? 0.55 : 1,
          transition: 'opacity 0.4s ease',
        }}
      >
        {isStale && <StaleBadge />}
        <Box sx={{ flex: 1 }}>
          <Bar data={coreLeftData} options={horizontalPairOptions} />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Bar data={coreRightData} options={horizontalPairOptions} />
        </Box>
      </Box>
    </Box>
  )
}

export const ComplementDrivesChart: React.FC = () => {
  const pressure = useAppStore((s) => s.pressure)
  const pressureSeq = useAppStore((s) => s.pressureSequenceNumber)
  const pressureTimestampMs = useAppStore((s) => s.pressureTimestampMs)
  const pressureIsStale = useAppStore((s) => s.pressureIsStale)

  const hasData = pressureSeq > 0
  const isStale =
    pressureIsStale ||
    (pressureTimestampMs > 0 && Date.now() - pressureTimestampMs > STALE_THRESHOLD_MS)

  if (!hasData) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography
          variant="overline"
          sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
        >
          Complement Drives
        </Typography>
        <LoadingPlaceholder label="Waiting for drive data..." />
      </Box>
    )
  }

  const compValues = COMPLEMENT_DRIVES.map((d) => pressure[d.key] ?? 0)

  const compData = {
    labels: COMPLEMENT_DRIVES.map((d) => d.label),
    datasets: [
      {
        data: compValues,
        backgroundColor: compValues.map(getBarColor),
        borderRadius: 3,
        barPercentage: 0.7,
      },
    ],
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        position: 'relative',
      }}
    >
      <Typography
        variant="overline"
        sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
      >
        Complement Drives
      </Typography>
      <Box
        sx={{
          position: 'relative',
          opacity: isStale ? 0.55 : 1,
          transition: 'opacity 0.4s ease',
        }}
      >
        {isStale && <StaleBadge />}
        <Bar data={compData} options={compOptions} />
      </Box>
    </Box>
  )
}
