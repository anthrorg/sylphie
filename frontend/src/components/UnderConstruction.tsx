import React from 'react'
import { Box, Typography } from '@mui/material'
import BuildIcon from '@mui/icons-material/Build'

const UnderConstruction: React.FC = () => (
  <Box
    sx={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    }}
  >
    <BuildIcon sx={{ fontSize: 64, color: 'text.secondary' }} />
    <Typography variant="h4" color="text.primary">
      Under Construction
    </Typography>
    <Typography variant="body1" color="text.secondary">
      Set <code>VITE_APP_ENABLED=true</code> to access the dashboard.
    </Typography>
  </Box>
)

export default UnderConstruction
