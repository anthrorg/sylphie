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
  CircularProgress,
  Button,
  Tooltip,
} from '@mui/material'
import {
  Send as SendIcon,
  Mic as MicIcon,
  Stop as StopIcon,
  VolumeUp as VolumeUpIcon,
  VolumeOff as VolumeOffIcon,
  MicOff as MicOffIcon,
  WarningAmber as WarningAmberIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { useConversationWebSocket } from '../../hooks/useWebSocket'
import { useVoiceRecording } from '../../hooks/useVoiceRecording'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { ConversationMessage } from '../../types'
import { WordRatingDrawer } from './WordRatingDrawer'

// Message types: guardian=user input, response=Sylphie reply, cb_speech=Sylphie initiated speech,
// thinking=processing indicator, error=system error
const MessageBubble: React.FC<{ message: ConversationMessage; onClick?: () => void }> = ({ message, onClick }) => {
  const isGuardian = message.type === 'guardian'
  const isThinking = message.type === 'thinking'
  const isError = message.type === 'error'
  const isResponse = message.type === 'response'
  const isCbSpeech = message.type === 'cb_speech'
  // Backend may send 'text' or 'content' depending on message origin
  const displayText = message.text || message.content || ''

  if (isThinking && !displayText) return null

  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        justifyContent: isGuardian ? 'flex-end' : 'flex-start',
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
            : isError
              ? 'rgba(244, 67, 54, 0.15)'
              : isThinking
                ? 'rgba(255,255,255,0.04)'
                : isCbSpeech
                  ? 'rgba(76, 175, 80, 0.12)'
                  : 'rgba(255,255,255,0.06)',
          border: isGuardian
            ? '1px solid rgba(184, 217, 198, 0.3)'
            : isError
              ? '1px solid rgba(244, 67, 54, 0.3)'
              : isCbSpeech
                ? '1px solid rgba(76, 175, 80, 0.3)'
                : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {isCbSpeech && (
          <Typography
            variant="caption"
            sx={{ mb: 0.5, display: 'block', color: 'rgba(76,175,80,0.9)', fontSize: '0.65rem' }}
          >
            Sylphie speaks
          </Typography>
        )}
        {isThinking ? (
          <Typography variant="body2" fontStyle="italic" sx={{ color: 'rgba(255,255,255,0.4)' }}>
            Thinking...
          </Typography>
        ) : (
          <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>
            {displayText}
          </Typography>
        )}
        {(message.intent_type || (isResponse && message.referenced_node_count != null)) && (
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
            {/* 'grounded' = response was backed by existing graph knowledge, not fabricated */}
            {isResponse && message.is_grounded === true && (
              <Chip
                label="grounded"
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.6rem', height: 18, color: 'rgba(76,175,80,0.7)', borderColor: 'rgba(76,175,80,0.25)' }}
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

// Overlay shown when a transcription has confidence < 0.5
interface PendingTranscriptionOverlayProps {
  text: string
  confidence: number
  onConfirm: () => void
  onReject: () => void
  onTypeInstead: () => void
}

const PendingTranscriptionOverlay: React.FC<PendingTranscriptionOverlayProps> = ({
  text,
  confidence,
  onConfirm,
  onReject,
  onTypeInstead,
}) => (
  <Box
    sx={{
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      bgcolor: 'rgba(20, 20, 30, 0.97)',
      border: '1px solid rgba(255, 152, 0, 0.4)',
      borderBottom: 'none',
      borderRadius: '8px 8px 0 0',
      p: 2,
    }}
  >
    <Typography
      variant="caption"
      sx={{ color: 'rgba(255,152,0,0.9)', display: 'block', mb: 0.5, fontSize: '0.65rem' }}
    >
      Low confidence ({(confidence * 100).toFixed(0)}%) — did you mean:
    </Typography>
    <Typography
      variant="body2"
      sx={{
        color: 'rgba(255,255,255,0.9)',
        fontStyle: 'italic',
        mb: 1.5,
        px: 1,
        py: 0.5,
        bgcolor: 'rgba(255,255,255,0.05)',
        borderRadius: 1,
        borderLeft: '2px solid rgba(255,152,0,0.5)',
      }}
    >
      &ldquo;{text}&rdquo;
    </Typography>
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Button
        size="small"
        variant="contained"
        onClick={onConfirm}
        sx={{
          bgcolor: 'rgba(76,175,80,0.2)',
          color: 'rgba(76,175,80,0.9)',
          border: '1px solid rgba(76,175,80,0.4)',
          textTransform: 'none',
          fontSize: '0.75rem',
          '&:hover': { bgcolor: 'rgba(76,175,80,0.35)' },
        }}
      >
        Send it
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={onReject}
        sx={{
          color: 'rgba(255,255,255,0.6)',
          borderColor: 'rgba(255,255,255,0.2)',
          textTransform: 'none',
          fontSize: '0.75rem',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
        }}
      >
        Try again
      </Button>
      <Button
        size="small"
        variant="text"
        onClick={onTypeInstead}
        sx={{
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'none',
          fontSize: '0.75rem',
          '&:hover': { color: 'rgba(255,255,255,0.7)', bgcolor: 'transparent' },
        }}
      >
        Type instead
      </Button>
    </Box>
  </Box>
)

export const ConversationPanel: React.FC = () => {
  const [input, setInput] = useState('')
  const [ratingTarget, setRatingTarget] = useState<ConversationMessage | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const textFieldRef = useRef<HTMLInputElement>(null)

  const { messages, voiceState, wsState, addMessage, toggleMute } = useAppStore()
  const { sendMessage, sendTextMessage } = useConversationWebSocket()
  // isProcessing = audio sent to server for STT, waiting for transcription result
  const {
    isRecording,
    isProcessing,
    toggleRecording,
    pendingTranscription,
    confirmTranscription,
    rejectTranscription,
  } = useVoiceRecording()

  // Auto-scroll chat to bottom when new messages arrive
  useAutoScroll(feedRef, [messages])

  // Listen for voice text dispatched by useVoiceRecording after confirmation
  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ text: string }>
      const trimmed = custom.detail.text.trim()
      if (!trimmed || wsState.conversation !== 'connected') return
      // sendTextMessage wraps the payload in the NestJS ws adapter envelope
      // { event: 'message', data: { text, type: 'message' } } as required by
      // @SubscribeMessage('message') on ConversationGateway.
      sendTextMessage(trimmed)
    }
    window.addEventListener('sylphie:voice_text', handler)
    return () => window.removeEventListener('sylphie:voice_text', handler)
  }, [sendTextMessage, wsState.conversation])

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

  // "Type instead" button in the overlay: dismiss overlay and focus the text field
  const handleTypeInstead = () => {
    rejectTranscription()
    setTimeout(() => textFieldRef.current?.focus(), 50)
  }

  const isConnected = wsState.conversation === 'connected'
  const micDisabled = voiceState.permissionDenied || isProcessing

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

      {/* Microphone permission denied banner */}
      {voiceState.permissionDenied && (
        <Alert
          severity="error"
          sx={{
            borderRadius: 0,
            bgcolor: 'rgba(244, 67, 54, 0.1)',
            color: 'rgba(244, 120, 100, 0.9)',
            border: '1px solid rgba(244, 67, 54, 0.25)',
            '& .MuiAlert-icon': { color: 'rgba(244, 67, 54, 0.8)' },
          }}
        >
          Microphone access denied. Enable it in your browser and reload.
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
      </Box>

      <WordRatingDrawer
        message={ratingTarget}
        onClose={() => setRatingTarget(null)}
        onWordMarked={handleWordMarked}
      />

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />

      {/* Low-confidence transcription confirmation overlay */}
      {pendingTranscription && (
        <PendingTranscriptionOverlay
          text={pendingTranscription.text}
          confidence={pendingTranscription.confidence}
          onConfirm={confirmTranscription}
          onReject={rejectTranscription}
          onTypeInstead={handleTypeInstead}
        />
      )}

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
            inputRef={textFieldRef}
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

          {/* Mic button */}
          <Tooltip
            title={
              voiceState.permissionDenied
                ? 'Microphone access denied'
                : isRecording
                  ? 'Stop recording'
                  : 'Start recording'
            }
          >
            <span>
              <IconButton
                onClick={toggleRecording}
                disabled={micDisabled}
                sx={{
                  color: isRecording ? '#f44336' : voiceState.permissionDenied ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)',
                  border: '1px solid',
                  borderColor: isRecording
                    ? 'rgba(244,67,54,0.5)'
                    : isProcessing
                      ? 'rgba(255,152,0,0.4)'
                      : voiceState.permissionDenied
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(255,255,255,0.15)',
                  bgcolor: isRecording ? 'rgba(244,67,54,0.1)' : 'transparent',
                  // Pulsing animation while recording
                  animation: isRecording ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  '@keyframes pulse': {
                    '0%': { boxShadow: '0 0 0 0 rgba(244,67,54,0.4)' },
                    '70%': { boxShadow: '0 0 0 6px rgba(244,67,54,0)' },
                    '100%': { boxShadow: '0 0 0 0 rgba(244,67,54,0)' },
                  },
                  '&:hover': { bgcolor: isRecording ? 'rgba(244,67,54,0.2)' : 'rgba(255,255,255,0.08)' },
                  '&:disabled': { color: 'rgba(255,255,255,0.2)', borderColor: 'rgba(255,255,255,0.08)' },
                }}
              >
                {isProcessing ? (
                  <CircularProgress size={24} sx={{ color: 'rgba(255,152,0,0.7)' }} />
                ) : voiceState.permissionDenied ? (
                  <MicOffIcon />
                ) : isRecording ? (
                  <StopIcon />
                ) : (
                  <MicIcon />
                )}
              </IconButton>
            </span>
          </Tooltip>

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
