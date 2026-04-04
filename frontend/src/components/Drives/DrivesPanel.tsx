import React, { useState } from 'react'
import {
  Box,
  Button,
  Collapse,
  Divider,
  IconButton,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SignalWifiOffIcon from '@mui/icons-material/SignalWifiOff'
import SignalWifi4BarIcon from '@mui/icons-material/SignalWifi4Bar'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import TuneIcon from '@mui/icons-material/Tune'
import { useAppStore } from '../../store'
import { useDriveOverrides } from '../../hooks/useDriveOverrides'
import { usePressureStatus } from '../../hooks/usePressureStatus'
import { TelemetryPressure } from '../../types'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// CANON A.17: 4 core drives form the primary homeostatic axes
const CORE_DRIVES: Array<{ key: keyof TelemetryPressure; label: string }> = [
  { key: 'system_health', label: 'System Health' },
  { key: 'moral_valence', label: 'Moral Valence' },
  { key: 'integrity', label: 'Integrity' },
  { key: 'cognitive_awareness', label: 'Cog Awareness' },
]

// CANON A.17 + A.25.1: 8 complement drives (7 original + social)
const COMPLEMENT_DRIVES: Array<{ key: keyof TelemetryPressure; label: string }> = [
  { key: 'guilt', label: 'Guilt' },
  { key: 'curiosity', label: 'Curiosity' },
  { key: 'boredom', label: 'Boredom' },
  { key: 'anxiety', label: 'Anxiety' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'sadness', label: 'Sadness' },
  { key: 'focus', label: 'Focus' },
  { key: 'social', label: 'Social' },
]

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// Color coding for the full CANON range [-10.0, 1.0]:
//   relief (< 0)    => teal/blue (extended relief, drive below neutral)
//   low    (< 0.3)  => green
//   medium (< 0.6)  => amber
//   high   (< 0.8)  => orange
//   critical(>= 0.8)=> red
const getDriveColor = (value: number): string => {
  if (value < 0) return '#00bcd4' // teal -- extended relief
  if (value < 0.3) return '#4caf50'
  if (value < 0.6) return '#ff9800'
  if (value < 0.8) return '#f57c00'
  return '#f44336'
}

/* ------------------------------------------------------------------ */
/*  DriveRow (read-only)                                               */
/* ------------------------------------------------------------------ */

interface DriveRowProps {
  label: string
  value: number
  overrideActive?: boolean
}

const DriveRow: React.FC<DriveRowProps> = ({ label, value, overrideActive }) => {
  const color = getDriveColor(value)

  // Bidirectional bar spanning the full CANON range [-10.0, 1.0].
  // Total range = 11 units. Zero sits at 10/11 ~90.9% from the left edge.
  // For positive values: fill extends rightward from the zero point.
  // For negative values: fill extends leftward from the zero point.
  const RANGE = 11 // 1 - (-10)
  const ZERO_PCT = (10 / RANGE) * 100 // ~90.9%

  // Width of the fill as a percentage of the total bar width
  const fillPct = (Math.abs(value) / RANGE) * 100
  // Fill starts at the zero point and extends left (negative) or right (positive)
  const fillLeft = value < 0 ? ZERO_PCT - fillPct : ZERO_PCT
  const fillRight = value >= 0 ? 100 - (ZERO_PCT + fillPct) : 100 - ZERO_PCT

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, minHeight: 28 }}>
      {/* Label */}
      <Typography
        variant="caption"
        sx={{
          width: 110,
          minWidth: 110,
          fontSize: '0.68rem',
          color: overrideActive ? '#1976d2' : 'text.secondary',
          fontFamily: 'monospace',
          textAlign: 'right',
          pr: 0.5,
          lineHeight: 1.2,
          fontWeight: overrideActive ? 600 : 400,
        }}
      >
        {/* Blue dot prefix indicates override is active */}
        {overrideActive ? '\u25CF ' : ''}
        {label}
      </Typography>

      {/* Bidirectional bar -- zero is at ~90.9% from left; fills inward for relief, outward for pressure */}
      <Box
        sx={{
          flex: 1,
          minWidth: 60,
          height: 10,
          borderRadius: 1,
          bgcolor: 'rgba(0,0,0,0.08)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Zero marker line */}
        <Box
          sx={{
            position: 'absolute',
            left: `${ZERO_PCT}%`,
            top: 0,
            bottom: 0,
            width: 1,
            bgcolor: 'rgba(255,255,255,0.25)',
            zIndex: 1,
          }}
        />
        {/* Value fill */}
        <Box
          sx={{
            position: 'absolute',
            left: `${fillLeft}%`,
            right: `${fillRight}%`,
            top: 0,
            bottom: 0,
            bgcolor: overrideActive ? '#1976d2' : color,
            borderRadius: 1,
          }}
        />
      </Box>

      {/* Value -- shows raw numeric, handles negatives correctly */}
      <Typography
        variant="caption"
        sx={{
          width: 38,
          minWidth: 38,
          fontSize: '0.68rem',
          fontFamily: 'monospace',
          textAlign: 'right',
          color: 'text.primary',
        }}
      >
        {value.toFixed(2)}
      </Typography>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/*  DriveControlRow (editable — shown in controls section)             */
/* ------------------------------------------------------------------ */

interface DriveControlRowProps {
  driveKey: string
  label: string
  value: number
  driftRate: number
  overrideEnabled: boolean
  onOverrideToggle: (key: string, enabled: boolean) => void
  onOverrideValue: (key: string, value: number) => void
  onDriftChange: (key: string, rate: number) => void
}

const DriveControlRow: React.FC<DriveControlRowProps> = ({
  driveKey,
  label,
  value,
  driftRate,
  overrideEnabled,
  onOverrideToggle,
  onOverrideValue,
  onDriftChange,
}) => {
  const color = getDriveColor(value)

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, minHeight: 28 }}>
      {/* Label */}
      <Typography
        variant="caption"
        sx={{
          width: 90,
          minWidth: 90,
          fontSize: '0.62rem',
          color: overrideEnabled ? '#1976d2' : 'text.secondary',
          fontFamily: 'monospace',
          textAlign: 'right',
          pr: 0.5,
          lineHeight: 1.2,
        }}
      >
        {label}
      </Typography>

      {/* Override toggle */}
      <Tooltip title={overrideEnabled ? 'Override ON' : 'Override OFF'} placement="top" arrow>
        <Switch
          size="small"
          checked={overrideEnabled}
          onChange={(_e, checked) => onOverrideToggle(driveKey, checked)}
          sx={{
            width: 32,
            height: 18,
            p: 0,
            '& .MuiSwitch-switchBase': {
              p: '2px',
              '&.Mui-checked': {
                transform: 'translateX(14px)',
                color: '#fff',
                '& + .MuiSwitch-track': {
                  bgcolor: '#1976d2',
                  opacity: 1,
                },
              },
            },
            '& .MuiSwitch-thumb': { width: 14, height: 14 },
            '& .MuiSwitch-track': {
              borderRadius: 9,
              bgcolor: 'rgba(0,0,0,0.2)',
              opacity: 1,
            },
          }}
        />
      </Tooltip>

      {/* Slider (only interactive when override is on) -- full CANON range [-10, 1] */}
      <Box sx={{ flex: 1, minWidth: 50 }}>
        <Slider
          size="small"
          min={-10}
          max={1}
          step={0.01}
          value={value}
          disabled={!overrideEnabled}
          onChange={(_e, v) => onOverrideValue(driveKey, v as number)}
          sx={{
            py: 0,
            color: overrideEnabled ? '#1976d2' : color,
            '& .MuiSlider-thumb': { width: 12, height: 12 },
            '& .MuiSlider-rail': { opacity: 0.3 },
          }}
        />
      </Box>

      {/* Drift rate: continuous per-second change applied to the drive (for simulating pressure ramps) */}
      <Tooltip title="Drift rate / sec" placement="top" arrow>
        <TextField
          size="small"
          type="number"
          value={driftRate}
          onChange={(e) => {
            const raw = parseFloat(e.target.value)
            if (!isNaN(raw)) {
              onDriftChange(driveKey, raw)
            }
          }}
          inputProps={{
            min: -0.1,
            max: 0.1,
            step: 0.001,
            style: {
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              padding: '2px 4px',
              width: 48,
              textAlign: 'right',
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              height: 22,
            },
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: 'rgba(0,0,0,0.12)',
            },
          }}
        />
      </Tooltip>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/*  DrivesPanel                                                        */
/* ------------------------------------------------------------------ */

export const DrivesPanel: React.FC = () => {
  const pressure = useAppStore((state) => state.pressure)
  const dynamicThreshold = useAppStore((state) => state.dynamicThreshold)

  const [showControls, setShowControls] = useState<boolean>(false)

  const { isConnected, isStale } = usePressureStatus()
  const {
    overrides,
    overrideValues,
    driftRates,
    handleOverrideToggle,
    handleOverrideValue,
    handleDriftChange,
    handleResetAll,
  } = useDriveOverrides()

  const renderDriveRows = (drives: Array<{ key: keyof TelemetryPressure; label: string }>) =>
    drives.map((drive) => (
      <DriveRow
        key={drive.key}
        label={drive.label}
        value={pressure[drive.key] ?? 0}
        overrideActive={overrides[drive.key] ?? false}
      />
    ))

  const renderControlRows = (drives: Array<{ key: keyof TelemetryPressure; label: string }>) =>
    drives.map((drive) => (
      <DriveControlRow
        key={drive.key}
        driveKey={drive.key}
        label={drive.label}
        value={overrideValues[drive.key] ?? pressure[drive.key] ?? 0}
        driftRate={driftRates[drive.key] ?? 0}
        overrideEnabled={overrides[drive.key] ?? false}
        onOverrideToggle={handleOverrideToggle}
        onOverrideValue={handleOverrideValue}
        onDriftChange={handleDriftChange}
      />
    ))

  return (
    <Box sx={{ px: 1.5, py: 1 }}>
      {/* Header row: title + connection status + threshold + controls toggle */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 0.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography
            variant="overline"
            sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
          >
            Core Drives
          </Typography>
          <Tooltip
            title={
              isConnected
                ? 'Drive Engine connected'
                : isStale
                  ? 'Drive Engine disconnected (stale data)'
                  : 'Drive Engine disconnected'
            }
            placement="top"
            arrow
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              {isConnected ? (
                <SignalWifi4BarIcon sx={{ fontSize: '0.85rem', color: '#4caf50' }} />
              ) : (
                <SignalWifiOffIcon sx={{ fontSize: '0.85rem', color: '#f44336' }} />
              )}
              <Typography
                variant="caption"
                sx={{
                  fontSize: '0.58rem',
                  fontFamily: 'monospace',
                  color: isConnected ? '#4caf50' : '#f44336',
                  bgcolor: 'rgba(0,0,0,0.04)',
                  px: 0.5,
                  borderRadius: 0.5,
                }}
              >
                {isConnected ? 'live' : 'offline'}
              </Typography>
            </Box>
          </Tooltip>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography
            variant="caption"
            sx={{ fontSize: '0.6rem', fontFamily: 'monospace', color: 'text.disabled' }}
          >
            {/* Dynamic threshold adapts based on overall pressure; drives above it trigger actions */}
            threshold: {(dynamicThreshold ?? 0).toFixed(2)}
          </Typography>
          <Tooltip
            title={showControls ? 'Hide controls' : 'Show drive controls'}
            placement="top"
            arrow
          >
            <IconButton
              size="small"
              onClick={() => setShowControls((prev) => !prev)}
              sx={{
                p: 0.3,
                color: showControls ? '#1976d2' : 'text.disabled',
              }}
            >
              <TuneIcon sx={{ fontSize: '1rem' }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Core drives (read-only telemetry) */}
      <Box
        sx={{
          bgcolor: 'rgba(22, 33, 62, 0.04)',
          borderRadius: 1,
          px: 1,
          py: 0.5,
          border: '1px solid rgba(22, 33, 62, 0.1)',
        }}
      >
        {renderDriveRows(CORE_DRIVES)}
      </Box>

      <Divider sx={{ my: 0.75 }} />

      {/* Complement drives header */}
      <Typography
        variant="overline"
        sx={{ fontSize: '0.65rem', fontWeight: 700, color: 'text.secondary', letterSpacing: 1 }}
      >
        Complement Drives
      </Typography>

      {/* Complement drives (read-only telemetry) */}
      <Box sx={{ px: 1, py: 0.5 }}>{renderDriveRows(COMPLEMENT_DRIVES)}</Box>

      {/* Collapsible controls section */}
      <Collapse in={showControls}>
        <Divider sx={{ my: 0.75 }} />

        {/* Controls header with reset button */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 0.5,
          }}
        >
          <Typography
            variant="overline"
            sx={{ fontSize: '0.65rem', fontWeight: 700, color: '#1976d2', letterSpacing: 1 }}
          >
            Drive Controls
          </Typography>
          <Tooltip title="Reset all overrides and drift rates" placement="left" arrow>
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={handleResetAll}
              disabled={false}
              startIcon={<RestartAltIcon sx={{ fontSize: '0.85rem !important' }} />}
              sx={{
                fontSize: '0.6rem',
                minWidth: 'auto',
                py: 0,
                px: 0.75,
                height: 22,
                textTransform: 'none',
                lineHeight: 1,
              }}
            >
              Reset
            </Button>
          </Tooltip>
        </Box>

        {/* Control rows: core drives */}
        <Box
          sx={{
            bgcolor: 'rgba(25, 118, 210, 0.04)',
            borderRadius: 1,
            px: 0.5,
            py: 0.5,
            border: '1px solid rgba(25, 118, 210, 0.15)',
            mb: 0.5,
          }}
        >
          <Typography
            variant="caption"
            sx={{ fontSize: '0.55rem', color: 'text.disabled', fontFamily: 'monospace', pl: 0.5 }}
          >
            override | slider | drift/s
          </Typography>
          {renderControlRows(CORE_DRIVES)}
        </Box>

        {/* Control rows: complement drives */}
        <Box
          sx={{
            bgcolor: 'rgba(25, 118, 210, 0.04)',
            borderRadius: 1,
            px: 0.5,
            py: 0.5,
            border: '1px solid rgba(25, 118, 210, 0.15)',
          }}
        >
          {renderControlRows(COMPLEMENT_DRIVES)}
        </Box>
      </Collapse>
    </Box>
  )
}
