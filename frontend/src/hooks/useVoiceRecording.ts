import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '../store'
import { PendingTranscription } from '../types'

export interface UseVoiceRecordingReturn {
  isRecording: boolean
  isProcessing: boolean
  startRecording: () => Promise<void>
  stopRecording: () => void
  toggleRecording: () => void
  pendingTranscription: PendingTranscription | null
  confirmTranscription: () => void
  rejectTranscription: () => void
}

// Decode a base64 TTS response and play it through an HTMLAudioElement.
// Returns a cleanup function that revokes the object URL.
function playAudioBase64(audioBase64: string, audioFormat: string): () => void {
  try {
    const binary = atob(audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: audioFormat || 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    audio.onerror = () => URL.revokeObjectURL(url)
    audio.play().catch((e) => {
      console.warn('[Voice] Audio playback failed:', e)
      URL.revokeObjectURL(url)
    })
    return () => URL.revokeObjectURL(url)
  } catch (e) {
    // Fail silently -- text is still displayed
    console.warn('[Voice] Audio decode failed:', e)
    return () => { /* no-op */ }
  }
}

export function useVoiceRecording(): UseVoiceRecordingReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [pendingTranscription, setPendingTranscription] = useState<PendingTranscription | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  // Tracks cleanup functions for any playing audio object URLs
  const audioCleanupRef = useRef<(() => void) | null>(null)

  const { voiceState, addMessage, setVoiceState } = useAppStore()

  // Dispatch a confirmed transcription text as a guardian message via WebSocket.
  // We re-use the same pattern as the text input path so ConversationPanel
  // doesn't need to know whether the message came from voice or keyboard.
  const dispatchTextMessage = useCallback(
    (text: string) => {
      addMessage({ type: 'guardian', text })
      // The ConversationPanel's WebSocket hook is not accessible here, so we
      // post a synthetic DOM event that ConversationPanel listens for.
      // A simpler pattern: expose a sendVoiceText action on the store, or post
      // via a CustomEvent that ConversationPanel picks up.
      // We use a CustomEvent here to stay decoupled from the WS hook instance.
      const event = new CustomEvent('sylphie:voice_text', { detail: { text } })
      window.dispatchEvent(event)
    },
    [addMessage],
  )

  const processTranscriptionResult = useCallback(
    (result: { text: string; confidence: number; latencyMs: number }, audioBlob: Blob) => {
      const text = result.text?.trim()
      if (!text) {
        addMessage({ type: 'error', text: "Couldn't understand, try again" })
        return
      }

      if (result.confidence >= 0.5) {
        // High confidence: auto-send
        dispatchTextMessage(text)
      } else {
        // Low confidence: hold for guardian confirmation
        setPendingTranscription({
          text,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
          audioBlob,
        })
      }
    },
    [addMessage, dispatchTextMessage],
  )

  const sendToTranscribeEndpoint = useCallback(
    async (audioBlob: Blob) => {
      setIsProcessing(true)
      setVoiceState({ processing: true })

      try {
        const response = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
          body: audioBlob,
        })

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'unknown' }))
          addMessage({ type: 'error', text: `Voice error: ${err.detail || err.error || 'unknown'}` })
          return
        }

        const result = await response.json() as {
          text?: string
          confidence?: number
          latencyMs?: number
          error_type?: string
          // Legacy fields for compatibility
          transcription_text?: string
          response_text?: string
          tts_succeeded?: boolean
          turn_id?: string
          audioBase64?: string
          audioFormat?: string
        }

        if (result.error_type) {
          if (result.error_type !== 'no_speech') {
            addMessage({ type: 'error', text: `Voice: ${result.error_type}` })
          }
          return
        }

        // New API: { text, confidence, latencyMs }
        if (result.text !== undefined) {
          if (!result.text.trim()) {
            addMessage({ type: 'error', text: "Couldn't understand, try again" })
            return
          }
          processTranscriptionResult(
            {
              text: result.text,
              confidence: result.confidence ?? 1.0,
              latencyMs: result.latencyMs ?? 0,
            },
            audioBlob,
          )
          return
        }

        // Legacy API: { transcription_text, response_text, tts_succeeded, turn_id }
        if (result.transcription_text) {
          addMessage({ type: 'guardian', text: result.transcription_text })
        }
        if (result.response_text) {
          addMessage({ type: 'response', text: result.response_text, turn_id: result.turn_id })
        }
        // Handle inline audio from legacy path
        if (result.audioBase64 && result.audioFormat && !voiceState.muted) {
          const cleanup = playAudioBase64(result.audioBase64, result.audioFormat)
          if (audioCleanupRef.current) audioCleanupRef.current()
          audioCleanupRef.current = cleanup
        } else if (result.tts_succeeded && result.turn_id && !voiceState.muted) {
          // Legacy: fetch audio by turn ID
          fetch(`/api/voice/audio/${result.turn_id}`)
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('audio fetch failed'))))
            .then((blob) => {
              const url = URL.createObjectURL(blob)
              const audio = new Audio(url)
              audio.onended = () => URL.revokeObjectURL(url)
              audio.play().catch((e) => console.warn('[Voice] Audio playback failed:', e))
            })
            .catch((e) => console.warn('[Voice] Failed to fetch TTS audio:', e))
        }
      } catch (error) {
        console.error('[Voice] Processing error:', error)
        addMessage({ type: 'error', text: 'Voice processing failed. Check console for details.' })
      } finally {
        setIsProcessing(false)
        setVoiceState({ processing: false })
      }
    },
    [addMessage, setVoiceState, processTranscriptionResult, voiceState.muted],
  )

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Clear any pending confirmation state when a new recording starts
      setPendingTranscription(null)
      audioChunksRef.current = []

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const mediaRecorder = new MediaRecorder(stream, { mimeType })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType })
        if (audioBlob.size > 0) {
          void sendToTranscribeEndpoint(audioBlob)
        }
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(100)
      setIsRecording(true)
      setVoiceState({ recording: true, permissionDenied: false })
    } catch (error) {
      const isDenied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')

      if (isDenied) {
        setVoiceState({ permissionDenied: true })
        addMessage({ type: 'error', text: 'Microphone permission denied. Allow microphone access and try again.' })
      } else {
        console.error('[Voice] Failed to start recording:', error)
        addMessage({ type: 'error', text: 'Microphone unavailable.' })
      }
    }
  }, [sendToTranscribeEndpoint, setVoiceState, addMessage])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
    setIsRecording(false)
    setVoiceState({ recording: false })
  }, [setVoiceState])

  const toggleRecording = useCallback(() => {
    if (voiceState.permissionDenied || isProcessing) return
    if (isRecording) {
      stopRecording()
    } else {
      void startRecording()
    }
  }, [voiceState.permissionDenied, isProcessing, isRecording, stopRecording, startRecording])

  // Guardian confirmed the low-confidence transcription
  const confirmTranscription = useCallback(() => {
    if (!pendingTranscription) return
    dispatchTextMessage(pendingTranscription.text)
    setPendingTranscription(null)
  }, [pendingTranscription, dispatchTextMessage])

  // Guardian rejected the low-confidence transcription -- discard it silently
  const rejectTranscription = useCallback(() => {
    setPendingTranscription(null)
  }, [])

  // Subscribe to the custom DOM event that the WebSocket hook dispatches when a
  // response message carries audioBase64. CustomEvent keeps this hook decoupled
  // from the WebSocket implementation.
  useEffect(() => {
    const handleAudioEvent = (e: Event) => {
      const custom = e as CustomEvent<{ audioBase64: string; audioFormat: string }>
      const currentMuted = useAppStore.getState().voiceState.muted
      if (!currentMuted) {
        const cleanup = playAudioBase64(custom.detail.audioBase64, custom.detail.audioFormat)
        if (audioCleanupRef.current) audioCleanupRef.current()
        audioCleanupRef.current = cleanup
      }
    }

    window.addEventListener('sylphie:audio_response', handleAudioEvent)

    return () => {
      window.removeEventListener('sylphie:audio_response', handleAudioEvent)
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      if (audioCleanupRef.current) {
        audioCleanupRef.current()
      }
    }
  }, [])

  return {
    isRecording,
    isProcessing,
    startRecording,
    stopRecording,
    toggleRecording,
    pendingTranscription,
    confirmTranscription,
    rejectTranscription,
  }
}
