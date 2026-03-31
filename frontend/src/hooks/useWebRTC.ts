import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store'
import { SignalingMessage, WebRTCConnectionState } from '../types'

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTOCOL}//${window.location.host}`

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export interface UseWebRTCOptions {
  audio?: boolean
  video?: boolean | MediaTrackConstraints
  autoConnect?: boolean
}

export interface UseWebRTCReturn {
  connect: () => Promise<void>
  disconnect: () => void
  toggleAudio: () => void
  toggleVideo: () => void
  localVideoRef: React.RefObject<HTMLVideoElement | null>
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  connectionState: WebRTCConnectionState
  audioEnabled: boolean
  videoEnabled: boolean
  error: string | null
}

export function useWebRTC(options: UseWebRTCOptions = {}): UseWebRTCReturn {
  const { audio = true, video = true, autoConnect = false } = options

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const iceCandidateQueue = useRef<RTCIceCandidateInit[]>([])

  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { setWebRTCState, setCameraState } = useAppStore()
  const webrtcState = useAppStore((state) => state.webrtcState)

  const computeBackoffDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000)
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }, [])

  const releaseMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
      setLocalStream(null)
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    remoteStreamRef.current = null
    setRemoteStream(null)
    setWebRTCState({ hasLocalStream: false, hasRemoteStream: false })
  }, [setWebRTCState])

  const closePeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    iceCandidateQueue.current = []
  }, [])

  const closeSignaling = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    setWebRTCState({ signalingState: 'disconnected' })
  }, [setWebRTCState])

  const sendSignaling = useCallback((msg: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    } else {
      console.warn('[WebRTC] Cannot send signaling — socket not open')
    }
  }, [])

  const drainIceCandidateQueue = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !pc.remoteDescription) return

    while (iceCandidateQueue.current.length > 0) {
      const candidate = iceCandidateQueue.current.shift()!
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('[WebRTC] Failed to add queued ICE candidate:', err)
      }
    }
  }, [])

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    pcRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling({ type: 'candidate', candidate: event.candidate.toJSON() })
      }
    }

    pc.ontrack = (event) => {
      console.info('[WebRTC] Remote track received:', event.track.kind)
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream()
        setRemoteStream(remoteStreamRef.current)
        setWebRTCState({ hasRemoteStream: true })
      }
      remoteStreamRef.current.addTrack(event.track)
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState as WebRTCConnectionState
      setWebRTCState({ connectionState: state })
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        setError('ICE connection failed — check network/firewall')
        setWebRTCState({ connectionState: 'failed' })
      }
    }

    return pc
  }, [sendSignaling, setWebRTCState])

  const handleSignalingMessage = useCallback(
    async (msg: SignalingMessage) => {
      const pc = pcRef.current

      switch (msg.type) {
        case 'ready': {
          if (!pc) break
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            sendSignaling({ type: 'offer', sdp: offer.sdp! })
            setWebRTCState({ connectionState: 'connecting' })
          } catch (err) {
            console.error('[WebRTC] Failed to create offer:', err)
            setError('Failed to create WebRTC offer')
          }
          break
        }

        case 'answer': {
          if (!pc) break
          try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
            await drainIceCandidateQueue()
          } catch (err) {
            console.error('[WebRTC] Failed to set remote description:', err)
            setError('Failed to set remote description')
          }
          break
        }

        case 'offer': {
          if (!pc) break
          try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }))
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            sendSignaling({ type: 'answer', sdp: answer.sdp! })
            await drainIceCandidateQueue()
            setWebRTCState({ connectionState: 'connecting' })
          } catch (err) {
            console.error('[WebRTC] Failed to handle offer:', err)
            setError('Failed to handle incoming offer')
          }
          break
        }

        case 'candidate': {
          if (!pc) break
          if (!pc.remoteDescription) {
            iceCandidateQueue.current.push(msg.candidate)
          } else {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
            } catch (err) {
              console.warn('[WebRTC] Failed to add ICE candidate:', err)
            }
          }
          break
        }

        case 'error': {
          console.error('[WebRTC] Signaling error from server:', msg.message)
          setError(msg.message)
          break
        }
      }
    },
    [sendSignaling, drainIceCandidateQueue, setWebRTCState],
  )

  const connectSignaling = useCallback(
    (stream: MediaStream) => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }

      if (wsRef.current?.readyState !== WebSocket.CLOSED) {
        wsRef.current?.close()
      }

      try {
        const ws = new WebSocket(`${WS_BASE}/ws/webrtc`)
        wsRef.current = ws
        setWebRTCState({ signalingState: 'reconnecting' })

        ws.onopen = () => {
          setWebRTCState({ signalingState: 'connected' })
          reconnectAttemptRef.current = 0

          const pc = createPeerConnection()
          stream.getTracks().forEach((track) => {
            pc.addTrack(track, stream)
          })
        }

        ws.onmessage = (event) => {
          try {
            const msg: SignalingMessage = JSON.parse(event.data)
            handleSignalingMessage(msg)
          } catch (err) {
            console.warn('[WebRTC] Invalid signaling message:', event.data)
          }
        }

        ws.onerror = () => {
          console.warn('[WebRTC] Signaling WebSocket error')
        }

        ws.onclose = (event) => {
          wsRef.current = null
          setWebRTCState({ signalingState: 'disconnected' })

          if (pcRef.current && pcRef.current.connectionState !== 'closed') {
            const delay = computeBackoffDelay(reconnectAttemptRef.current)
            reconnectAttemptRef.current++
            reconnectTimeoutRef.current = window.setTimeout(() => {
              reconnectTimeoutRef.current = null
              if (localStreamRef.current) {
                connectSignaling(localStreamRef.current)
              }
            }, delay)
          }

          console.info(`[WebRTC] Signaling WebSocket closed (${event.code})`)
        }
      } catch (err) {
        console.error('[WebRTC] Could not create signaling WebSocket:', err)
        setWebRTCState({ signalingState: 'disconnected' })
        setError('Failed to connect signaling channel')
      }
    },
    [setWebRTCState, createPeerConnection, handleSignalingMessage, computeBackoffDelay],
  )

  const connect = useCallback(async () => {
    setError(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video })
      localStreamRef.current = stream
      setLocalStream(stream)
      setWebRTCState({ hasLocalStream: true, audioEnabled: true, videoEnabled: !!video, connectionState: 'new' })
      setCameraState({ active: true, feedMode: 'local' })

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access camera/microphone'
      setError(message)
      // getUserMedia failed — signal the panel to attempt MJPEG fallback
      setCameraState({ feedMode: 'mjpeg' })
      return
    }

    connectSignaling(localStreamRef.current!)
  }, [audio, video, setWebRTCState, setCameraState, connectSignaling])

  const disconnect = useCallback(() => {
    closePeerConnection()
    closeSignaling()
    releaseMedia()
    setWebRTCState({ connectionState: 'closed' })
    setError(null)
  }, [closePeerConnection, closeSignaling, releaseMedia, setWebRTCState])

  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    stream.getAudioTracks().forEach((track) => { track.enabled = !track.enabled })
    const enabled = stream.getAudioTracks().some((t) => t.enabled)
    setWebRTCState({ audioEnabled: enabled })
  }, [setWebRTCState])

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    stream.getVideoTracks().forEach((track) => { track.enabled = !track.enabled })
    const enabled = stream.getVideoTracks().some((t) => t.enabled)
    setWebRTCState({ videoEnabled: enabled })
  }, [setWebRTCState])

  useEffect(() => {
    if (autoConnect) {
      connect()
    }
    return () => {
      closePeerConnection()
      closeSignaling()
      releaseMedia()
    }
  }, [autoConnect]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    connect,
    disconnect,
    toggleAudio,
    toggleVideo,
    localVideoRef,
    remoteVideoRef,
    localStream,
    remoteStream,
    connectionState: webrtcState.connectionState,
    audioEnabled: webrtcState.audioEnabled,
    videoEnabled: webrtcState.videoEnabled,
    error,
  }
}
