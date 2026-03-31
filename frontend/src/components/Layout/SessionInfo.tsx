import React from 'react'
import { Collapse, Paper, Grid, Typography, Box } from '@mui/material'
import { useAppStore } from '../../store'

// Collapsible stats bar showing session-level metrics; toggled from TopBar
export const SessionInfo: React.FC = () => {
  const { sessionInfoExpanded, sessionStats, graphStats } = useAppStore()

  return (
    <Collapse in={sessionInfoExpanded}>
      <Paper
        elevation={1}
        sx={{
          p: 2,
          bgcolor: '#0f3460',
          color: 'white',
          borderRadius: 0,
        }}
      >
        <Grid container spacing={3}>
          <Grid item xs={3}>
            <Box>
              <Typography variant="body2" color="rgba(255,255,255,0.7)">
                Session cost
              </Typography>
              <Typography variant="h6">${sessionStats.session_cost_usd.toFixed(2)}</Typography>
            </Box>
          </Grid>
          <Grid item xs={3}>
            <Box>
              <Typography variant="body2" color="rgba(255,255,255,0.7)">
                Graph changes this session
              </Typography>
              <Typography variant="h6">{sessionStats.graph_changes}</Typography>
            </Box>
          </Grid>
          <Grid item xs={3}>
            <Box>
              <Typography variant="body2" color="rgba(255,255,255,0.7)">
                Total nodes (all time)
              </Typography>
              <Typography variant="h6">{graphStats.nodes}</Typography>
            </Box>
          </Grid>
          <Grid item xs={3}>
            <Box>
              <Typography variant="body2" color="rgba(255,255,255,0.7)">
                Conversation turns
              </Typography>
              <Typography variant="h6">{sessionStats.conversation_turns}</Typography>
            </Box>
          </Grid>
        </Grid>
      </Paper>
    </Collapse>
  )
}
