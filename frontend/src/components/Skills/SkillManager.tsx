import React, { useState } from 'react'
import {
  Drawer,
  Box,
  Typography,
  Button,
  IconButton,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
} from '@mui/material'
import {
  Close as CloseIcon,
  Warning as WarningIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useSkillPackages } from '../../hooks/useSkillPackages'

export const SkillManager: React.FC = () => {
  const [confirmOpen, setConfirmOpen] = useState(false)

  const { skillPanelOpen, toggleSkillPanel } = useAppStore()
  const { isResetting, resetStatus, clearStatus, resetGraph } = useSkillPackages()

  const handleReset = async () => {
    setConfirmOpen(false)
    await resetGraph()
  }

  return (
    <>
      <Drawer
        anchor="right"
        open={skillPanelOpen}
        onClose={toggleSkillPanel}
        sx={{ '& .MuiDrawer-paper': { width: 420, maxWidth: '100vw' } }}
      >
        <Box sx={{ p: 3, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
            <Typography variant="h6">World Knowledge Graph</Typography>
            <IconButton onClick={toggleSkillPanel}>
              <CloseIcon />
            </IconButton>
          </Box>

          {resetStatus && (
            <Alert severity={resetStatus.type} sx={{ mb: 2 }} onClose={clearStatus}>
              {resetStatus.message}
            </Alert>
          )}

          <Box sx={{ flex: 1 }} />

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Wipe the entire World Knowledge Graph and re-bootstrap with the anchor node and 12 drive nodes.
            </Typography>

            <Button
              fullWidth
              variant="contained"
              color="error"
              size="large"
              startIcon={<WarningIcon />}
              onClick={() => setConfirmOpen(true)}
              disabled={isResetting}
            >
              {isResetting ? 'Resetting...' : 'Reset World Knowledge Graph'}
            </Button>
            {isResetting && <LinearProgress color="error" sx={{ mt: 1 }} />}
          </Box>
        </Box>
      </Drawer>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Reset World Knowledge Graph?</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>
            This will permanently delete all nodes and edges in the WKG, then re-bootstrap with:
          </Typography>
          <Box component="ul" sx={{ mt: 1, mb: 2, pl: 2 }}>
            <li><Typography variant="body2">CoBeing anchor node (Sylphie)</Typography></li>
            <li><Typography variant="body2">12 drive nodes (core + complement)</Typography></li>
          </Box>
          <Alert severity="error">
            <strong>All learned knowledge, edges, and experience will be destroyed.</strong>
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button onClick={handleReset} color="error" variant="contained">
            Yes, Reset Everything
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
