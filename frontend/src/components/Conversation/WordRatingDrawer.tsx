import React, { useState, useEffect } from 'react'
import { Drawer, Box, Typography, Chip, Divider, IconButton } from '@mui/material'
import { Close as CloseIcon } from '@mui/icons-material'
import { ConversationMessage } from '../../types'

interface WordRatingDrawerProps {
  message: ConversationMessage | null
  onClose: () => void
  onWordMarked: (phraseNodeId: string, word: string, position: number) => void
}

export const WordRatingDrawer: React.FC<WordRatingDrawerProps> = ({ message, onClose, onWordMarked }) => {
  const [markedPositions, setMarkedPositions] = useState<Set<number>>(new Set())

  useEffect(() => {
    setMarkedPositions(new Set())
  }, [message?.text])

  const words = message?.text?.split(/\s+/).filter(Boolean) ?? []
  const canRate = Boolean(message?.phrase_node_id)

  const handleToggle = (position: number) => {
    if (!canRate) return
    setMarkedPositions(prev => {
      const next = new Set(prev)
      if (next.has(position)) {
        next.delete(position)
      } else {
        next.add(position)
        onWordMarked(message!.phrase_node_id!, words[position], position)
      }
      return next
    })
  }

  return (
    <Drawer
      anchor="left"
      open={message !== null}
      onClose={onClose}
      PaperProps={{
        sx: { width: 600, bgcolor: '#12121f', borderRight: '1px solid rgba(255,255,255,0.08)', p: 2.5, display: 'flex', flexDirection: 'column', gap: 0 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="subtitle2" sx={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.75rem', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Rate Sylphie's words
        </Typography>
        <IconButton size="small" onClick={onClose} sx={{ color: 'rgba(255,255,255,0.3)', '&:hover': { color: 'rgba(255,255,255,0.6)' } }}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <Typography variant="body2" sx={{ color: 'rgba(76,175,80,0.8)', fontStyle: 'italic', mb: 2, lineHeight: 1.5, fontSize: '0.8rem' }}>
        "{message?.text}"
      </Typography>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 2 }} />

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, flex: 1 }}>
        {words.map((word, i) => {
          const isMarked = markedPositions.has(i)
          return (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Chip
                label={word}
                size="small"
                onClick={canRate ? () => handleToggle(i) : undefined}
                variant="outlined"
                sx={{
                  minWidth: 64, fontSize: '0.8rem', cursor: canRate ? 'pointer' : 'default',
                  bgcolor: isMarked ? 'rgba(244,67,54,0.15)' : 'rgba(255,255,255,0.04)',
                  borderColor: isMarked ? 'rgba(244,67,54,0.5)' : 'rgba(255,255,255,0.12)',
                  color: isMarked ? 'rgba(244,100,54,0.95)' : 'rgba(255,255,255,0.65)',
                  transition: 'all 0.15s ease',
                  '&:hover': canRate ? { bgcolor: isMarked ? 'rgba(244,67,54,0.25)' : 'rgba(255,255,255,0.08)', borderColor: isMarked ? 'rgba(244,67,54,0.7)' : 'rgba(255,255,255,0.25)' } : {},
                }}
              />
              {isMarked && (
                <Typography variant="caption" sx={{ color: 'rgba(244,100,54,0.6)', fontSize: '0.65rem' }}>wrong</Typography>
              )}
            </Box>
          )
        })}
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.5 }} />
        {!canRate ? (
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.65rem' }}>Phrase not in graph — rating unavailable</Typography>
        ) : markedPositions.size > 0 ? (
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.65rem' }}>
            {markedPositions.size} word{markedPositions.size !== 1 ? 's' : ''} marked — feedback sent
          </Typography>
        ) : (
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.65rem' }}>Click a word to mark it as wrong</Typography>
        )}
      </Box>
    </Drawer>
  )
}
