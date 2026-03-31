import React, { useState, useEffect } from 'react'
import {
  Drawer,
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CardActions,
  IconButton,
  Alert,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
  Divider,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Tooltip,
} from '@mui/material'
import {
  Close as CloseIcon,
  Delete as DeleteIcon,
  Warning as WarningIcon,
  RestartAlt as RestartAltIcon,
  Upload as UploadIcon,
  Speed as SpeedIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useSkillPackages, ConceptUploadForm } from '../../hooks/useSkillPackages'
import { SkillDto } from '../../types'

// Permitted WKG node types for guardian upload (must match backend VALID_WKG_NODE_TYPES)
const VALID_NODE_TYPES = [
  'Concept',
  'Entity',
  'Procedure',
  'Action',
  'Utterance',
  'Pattern',
  'Event',
  'Person',
  'Location',
  'Attribute',
] as const

const CONFIDENCE_COLOR = (conf: number, deactivated: boolean): string => {
  if (deactivated) return 'rgba(255,255,255,0.2)'
  if (conf >= 0.8) return '#81C784'
  if (conf >= 0.5) return '#FFB74D'
  return '#EF5350'
}

const SkillCard: React.FC<{
  skill: SkillDto
  onDeactivate: (id: string) => void
}> = ({ skill, onDeactivate }) => {
  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        opacity: skill.deactivated ? 0.5 : 1,
        borderColor: skill.deactivated ? 'rgba(255,255,255,0.15)' : undefined,
      }}
    >
      <CardContent sx={{ pb: 0.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {skill.label}
              </Typography>
              {skill.deactivated && (
                <Chip label="deactivated" size="small" color="error" variant="outlined" sx={{ height: 18, fontSize: '0.6rem' }} />
              )}
              {skill.isType1 && (
                <Tooltip title="Type 1 — graduated reflex (confidence > 0.80, MAE < 0.10)">
                  <Chip
                    label="T1"
                    size="small"
                    icon={<SpeedIcon sx={{ fontSize: '0.75rem !important' }} />}
                    sx={{ height: 18, fontSize: '0.6rem', bgcolor: 'rgba(76,175,80,0.15)', color: '#81C784', border: '1px solid rgba(76,175,80,0.3)' }}
                  />
                </Tooltip>
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip
                label={skill.type}
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: '0.6rem', color: 'rgba(255,255,255,0.6)', borderColor: 'rgba(255,255,255,0.2)' }}
              />
              <Chip
                label={skill.provenance}
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: '0.6rem', color: 'rgba(184,217,198,0.7)', borderColor: 'rgba(184,217,198,0.25)' }}
              />
              <Typography
                variant="caption"
                sx={{ fontSize: '0.65rem', color: CONFIDENCE_COLOR(skill.confidence, skill.deactivated), fontFamily: 'monospace' }}
              >
                conf {skill.confidence.toFixed(3)}
              </Typography>
              <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>
                used {skill.useCount}x
              </Typography>
              {skill.predictionMae !== null && (
                <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>
                  MAE {skill.predictionMae.toFixed(3)}
                </Typography>
              )}
            </Box>
          </Box>
        </Box>
      </CardContent>
      <CardActions sx={{ pt: 0 }}>
        <Button
          size="small"
          color="error"
          startIcon={<DeleteIcon />}
          onClick={() => onDeactivate(skill.id)}
          disabled={skill.deactivated}
        >
          Deactivate
        </Button>
      </CardActions>
    </Card>
  )
}

// Simple key-value properties editor — stores as JSON string internally
const PropertiesEditor: React.FC<{
  value: string
  onChange: (v: string) => void
  error: string | null
}> = ({ value, onChange, error }) => (
  <Box>
    <TextField
      label="Properties (JSON)"
      multiline
      minRows={3}
      maxRows={8}
      fullWidth
      size="small"
      placeholder='{"description": "what this concept means", "source": "guardian"}'
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={!!error}
      helperText={error ?? 'Optional JSON object with domain-specific properties'}
      inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
    />
  </Box>
)

export const SkillManager: React.FC = () => {
  // Upload form state
  const [conceptLabel, setConceptLabel] = useState('')
  const [conceptType, setConceptType] = useState<string>('Concept')
  const [propertiesJson, setPropertiesJson] = useState('')
  const [propertiesError, setPropertiesError] = useState<string | null>(null)

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    message: string
    action: () => void
  }>({
    open: false,
    title: '',
    message: '',
    action: () => {},
  })

  const [isBootstrapping, setIsBootstrapping] = useState(false)
  const [filterDeactivated, setFilterDeactivated] = useState(false)

  const { skillPanelOpen, toggleSkillPanel, skills } = useAppStore()
  const {
    isUploading,
    uploadStatus,
    clearStatus,
    loadSkills,
    uploadConcept,
    deactivateSkill,
    resetGraph,
  } = useSkillPackages()

  useEffect(() => {
    if (skillPanelOpen) {
      loadSkills()
    }
  }, [skillPanelOpen, loadSkills])

  const validateAndParseProperties = (): Record<string, unknown> | null => {
    if (!propertiesJson.trim()) return {}
    try {
      const parsed = JSON.parse(propertiesJson)
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        setPropertiesError('Must be a JSON object {}')
        return null
      }
      setPropertiesError(null)
      return parsed as Record<string, unknown>
    } catch {
      setPropertiesError('Invalid JSON')
      return null
    }
  }

  const handleUpload = async () => {
    if (!conceptLabel.trim()) return
    const properties = validateAndParseProperties()
    if (properties === null) return

    const form: ConceptUploadForm = {
      label: conceptLabel.trim(),
      type: conceptType,
      properties,
    }

    await uploadConcept(form)
    setConceptLabel('')
    setPropertiesJson('')
    setPropertiesError(null)
  }

  const handleDeactivate = (id: string) => {
    const skill = skills.find((s) => s.id === id)
    setConfirmDialog({
      open: true,
      title: 'Confirm Deactivation',
      message: `Deactivate "${skill?.label ?? id}"? The node stays in the WKG at confidence 0.0. It will not appear in normal retrieval queries but remains for audit and provenance tracing.`,
      action: () => deactivateSkill(id),
    })
  }

  const handleBootstrap = () => {
    setConfirmDialog({
      open: true,
      title: 'Bootstrap Starter Nodes',
      message: 'Install drive categories, action tree, and reflex nodes. Safe to run on an already-bootstrapped graph (idempotent).',
      action: async () => {
        setIsBootstrapping(true)
        try {
          const res = await fetch('/api/bootstrap', { method: 'POST' })
          if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`)
          window.location.reload()
        } catch (err) {
          console.error('Bootstrap error:', err)
          setIsBootstrapping(false)
        }
      },
    })
  }

  const handleReset = (scope: 'hard' | 'experience') => {
    const message =
      scope === 'hard'
        ? 'This will remove ALL installed skill packages (preserves core system and experience data).'
        : 'This will remove ALL learned experience data (preserves core system and skill packages).'

    setConfirmDialog({
      open: true,
      title: 'Confirm Reset',
      message,
      action: () => resetGraph(scope),
    })
  }

  const displayedSkills = filterDeactivated
    ? skills.filter((s) => !s.deactivated)
    : skills

  const activeCount = skills.filter((s) => !s.deactivated).length
  const type1Count = skills.filter((s) => s.isType1).length

  return (
    <>
      <Drawer
        anchor="right"
        open={skillPanelOpen}
        onClose={toggleSkillPanel}
        sx={{
          '& .MuiDrawer-paper': {
            width: 640,
            maxWidth: '100vw',
          },
        }}
      >
        <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Box>
              <Typography variant="h6">Skills Manager</Typography>
              <Typography variant="caption" color="text.secondary">
                WKG Procedure nodes — {activeCount} active, {type1Count} Type 1
              </Typography>
            </Box>
            <IconButton onClick={toggleSkillPanel}>
              <CloseIcon />
            </IconButton>
          </Box>

          {/* Status messages */}
          {uploadStatus && (
            <Alert severity={uploadStatus.type} sx={{ mb: 2 }} onClose={clearStatus}>
              {uploadStatus.message}
            </Alert>
          )}

          {/* Concept upload form */}
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
              Upload Concept to WKG
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Guardian upload forces GUARDIAN provenance and 0.60 base confidence (CANON Confidence Ceiling).
            </Typography>

            <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
              <TextField
                label="Label"
                size="small"
                fullWidth
                value={conceptLabel}
                onChange={(e) => setConceptLabel(e.target.value)}
                placeholder="e.g. Morning Routine"
                disabled={isUploading}
              />

              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel>Type</InputLabel>
                <Select
                  value={conceptType}
                  label="Type"
                  onChange={(e) => setConceptType(e.target.value)}
                  disabled={isUploading}
                >
                  {VALID_NODE_TYPES.map((t) => (
                    <MenuItem key={t} value={t}>{t}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>

            <PropertiesEditor
              value={propertiesJson}
              onChange={setPropertiesJson}
              error={propertiesError}
            />

            <Button
              fullWidth
              variant="contained"
              startIcon={<UploadIcon />}
              onClick={handleUpload}
              disabled={!conceptLabel.trim() || isUploading}
              sx={{ mt: 1.5 }}
            >
              {isUploading ? 'Uploading...' : 'Upload to WKG'}
            </Button>
            {isUploading && <LinearProgress sx={{ mt: 0.5 }} />}
          </Box>

          <Divider />

          {/* Skill list */}
          <Box sx={{ mb: 2, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 2, mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                WKG Skill Nodes ({displayedSkills.length}{filterDeactivated ? ' active' : ' total'})
              </Typography>
              <Button
                size="small"
                variant="text"
                onClick={() => setFilterDeactivated(!filterDeactivated)}
                sx={{ fontSize: '0.7rem' }}
              >
                {filterDeactivated ? 'Show all' : 'Hide deactivated'}
              </Button>
            </Box>
            <Box sx={{ overflow: 'auto', flex: 1 }}>
              {displayedSkills.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {skills.length === 0 ? 'No skills in WKG yet' : 'No active skills'}
                </Typography>
              ) : (
                displayedSkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onDeactivate={handleDeactivate} />
                ))
              )}
            </Box>
          </Box>

          <Divider />

          {/* Reset options */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" gutterBottom color="error" sx={{ fontWeight: 600 }}>
              Reset Options
            </Typography>
            <Button
              fullWidth
              variant="outlined"
              color="primary"
              onClick={handleBootstrap}
              sx={{ mb: 1 }}
              startIcon={<RestartAltIcon />}
              disabled={isBootstrapping}
            >
              {isBootstrapping ? 'Bootstrapping...' : 'Bootstrap Starter Nodes'}
            </Button>
            <Button
              fullWidth
              variant="outlined"
              color="error"
              onClick={() => handleReset('hard')}
              sx={{ mb: 1 }}
              startIcon={<WarningIcon />}
            >
              Reset All Skills
            </Button>
            <Button
              fullWidth
              variant="outlined"
              color="error"
              onClick={() => handleReset('experience')}
              startIcon={<WarningIcon />}
            >
              Reset Experience
            </Button>
          </Box>
        </Box>
      </Drawer>

      {/* Confirmation dialog */}
      <Dialog
        open={confirmDialog.open}
        onClose={() => setConfirmDialog({ ...confirmDialog, open: false })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{confirmDialog.title}</DialogTitle>
        <DialogContent>
          <Typography>{confirmDialog.message}</Typography>
          <Alert severity="warning" sx={{ mt: 2 }}>
            <strong>This action cannot be undone!</strong>
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDialog({ ...confirmDialog, open: false })}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              confirmDialog.action()
              setConfirmDialog({ ...confirmDialog, open: false })
            }}
            color="error"
            variant="contained"
          >
            Proceed
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
