import React from 'react'
import { Alert, AlertTitle, Collapse, IconButton, Typography, Box } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useObservatoryAlerts } from '../../hooks/useObservatoryAlerts'

/**
 * Alert banner that polls the Observatory API for attractor warnings.
 * Displays active warnings with risk level and intervention protocol.
 * Gracefully hidden when Observatory is unreachable.
 */
export const AttractorAlertBanner: React.FC = () => {
  const { alerts, reachable, dismissed, dismiss } = useObservatoryAlerts()

  // Dismissed alerts are hidden locally (not persisted); they reappear on page reload
  const visibleAlerts = alerts.filter((a) => !dismissed.has(a.attractor_id))

  if (!reachable || visibleAlerts.length === 0) return null

  // Maps Observatory risk levels to MUI Alert severity for visual consistency
  const severityMap: Record<string, 'error' | 'warning' | 'info'> = {
    CRITICAL: 'error',
    HIGH: 'warning',
    MEDIUM: 'info',
    LOW: 'info',
  }

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      {visibleAlerts.map((alert) => (
        <Collapse key={alert.attractor_id} in>
          <Alert
            severity={severityMap[alert.risk_level] || 'warning'}
            sx={{ mb: 0.5 }}
            action={
              <IconButton size="small" onClick={() => dismiss(alert.attractor_id)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          >
            <AlertTitle sx={{ fontSize: '0.85rem', mb: 0 }}>
              {alert.name} (risk: {(alert.risk_score * 100).toFixed(0)}%)
            </AlertTitle>
            <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>
              {alert.intervention}
            </Typography>
          </Alert>
        </Collapse>
      ))}
    </Box>
  )
}
