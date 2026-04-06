import React, { useState, useRef, useEffect } from 'react'
import {
  Box,
  Paper,
  TextField,
  IconButton,
  Typography,
  Chip,
  Alert,
  Divider,
  Tooltip,
} from '@mui/material'
import {
  Send as SendIcon,
  VolumeUp as VolumeUpIcon,
  VolumeOff as VolumeOffIcon,
  WarningAmber as WarningAmberIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useConversationWebSocket } from '../../hooks/useWebSocket'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { ConversationMessage } from '../../types'
import { WordRatingDrawer } from './WordRatingDrawer'

// Message types: guardian=user input, response=Sylphie reply, cb_speech=Sylphie initiated speech,
// thinking=processing indicator, error=system error
const MessageBubble: React.FC<{ message: ConversationMessage; onClick?: () => void }> = ({ message, onClick }) => {
  const isGuardian = message.type === 'guardian'
  const isTranscription = message.type === 'transcription'
  const isThinking = message.type === 'thinking'
  const isError = message.type === 'error'
  const isResponse = message.type === 'response'
  const isCbSpeech = message.type === 'cb_speech'
  const isSylphie = isResponse || isCbSpeech
  // Backend may send 'text' or 'content' depending on message origin
  const displayText = message.text || message.content || ''
  const grounding = message.knowledgeGrounding

  if (isThinking && !displayText) return null

  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        justifyContent: isGuardian || isTranscription ? 'flex-end' : 'flex-start',
        mb: 1.5,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <Box
        sx={{
          p: '8px 12px',
          maxWidth: '75%',
          borderRadius: 2,
          bgcolor: isGuardian
            ? 'rgba(184, 217, 198, 0.18)'
            : isTranscription
              ? 'rgba(100, 181, 246, 0.12)'
              : isError
                ? 'rgba(244, 67, 54, 0.15)'
                : isThinking
                  ? 'rgba(255,255,255,0.04)'
                  : isSylphie && grounding === 'LLM_ASSISTED'
                    ? 'rgba(255, 183, 77, 0.10)'
                    : isSylphie && grounding === 'UNKNOWN'
                      ? 'rgba(255,255,255,0.04)'
                      : isCbSpeech
                        ? 'rgba(76, 175, 80, 0.12)'
                        : 'rgba(255,255,255,0.06)',
          border: isGuardian
            ? '1px solid rgba(184, 217, 198, 0.3)'
            : isTranscription
              ? '1px solid rgba(100, 181, 246, 0.3)'
              : isError
                ? '1px solid rgba(244, 67, 54, 0.3)'
                : isSylphie && grounding === 'LLM_ASSISTED'
                  ? '1px solid rgba(255, 183, 77, 0.35)'
                  : isSylphie && grounding === 'UNKNOWN'
                    ? '1px solid rgba(255,255,255,0.15)'
                    : isCbSpeech
                      ? '1px solid rgba(76, 175, 80, 0.3)'
                      : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {isTranscription && (
          <Typography
            variant="caption"
            sx={{ mb: 0.5, display: 'block', color: 'rgba(100,181,246,0.9)', fontSize: '0.65rem' }}
          >
            voice
          </Typography>
        )}
        {isCbSpeech && (
          <Typography
            variant="caption"
            sx={{
              mb: 0.5,
              display: 'block',
              fontSize: '0.65rem',
              color: grounding === 'LLM_ASSISTED'
                ? 'rgba(255,183,77,0.9)'
                : grounding === 'UNKNOWN'
                  ? 'rgba(255,255,255,0.4)'
                  : 'rgba(76,175,80,0.9)',
            }}
          >
            {grounding === 'LLM_ASSISTED'
              ? 'Sylphie guesses (tool-assisted)'
              : grounding === 'UNKNOWN'
                ? 'Sylphie is uncertain'
                : 'Sylphie speaks'}
          </Typography>
        )}
        {isThinking ? (
          <Typography variant="body2" fontStyle="italic" sx={{ color: 'rgba(255,255,255,0.4)' }}>
            Thinking...
          </Typography>
        ) : (
          <Typography
            variant="body2"
            sx={{
              lineHeight: 1.5,
              color: isSylphie && grounding === 'LLM_ASSISTED'
                ? 'rgba(255,213,140,0.85)'
                : isSylphie && grounding === 'UNKNOWN'
                  ? 'rgba(255,255,255,0.5)'
                  : 'rgba(255,255,255,0.85)',
              fontStyle: isSylphie && grounding === 'LLM_ASSISTED' ? 'italic' : 'normal',
            }}
          >
            {displayText}
          </Typography>
        )}
        {(message.intent_type || (isResponse && message.referenced_node_count != null) || (isSylphie && grounding)) && (
          <Box sx={{ display: 'flex', gap: 0.5, mt: 0.75, flexWrap: 'wrap' }}>
            {message.intent_type && (
              <Chip
                label={message.intent_type}
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(255,255,255,0.4)', borderColor: 'rgba(255,255,255,0.15)' }}
              />
            )}
            {isResponse && message.referenced_node_count != null && (
              <Chip
                label={`${message.referenced_node_count} nodes`}
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(184,217,198,0.6)', borderColor: 'rgba(184,217,198,0.25)' }}
              />
            )}
            {/* Knowledge grounding badge — shows how the response relates to Sylphie's own knowledge */}
            {isSylphie && grounding === 'GROUNDED' && (
              <Chip
                label="from memory"
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(76,175,80,0.7)', borderColor: 'rgba(76,175,80,0.25)' }}
              />
            )}
            {isSylphie && grounding === 'LLM_ASSISTED' && (
              <Chip
                label="tool-assisted guess"
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(255,183,77,0.8)', borderColor: 'rgba(255,183,77,0.3)' }}
              />
            )}
            {isSylphie && grounding === 'UNKNOWN' && (
              <Chip
                label="doesn't know"
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(255,255,255,0.4)', borderColor: 'rgba(255,255,255,0.15)' }}
              />
            )}
          </Box>
        )}

        {/* Theater check — visible when is_grounded is explicitly false.
            CANON Immutable Standard 1: output must correlate with actual drive state.
            is_grounded=false means the response was flagged as not reflecting drive state. */}
        {(isResponse || isCbSpeech) && message.is_grounded === false && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 0.75,
              px: 0.75,
              py: 0.4,
              bgcolor: 'rgba(255,152,0,0.1)',
              border: '1px solid rgba(255,152,0,0.3)',
              borderRadius: 0.75,
            }}
          >
            <WarningAmberIcon sx={{ fontSize: '0.85rem', color: 'rgba(255,152,0,0.85)', flexShrink: 0 }} />
            <Typography
              variant="caption"
              sx={{ fontSize: '0.62rem', color: 'rgba(255,152,0,0.85)', lineHeight: 1.3 }}
            >
              Theater check: response may not reflect actual drive state
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}

export const ConversationPanel: React.FC = () => {
  const [input, setInput] = useState('')
  const [ratingTarget, setRatingTarget] = useState<ConversationMessage | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  const { messages, isThinking, voiceState, wsState, addMessage, toggleMute } = useAppStore()
  const { sendMessage, sendTextMessage } = useConversationWebSocket()

  // Auto-scroll chat to bottom when new messages arrive
  useAutoScroll(feedRef, [messages])

  // Listen for STT voice transcriptions and send them through the same
  // path as typed text so they get the same treatment end-to-end.
  useEffect(() => {
    const handleVoiceText = (e: Event) => {
      const { text } = (e as CustomEvent<{ text: string }>).detail
      if (!text.trim() || wsState.conversation !== 'connected') return

      addMessage({ type: 'guardian', text })
      sendTextMessage(text)
    }

    window.addEventListener('sylphie:voice_text', handleVoiceText)
    return () => window.removeEventListener('sylphie:voice_text', handleVoiceText)
  }, [wsState.conversation, addMessage, sendTextMessage])

  const handleSendMessage = () => {
    if (!input.trim() || wsState.conversation !== 'connected') return

    const trimmed = input.trim()

    // Optimistic UI: show the message immediately, don't wait for server ack
    addMessage({
      type: 'guardian',
      text: trimmed,
    })

    // sendTextMessage wraps text in the NestJS ws adapter envelope
    // { event: 'message', data: { text, type: 'message' } } as required by
    // @SubscribeMessage('message') on ConversationGateway.
    const success = sendTextMessage(trimmed)

    if (success) {
      setInput('')
    }
  }

  const handleWordMarked = (phraseNodeId: string, word: string, position: number) => {
    sendMessage({ type: 'phrase_word_rating', phrase_node_id: phraseNodeId, word, position, rating: 'bad' })
  }

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSendMessage()
    }
  }

  const isConnected = wsState.conversation === 'connected'

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* Connection status */}
      {!isConnected && (
        <Alert
          severity="warning"
          sx={{
            borderRadius: 0,
            bgcolor: 'rgba(255, 152, 0, 0.12)',
            color: 'rgba(255, 200, 100, 0.9)',
            border: '1px solid rgba(255, 152, 0, 0.25)',
            '& .MuiAlert-icon': { color: 'rgba(255, 152, 0, 0.8)' },
          }}
        >
          Conversation WebSocket is {wsState.conversation}
        </Alert>
      )}


      {/* Message feed */}
      <Box
        ref={feedRef}
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 2,
          bgcolor: 'transparent',
        }}
      >
        {messages.length === 0 && (
          <Box sx={{ textAlign: 'center', mt: 4 }}>
            <Typography variant="h6" sx={{ color: 'rgba(255,255,255,0.3)' }}>
              Welcome to Sylphie
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.2)' }}>
              Start a conversation by typing a message below
            </Typography>
          </Box>
        )}

        {messages.map((message, index) => (
          <MessageBubble
            key={index}
            message={message}
            onClick={message.type === 'cb_speech' ? () => setRatingTarget(message) : undefined}
          />
        ))}

        {/* Typing indicator — shown when Sylphie is processing (thinking) */}
        {isThinking && (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'flex-start',
              mb: 1.5,
            }}
          >
            <Box
              sx={{
                p: '8px 16px',
                borderRadius: 2,
                bgcolor: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  gap: '4px',
                  alignItems: 'center',
                  '@keyframes bounce': {
                    '0%, 60%, 100%': { transform: 'translateY(0)' },
                    '30%': { transform: 'translateY(-4px)' },
                  },
                  '& span': {
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: 'rgba(184,217,198,0.5)',
                    display: 'inline-block',
                  },
                  '& span:nth-of-type(1)': { animation: 'bounce 1.2s infinite 0s' },
                  '& span:nth-of-type(2)': { animation: 'bounce 1.2s infinite 0.2s' },
                  '& span:nth-of-type(3)': { animation: 'bounce 1.2s infinite 0.4s' },
                }}
              >
                <span />
                <span />
                <span />
              </Box>
            </Box>
          </Box>
        )}
      </Box>

      <WordRatingDrawer
        message={ratingTarget}
        onClose={() => setRatingTarget(null)}
        onWordMarked={handleWordMarked}
      />

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />

      {/* Input area */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          bgcolor: 'transparent',
          borderTop: 'none',
        }}
      >
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Teach me something or ask a question"
            disabled={!isConnected}
            variant="outlined"
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                color: 'rgba(255,255,255,0.85)',
                '& fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
                '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.3)' },
                '&.Mui-focused fieldset': { borderColor: 'rgba(184,217,198,0.5)' },
                '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' },
              },
              '& .MuiInputBase-input::placeholder': { color: 'rgba(255,255,255,0.3)', opacity: 1 },
            }}
          />

          <IconButton
            onClick={handleSendMessage}
            disabled={!input.trim() || !isConnected}
            sx={{
              bgcolor: 'rgba(184,217,198,0.2)',
              color: 'rgba(184,217,198,0.9)',
              border: '1px solid rgba(184,217,198,0.3)',
              '&:hover': { bgcolor: 'rgba(184,217,198,0.3)' },
              '&:disabled': { bgcolor: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.2)', borderColor: 'rgba(255,255,255,0.1)' },
            }}
          >
            <SendIcon />
          </IconButton>

          {/* Mute/unmute speaker toggle */}
          <Tooltip title={voiceState.muted ? 'Unmute audio' : 'Mute audio'}>
            <IconButton
              onClick={toggleMute}
              sx={{
                color: voiceState.muted ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.5)',
                border: '1px solid',
                borderColor: voiceState.muted ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.15)',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
              }}
            >
              {voiceState.muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      </Paper>
    </Box>
  )
}
