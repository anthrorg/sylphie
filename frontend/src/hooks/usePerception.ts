import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store'
import type { RecognizedItem } from '../types'

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
  mask_polygon: number[][] | null
}

interface FaceDetection {
  confidence: number
  bbox_x_min: number
  bbox_y_min: number
  bbox_x_max: number
  bbox_y_max: number
  landmarks: number[][] | null
  blendshapes: Record<string, number> | null
}

interface TrackedObject {
  track_id: number
  state: string
  label: string
  confidence: number
  bbox: [number, number, number, number]
  frames_seen: number
  frames_lost: number
  first_seen_at: string | null
  last_seen_at: string | null
  embedding: number[] | null
}

interface SceneEvent {
  type: string
  trackId: number
  label: string
  confidence: number
  bbox: [number, number, number, number]
  timestamp: number
  personId?: string
}

interface VwmEntity {
  id: string
  label: string
  displayName: string | null
  type: 'object' | 'face'
  discovered: boolean
  personId: string | null
  trackIds: number[]
}

/** Capitalize and clean up raw YOLO/model label for display. */
function friendlyLabel(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export type AnnotationLayer =
  | 'objects'
  | 'tracking'
  | 'face-mesh'
  | 'face-dots'
  | 'face-contour'
  | 'face-bbox'

export interface UsePerceptionReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  active: boolean
  error: string | null
  layers: AnnotationLayer[]
  setLayers: (layers: AnnotationLayer[]) => void
}

/**
 * Captures camera via getUserMedia, streams JPEG frames over WebSocket
 * to NestJS -> YOLO (segmentation) + MediaPipe (Face Landmarker),
 * receives detection JSON back, and draws annotations client-side.
 *
 * Object layer: polygon contour masks (falls back to bounding box).
 * Face layers (independently toggleable):
 *   - mesh: 124-connection wireframe
 *   - dots: 478 individual landmark points
 *   - contour: face oval outline (36 connections)
 *   - bbox: simple bounding box
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
  const faceConnectionsRef = useRef<number[][]>([])
  const faceOvalRef = useRef<number[][]>([])
  const trackedObjectsRef = useRef<TrackedObject[]>([])
  const sceneEventsRef = useRef<SceneEvent[]>([])
  const vwmEntitiesRef = useRef<VwmEntity[]>([])
  const recentTrackIdsRef = useRef<Set<number>>(new Set())
  const rafRef = useRef<number | null>(null)
  const layersRef = useRef<AnnotationLayer[]>(['objects', 'face-mesh'])

  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layers, setLayersState] = useState<AnnotationLayer[]>(['objects', 'face-mesh'])

  const { setCameraState, setRecognizedItems } = useAppStore()

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

        startRenderLoop(video)

        const ws = new WebSocket(`${WS_BASE}/ws/perception`)
        wsRef.current = ws

        ws.onopen = () => {
          setCameraState({ feedMode: 'webrtc' })

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

        ws.onmessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
            detectionsRef.current = data.detections ?? []
            faceDetectionsRef.current = data.faces ?? []
            if (data.face_connections?.length > 0) {
              faceConnectionsRef.current = data.face_connections
            }
            if (data.face_oval?.length > 0) {
              faceOvalRef.current = data.face_oval
            }
            // Tracked objects and scene events from SceneEventDetector
            trackedObjectsRef.current = data.tracked_objects ?? []
            sceneEventsRef.current = data.scene_events ?? []

            // Build set of novel track IDs from scene events
            const novelIds = new Set<number>()
            for (const evt of sceneEventsRef.current) {
              if (evt.type === 'object_appeared' || evt.type === 'person_arrived') {
                novelIds.add(evt.trackId)
              }
            }
            recentTrackIdsRef.current = novelIds

            // Store VWM entities for overlay rendering
            vwmEntitiesRef.current = (data.vwm_entities ?? []) as VwmEntity[]

            // Build recognized items from VWM entities (stabilized, WKG-resolved)
            const vwmEntities = data.vwm_entities as Array<{
              id: string
              label: string
              displayName: string | null
              type: 'object' | 'face'
              confidence: number
              discovered: boolean
              nodeId: string | null
              personId: string | null
              state: string
              duration: number
            }> | undefined

            const items: RecognizedItem[] = []

            if (vwmEntities && vwmEntities.length > 0) {
              // Use VWM entities — stabilized, deduplicated, with KG-resolved names
              for (const entity of vwmEntities) {
                const label = entity.displayName
                  ? friendlyLabel(entity.displayName)
                  : friendlyLabel(entity.label)

                items.push({
                  id: entity.id,
                  label,
                  type: entity.type,
                  confidence: entity.confidence,
                  discovered: entity.discovered,
                  nodeId: entity.nodeId,
                  personId: entity.personId,
                  duration: entity.duration,
                  state: entity.state as RecognizedItem['state'],
                })
              }
            } else {
              // Fallback to raw detections when VWM isn't active yet.
              // Everything is undiscovered — YOLO labels are sensory hints,
              // not knowledge. Sylphie doesn't "know" anything she hasn't learned.
              const seen = new Set<string>()
              for (const d of detectionsRef.current) {
                const label = friendlyLabel(d.label_raw)
                const key = `obj:${label}`
                if (!seen.has(key)) {
                  seen.add(key)
                  items.push({ id: key, label, type: 'object', confidence: d.confidence, discovered: false })
                }
              }
            }

            setRecognizedItems(items)
          } catch {
            // Not JSON — ignore
          }
        }

        ws.onclose = () => {
          if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null }
          detectionsRef.current = []
          faceDetectionsRef.current = []
          setRecognizedItems([])
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

        ctx.drawImage(video, 0, 0)

        const al = layersRef.current

        // --- Object layer: polygon contours or bounding boxes (no labels — raw perception) ---
        if (al.includes('objects')) {
          const dets = detectionsRef.current
          for (const d of dets) {
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)'
            ctx.lineWidth = 1

            if (d.mask_polygon && d.mask_polygon.length > 2) {
              ctx.beginPath()
              ctx.moveTo(d.mask_polygon[0][0], d.mask_polygon[0][1])
              for (let i = 1; i < d.mask_polygon.length; i++) {
                ctx.lineTo(d.mask_polygon[i][0], d.mask_polygon[i][1])
              }
              ctx.closePath()
              ctx.stroke()
              ctx.fillStyle = 'rgba(0, 255, 0, 0.05)'
              ctx.fill()
            } else {
              ctx.strokeRect(d.bbox_x_min, d.bbox_y_min,
                d.bbox_x_max - d.bbox_x_min, d.bbox_y_max - d.bbox_y_min)
            }
            // No labels — YOLO hints are not Sylphie's knowledge
          }
        }

        // --- Tracking layer: Sylphie's knowledge overlay ---
        // Shows what Sylphie actually knows, not YOLO hints.
        // VWM entities = stabilized + WKG-resolved. Unknown items show "?".
        if (al.includes('tracking')) {
          const tracked = trackedObjectsRef.current
          const vwm = vwmEntitiesRef.current
          const events = sceneEventsRef.current

          // Build track ID → VWM entity lookup
          const trackToVwm = new Map<number, VwmEntity>()
          for (const entity of vwm) {
            for (const tid of entity.trackIds) {
              trackToVwm.set(tid, entity)
            }
          }

          // Draw confirmed tracks — labeled only if Sylphie knows what they are
          for (const obj of tracked) {
            if (obj.state !== 'confirmed') continue

            const entity = trackToVwm.get(obj.track_id)

            // Color: known = green, unknown = orange, no VWM match = dim
            let color: string
            let label: string

            if (entity) {
              if (entity.discovered) {
                color = entity.type === 'face' ? '#00ddff' : '#00ff88'
                label = friendlyLabel(entity.displayName ?? entity.label)
              } else {
                color = '#ff9800'
                label = '?'
              }
            } else {
              // Not yet stabilized in VWM — show faint box, no label
              color = 'rgba(255, 255, 255, 0.15)'
              label = ''
            }

            ctx.strokeStyle = color
            ctx.lineWidth = entity ? 2 : 1
            const [x1, y1, x2, y2] = obj.bbox
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

            if (label) {
              ctx.font = entity?.discovered ? 'bold 12px monospace' : '11px monospace'
              ctx.fillStyle = color
              const labelY = y1 > 16 ? y1 - 4 : y2 + 14
              ctx.fillText(label, x1, labelY)
            }
          }

          // Draw person names from face identification
          for (const entity of vwm) {
            if (entity.type !== 'face' || !entity.personId || !entity.discovered) continue
            // Find the matching tracked object for position
            const matchingTrack = tracked.find(t => entity.trackIds.includes(t.track_id) && t.state === 'confirmed')
            if (!matchingTrack) continue
            const [x1, y1] = matchingTrack.bbox
            ctx.font = 'bold 13px monospace'
            ctx.fillStyle = '#00ddff'
            ctx.fillText(friendlyLabel(entity.personId), x1, y1 > 30 ? y1 - 18 : y1 + 28)
          }

          // Draw FACE_OCCLUDED indicator
          for (const evt of events) {
            if (evt.type !== 'face_occluded') continue
            const [x1, y1, x2, y2] = evt.bbox
            ctx.setLineDash([3, 3])
            ctx.strokeStyle = '#ffaa00'
            ctx.lineWidth = 2
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
            ctx.setLineDash([])

            ctx.font = '10px monospace'
            ctx.fillStyle = '#ffaa00'
            ctx.fillText('?', x1 + (x2 - x1) / 2 - 4, (y1 + y2) / 2 + 4)
          }
        }

        // --- Face layers ---
        const faces = faceDetectionsRef.current
        const showMesh = al.includes('face-mesh')
        const showDots = al.includes('face-dots')
        const showContour = al.includes('face-contour')
        const showBbox = al.includes('face-bbox')

        if (showMesh || showDots || showContour || showBbox) {
          const meshConns = faceConnectionsRef.current
          const ovalConns = faceOvalRef.current

          for (const f of faces) {
            const lm = f.landmarks

            // Face mesh wireframe (124 contour connections)
            if (showMesh && lm && lm.length > 0 && meshConns.length > 0) {
              ctx.strokeStyle = 'rgba(0, 191, 255, 0.45)'
              ctx.lineWidth = 1
              ctx.beginPath()
              for (const conn of meshConns) {
                const s = lm[conn[0]]
                const e = lm[conn[1]]
                if (s && e) {
                  ctx.moveTo(s[0], s[1])
                  ctx.lineTo(e[0], e[1])
                }
              }
              ctx.stroke()
            }

            // Face contour (36 oval connections)
            if (showContour && lm && lm.length > 0 && ovalConns.length > 0) {
              ctx.strokeStyle = 'rgba(255, 165, 0, 0.7)'
              ctx.lineWidth = 2
              ctx.beginPath()
              for (const conn of ovalConns) {
                const s = lm[conn[0]]
                const e = lm[conn[1]]
                if (s && e) {
                  ctx.moveTo(s[0], s[1])
                  ctx.lineTo(e[0], e[1])
                }
              }
              ctx.stroke()
            }

            // Landmark dots (478 points)
            if (showDots && lm && lm.length > 0) {
              ctx.fillStyle = 'rgba(255, 64, 129, 0.6)'
              for (const pt of lm) {
                ctx.beginPath()
                ctx.arc(pt[0], pt[1], 1.2, 0, Math.PI * 2)
                ctx.fill()
              }
            }

            // Face bounding box
            if (showBbox) {
              ctx.strokeStyle = '#00bfff'
              ctx.lineWidth = 2
              ctx.strokeRect(f.bbox_x_min, f.bbox_y_min,
                f.bbox_x_max - f.bbox_x_min, f.bbox_y_max - f.bbox_y_min)
            }

            // No labels on face layers — just visual overlays (mesh, dots, contour, bbox).
            // Identity labels belong in the tracking layer, driven by VWM knowledge.
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
