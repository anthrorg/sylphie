import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '../store'

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTOCOL}//${window.location.host}`

/** How often MediaRecorder emits a chunk (ms). */
const TIMESLICE_MS = 250

export interface TranscriptionEvent {
  text: string
  is_final: boolean
  confidence: number
  speech_final: boolean
}

/**
 * Continuously captures microphone audio, encodes it as Opus/WebM via
 * MediaRecorder, and streams binary chunks over a WebSocket to /ws/audio.
 *
 * Also listens for transcription results from the Deepgram STT service
 * running on the backend. Transcriptions are returned via `transcript`
 * (live interim text) and dispatched as conversation messages when final.
 *
 * Returns the raw MediaStream so consumers (e.g. AudioPanel) can tap it
 * for FFT visualization without requesting a second mic permission.
 */
export interface UseAudioStreamReturn {
  /** The live MediaStream — use for AnalyserNode visualization */
  stream: MediaStream | null
  isStreaming: boolean
  error: string | null
  /** Current interim transcription text (updates in real-time as user speaks) */
  transcript: string
}

export function useAudioStream(): UseAudioStreamReturn {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const { setVoiceState } = useAppStore()

  const cleanup = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    recorderRef.current = null

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }

    setStream(null)
    setIsStreaming(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })

        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = mediaStream
        setStream(mediaStream)
        setVoiceState({ available: true, recording: true, permissionDenied: false })

        // Pick the best supported Opus container
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'

        const recorder = new MediaRecorder(mediaStream, { mimeType })
        recorderRef.current = recorder

        // Open WebSocket to backend audio gateway
        const ws = new WebSocket(`${WS_BASE}/ws/audio`)
        wsRef.current = ws

        ws.onopen = () => {
          if (cancelled) return

          // Send the MIME type as the first text message so backend knows the codec
          ws.send(JSON.stringify({ type: 'audio_config', mimeType }))

          // Start recording — ondataavailable fires every TIMESLICE_MS
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(event.data)
            }
          }

          recorder.start(TIMESLICE_MS)
          if (!cancelled) setIsStreaming(true)
        }

        // Listen for transcription results from the backend (Deepgram STT)
        ws.onmessage = (event) => {
          // Binary frames (e.g. echoed audio) — skip
          if (typeof event.data !== 'string') return

          try {
            const msg = JSON.parse(event.data)

            if (msg.type === 'transcription') {
              // Update live interim transcript for display in AudioPanel
              setTranscript(msg.text)
            }

            if (msg.type === 'utterance_complete' && msg.text?.trim()) {
              // The backend accumulated all is_final fragments into the
              // complete utterance. Dispatch it through the conversation
              // pipeline so it appears as a guardian message in the chat.
              console.info('[Audio] Complete utterance:', msg.text)
              window.dispatchEvent(
                new CustomEvent('sylphie:voice_text', { detail: { text: msg.text } }),
              )
              setTranscript('')
            }

            if (msg.type === 'restart_audio') {
              // Deepgram dropped — restart MediaRecorder so the next
              // connection gets a fresh WebM header it can decode.
              console.info('[Audio] Restarting audio stream (Deepgram reconnect)')
              if (recorderRef.current && recorderRef.current.state !== 'inactive') {
                recorderRef.current.stop()
              }
              // Start a new recorder on the same stream
              const newRecorder = new MediaRecorder(mediaStream, { mimeType })
              recorderRef.current = newRecorder
              newRecorder.ondataavailable = (ev) => {
                if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                  ws.send(ev.data)
                }
              }
              // Re-send config so backend knows the codec for the new stream
              ws.send(JSON.stringify({ type: 'audio_config', mimeType }))
              newRecorder.start(TIMESLICE_MS)
            }
          } catch {
            // Not JSON — ignore
          }
        }

        ws.onclose = () => {
          // If the WS drops, stop the recorder but keep the stream alive
          // so FFT visualization continues even if backend is down
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop()
          }
          if (!cancelled) setIsStreaming(false)
        }

        ws.onerror = () => {
          // WebSocket errors fire before close — let onclose handle state
        }
      } catch (err) {
        if (cancelled) return
        const isDenied = err instanceof DOMException && err.name === 'NotAllowedError'
        setError(isDenied ? 'Microphone permission denied' : `Mic error: ${(err as Error).message}`)
        setVoiceState({ available: false, permissionDenied: isDenied })
      }
    }

    start()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [cleanup, setVoiceState])

  return { stream, isStreaming, error, transcript }
}
