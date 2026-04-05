import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store'

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTOCOL}//${window.location.host}`
const CAPTURE_FPS = 15
const JPEG_QUALITY = 0.6
const CAPTURE_WIDTH = 640
const CAPTURE_HEIGHT = 480

interface Detection {
  label_raw: string
  confidence: number
  bbox_x_min: number
  bbox_y_min: number
  bbox_x_max: number
  bbox_y_max: number
}

interface FaceDetection {
  confidence: number
  bbox_x_min: number
  bbox_y_min: number
  bbox_x_max: number
  bbox_y_max: number
  landmarks: [number, number][] | null
}

export type AnnotationLayer = 'objects' | 'faces'

export interface UsePerceptionReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  active: boolean
  error: string | null
  layers: AnnotationLayer[]
  setLayers: (layers: AnnotationLayer[]) => void
}

/**
 * Captures camera via getUserMedia, streams JPEG frames over WebSocket
 * to NestJS -> YOLO + MediaPipe, receives detection JSON back, and draws
 * bounding boxes client-side on the canvas.
 *
 * Supports two annotation layers (objects + faces) that can be toggled
 * independently via the `layers` / `setLayers` interface.
 */
export function usePerception(): UsePerceptionReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const intervalRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectionsRef = useRef<Detection[]>([])
  const faceDetectionsRef = useRef<FaceDetection[]>([])
  const rafRef = useRef<number | null>(null)
  const layersRef = useRef<AnnotationLayer[]>(['objects', 'faces'])

  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layers, setLayersState] = useState<AnnotationLayer[]>(['objects', 'faces'])

  const { setCameraState } = useAppStore()

  const setLayers = useCallback((newLayers: AnnotationLayer[]) => {
    setLayersState(newLayers)
    layersRef.current = newLayers
  }, [])

  const cleanup = useCallback(() => {
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    intervalRef.current = null
    rafRef.current = null
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
    if (videoRef.current) videoRef.current.srcObject = null
    setActive(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } },
          audio: false,
        })

        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream

        const video = document.createElement('video')
        video.srcObject = stream
        video.autoplay = true
        video.playsInline = true
        video.muted = true
        await video.play()
        videoRef.current = video

        const captureCanvas = document.createElement('canvas')
        captureCanvas.width = video.videoWidth || CAPTURE_WIDTH
        captureCanvas.height = video.videoHeight || CAPTURE_HEIGHT
        captureCanvasRef.current = captureCanvas

        setActive(true)
        setCameraState({ active: true, feedMode: 'local' })

        // Start render loop — draws raw video + bounding box overlays
        startRenderLoop(video)

        // Connect WebSocket for detection pipeline
        const ws = new WebSocket(`${WS_BASE}/ws/perception`)
        wsRef.current = ws

        ws.onopen = () => {
          setCameraState({ feedMode: 'webrtc' })

          // Send JPEG frames at CAPTURE_FPS
          intervalRef.current = window.setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || !videoRef.current || !captureCanvasRef.current) return

            const v = videoRef.current
            const c = captureCanvasRef.current
            const ctx = c.getContext('2d')
            if (!ctx) return

            if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
              c.width = v.videoWidth
              c.height = v.videoHeight
            }

            ctx.drawImage(v, 0, 0)
            c.toBlob(
              (blob) => {
                if (blob && ws.readyState === WebSocket.OPEN) {
                  blob.arrayBuffer().then((buf) => ws.send(buf))
                }
              },
              'image/jpeg',
              JPEG_QUALITY,
            )
          }, 1000 / CAPTURE_FPS)
        }

        // Receive multi-layer detection JSON
        ws.onmessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
            detectionsRef.current = data.detections ?? []
            faceDetectionsRef.current = data.faces ?? []
          } catch {
            // Not JSON — ignore
          }
        }

        ws.onclose = () => {
          if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null }
          detectionsRef.current = []
          faceDetectionsRef.current = []
          setCameraState({ feedMode: 'local' })
        }

        ws.onerror = () => { /* raw feed continues */ }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera permission denied'
            : `Camera error: ${(err as Error).message}`
          setError(msg)
          setCameraState({ active: false, feedMode: 'unavailable' })
        }
      }
    }

    function startRenderLoop(video: HTMLVideoElement) {
      function draw() {
        const canvas = canvasRef.current
        if (!canvas || !video) { rafRef.current = requestAnimationFrame(draw); return }

        const vw = video.videoWidth || CAPTURE_WIDTH
        const vh = video.videoHeight || CAPTURE_HEIGHT
        if (canvas.width !== vw || canvas.height !== vh) {
          canvas.width = vw
          canvas.height = vh
        }

        const ctx = canvas.getContext('2d')
        if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }

        // Draw raw camera frame
        ctx.drawImage(video, 0, 0)

        const activeLayers = layersRef.current

        // Draw YOLO object bounding boxes (green)
        if (activeLayers.includes('objects')) {
          const dets = detectionsRef.current
          for (const d of dets) {
            const x = d.bbox_x_min
            const y = d.bbox_y_min
            const w = d.bbox_x_max - d.bbox_x_min
            const h = d.bbox_y_max - d.bbox_y_min

            ctx.strokeStyle = '#00ff00'
            ctx.lineWidth = 2
            ctx.strokeRect(x, y, w, h)

            // Label
            const label = `${d.label_raw} ${(d.confidence * 100).toFixed(0)}%`
            ctx.font = '12px monospace'
            ctx.fillStyle = '#00ff00'
            ctx.fillText(label, x, y > 14 ? y - 4 : y + h + 14)
          }
        }

        // Draw face bounding boxes (cyan) + landmarks (pink dots)
        if (activeLayers.includes('faces')) {
          const faces = faceDetectionsRef.current
          for (const f of faces) {
            const x = f.bbox_x_min
            const y = f.bbox_y_min
            const w = f.bbox_x_max - f.bbox_x_min
            const h = f.bbox_y_max - f.bbox_y_min

            ctx.strokeStyle = '#00bfff'
            ctx.lineWidth = 2
            ctx.strokeRect(x, y, w, h)

            // Confidence label
            const label = `face ${(f.confidence * 100).toFixed(0)}%`
            ctx.font = '12px monospace'
            ctx.fillStyle = '#00bfff'
            ctx.fillText(label, x, y > 14 ? y - 4 : y + h + 14)

            // Landmark dots
            if (f.landmarks) {
              ctx.fillStyle = '#ff4081'
              for (const [lx, ly] of f.landmarks) {
                ctx.beginPath()
                ctx.arc(lx, ly, 2, 0, Math.PI * 2)
                ctx.fill()
              }
            }
          }
        }

        rafRef.current = requestAnimationFrame(draw)
      }
      draw()
    }

    start()
    return () => { cancelled = true; cleanup() }
  }, [cleanup, setCameraState])

  return { canvasRef, active, error, layers, setLayers }
}
