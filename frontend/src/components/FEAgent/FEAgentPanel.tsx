import React, { useState, useRef, useCallback } from 'react'
import {
  Box,
  TextField,
  IconButton,
  Typography,
  Paper,
  CircularProgress,
  Collapse,
  Chip,
} from '@mui/material'
import SendIcon from '@mui/icons-material/Send'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { isAvailable } from '../../services/feAgent'
import { useTelemetryBuffer } from '../../hooks/useTelemetryBuffer'
import { useFEAgentChat } from '../../hooks/useFEAgentChat'
import { useAutoScroll } from '../../hooks/useAutoScroll'

export const FEAgentPanel: React.FC = () => {
  const [expanded, setExpanded] = useState(false)
  const [input, setInput] = useState('')
  const chatScrollRef = useRef<HTMLDivElement>(null)
  // getSnapshot provides a text summary of recent telemetry as LLM context
  const { getSnapshot } = useTelemetryBuffer()
  const { chat, thinking, streamingText, handleSubmit } = useFEAgentChat(getSnapshot)

  const available = isAvailable()

  useAutoScroll(chatScrollRef, [chat, streamingText])

  const onSubmit = useCallback(async () => {
    const question = input.trim()
    if (!question) return
    setInput('')
    await handleSubmit(question)
  }, [input, handleSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void onSubmit()
      }
    },
    [onSubmit],
  )

  // Graceful degradation: entire panel hides if VITE_ANTHROPIC_API_KEY is unset
  if (!available) return null

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: expanded ? 400 : 'auto',
        maxHeight: expanded ? '60vh' : 'auto',
        zIndex: 1200,
        borderRadius: 2,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header — always visible */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          cursor: 'pointer',
          bgcolor: '#16213e',
          color: 'white',
          '&:hover': { bgcolor: '#1a2744' },
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <SmartToyIcon fontSize="small" />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Observatory Assistant (read-only)
        </Typography>
        {thinking && <CircularProgress size={14} sx={{ color: 'white' }} />}
        {expanded ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
      </Box>

      {/* Chat area — collapsible */}
      <Collapse in={expanded}>
        {/* Messages */}
        <Box
          ref={chatScrollRef}
          sx={{
            flex: 1,
            overflow: 'auto',
            maxHeight: 'calc(60vh - 100px)',
            p: 1.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {chat.length === 0 && !streamingText && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
              Ask anything about Sylphie's current state, drives, or behavior.
            </Typography>
          )}

          {chat.map((entry, i) => (
            <Box
              key={i}
              sx={{
                alignSelf: entry.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}
            >
              <Chip
                label={
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', py: 0.5 }}>
                    {entry.content}
                  </Typography>
                }
                sx={{
                  height: 'auto',
                  '& .MuiChip-label': { display: 'block', px: 1.5, py: 0.5 },
                  bgcolor: entry.role === 'user' ? '#e3f2fd' : '#f5f5f5',
                  maxWidth: '100%',
                }}
              />
            </Box>
          ))}

          {/* Streaming response */}
          {streamingText && (
            <Box sx={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
              <Chip
                label={
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', py: 0.5 }}>
                    {streamingText}
                  </Typography>
                }
                sx={{
                  height: 'auto',
                  '& .MuiChip-label': { display: 'block', px: 1.5, py: 0.5 },
                  bgcolor: '#f5f5f5',
                  maxWidth: '100%',
                }}
              />
            </Box>
          )}

        </Box>

        {/* Input */}
        <Box sx={{ display: 'flex', gap: 0.5, p: 1, borderTop: '1px solid #e0e0e0' }}>
          <TextField
            size="small"
            fullWidth
            placeholder="What is Sylphie doing right now?"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={thinking}
            autoFocus
          />
          <IconButton
            size="small"
            onClick={() => void onSubmit()}
            disabled={thinking || !input.trim()}
            color="primary"
          >
            <SendIcon fontSize="small" />
          </IconButton>
        </Box>
      </Collapse>
    </Paper>
  )
}
