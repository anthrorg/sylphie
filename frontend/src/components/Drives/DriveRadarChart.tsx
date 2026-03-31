import React from 'react'
import { Box, CircularProgress, Typography, Chip } from '@mui/material'
import {
  Chart as ChartJS,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  type ChartOptions,
} from 'chart.js'
import { Radar } from 'react-chartjs-2'
import { useAppStore } from '../../store'
import { TelemetryPressure } from '../../types'

ChartJS.register(RadialLinearScale, PointElement, LineElement, Filler, Tooltip)

// Core drives placed at compass points (N/E/S/W) with complement drives between them
// so the radar shape shows balance across all 12 drives
type DriveEntry = { key: keyof TelemetryPressure; label: string; core: boolean }

const RADAR_DRIVES: DriveEntry[] = [
  { key: 'system_health', label: 'Health', core: true }, // N
  { key: 'guilt', label: 'Guilt', core: false },
  { key: 'curiosity', label: 'Curiosity', core: false },
  { key: 'moral_valence', label: 'Moral', core: true }, // E
  { key: 'boredom', label: 'Boredom', core: false },
  { key: 'anxiety', label: 'Anxiety', core: false },
  { key: 'integrity', label: 'Integrity', core: true }, // S
  { key: 'satisfaction', label: 'Satisfaction', core: false },
  { key: 'sadness', label: 'Sadness', core: false },
  { key: 'cognitive_awareness', label: 'Cognitive', core: true }, // W
  { key: 'information_integrity', label: 'Info Integ.', core: false },
  { key: 'social', label: 'Social', core: false },
]

// CANON: full drive range is [-10.0, 1.0].
// With min: -10 the radar center = -10; the zero ring sits at 10/11 ~91% of radius,
// making negative values (extended relief) clearly visible as inward collapse past that ring.
const radarOptions: ChartOptions<'radar'> = {
  responsive: true,
  maintainAspectRatio: true,
  layout: { padding: 0 },
  animation: {
    duration: 600,
    easing: 'easeInOutCubic',
  },
  plugins: {
    tooltip: {
      callbacks: {
        // Show exact numeric value with drive label -- never round or smooth
        label: (ctx) => {
          const drive = RADAR_DRIVES[ctx.dataIndex]
          const label = drive ? drive.label : ctx.label
          const raw = ctx.raw as number
          return `${label}: ${raw.toFixed(3)}`
        },
      },
    },
  },
  scales: {
    r: {
      // Full CANON range: [-10.0, 1.0]
      min: -10,
      max: 1,
      // Display tick labels at critical thresholds so the zero crossing is visually obvious
      ticks: {
        display: true,
        stepSize: 5,
        font: { size: 8 },
        color: (ctx) => {
          // Highlight the zero tick in amber so the neutral boundary is unmistakable
          const value = ctx.tick?.value ?? 0
          if (value === 0) return 'rgba(255, 152, 0, 0.9)'
          return 'rgba(255,255,255,0.4)'
        },
        backdropColor: 'transparent',
        // Only show -10, -5, 0, 1 to avoid clutter
        callback: (value) => {
          const v = Number(value)
          if (v === -10 || v === -5 || v === 0 || v === 1) return String(v)
          return null
        },
      },
      pointLabels: { font: { size: 10 }, color: 'rgba(255,255,255,0.7)' },
      grid: {
        color: (ctx) => {
          // Paint the zero ring amber to mark the neutral/pressure boundary
          const value = ctx.tick?.value ?? 0
          if (value === 0) return 'rgba(255, 152, 0, 0.45)'
          return 'rgba(255,255,255,0.1)'
        },
      },
      angleLines: { color: 'rgba(255,255,255,0.1)' },
    },
  },
}

export const DriveRadarChart: React.FC = () => {
  const pressure = useAppStore((s) => s.pressure)
  const pressureSeq = useAppStore((s) => s.pressureSequenceNumber)
  const pressureTimestampMs = useAppStore((s) => s.pressureTimestampMs)
  const pressureIsStale = useAppStore((s) => s.pressureIsStale)

  const hasData = pressureSeq > 0
  const isStale =
    pressureIsStale ||
    (pressureTimestampMs > 0 && Date.now() - pressureTimestampMs > 5000)

  const labels = RADAR_DRIVES.map((d) => d.label)
  const getValue = (d: DriveEntry): number => pressure[d.key] ?? 0

  // Two overlapping datasets: core (green) and complement (orange)
  const coreValues = RADAR_DRIVES.map((d) => (d.core ? getValue(d) : 0))
  const compValues = RADAR_DRIVES.map((d) => (d.core ? 0 : getValue(d)))

  const data = {
    labels,
    datasets: [
      {
        label: 'Core',
        data: coreValues,
        backgroundColor: 'rgba(76, 175, 80, 0.2)',
        borderColor: 'rgba(76, 175, 80, 0.8)',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: 'rgba(76, 175, 80, 0.8)',
      },
      {
        label: 'Complement',
        data: compValues,
        backgroundColor: 'rgba(255, 152, 0, 0.15)',
        borderColor: 'rgba(255, 152, 0, 0.7)',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: 'rgba(255, 152, 0, 0.7)',
      },
    ],
  }

  // Loading state: no drive data has been received yet
  // Show a placeholder instead of an all-zeros chart that would look like real data
  if (!hasData) {
    return (
      <Box
        sx={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        <CircularProgress size={24} sx={{ color: 'rgba(255,255,255,0.4)' }} />
        <Typography
          variant="caption"
          sx={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: '0.7rem' }}
        >
          Waiting for drive data...
        </Typography>
      </Box>
    )
  }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        // Dim chart when stale so stale data is immediately distinguishable from live data
        opacity: isStale ? 0.55 : 1,
        transition: 'opacity 0.4s ease',
      }}
    >
      <Radar data={data} options={radarOptions} />

      {isStale && (
        <Chip
          label="Stale"
          size="small"
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            fontSize: '0.6rem',
            height: 18,
            bgcolor: 'rgba(244, 67, 54, 0.15)',
            color: '#f44336',
            border: '1px solid rgba(244, 67, 54, 0.4)',
            fontFamily: 'monospace',
          }}
        />
      )}
    </Box>
  )
}
