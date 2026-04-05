import React, { useEffect, useRef, useState } from 'react'
import { Box, Typography, Chip } from '@mui/material'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  type ChartOptions,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useAudioStream } from '../../hooks/useAudioStream'
import { useAppStore } from '../../store'

ChartJS.register(CategoryScale, LinearScale, BarElement)

const NUM_BARS = 24

const barOptions: ChartOptions<'bar'> = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 8,
  layout: { padding: 0 },
  animation: { duration: 80 },
  plugins: { tooltip: { enabled: false }, legend: { display: false } },
  scales: {
    y: { min: 0, max: 1, display: false },
    x: { display: false },
  },
}

export const AudioPanel: React.FC = () => {
  const { stream, isStreaming, error, transcript } = useAudioStream()
  const voiceState = useAppStore((s) => s.voiceState)
  const [inputLevels, setInputLevels] = useState<number[]>(() => new Array(NUM_BARS).fill(0))
  const [outputLevels, setOutputLevels] = useState<number[]>(() => new Array(NUM_BARS).fill(0))
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)
  const outputDecayRef = useRef<number>(0)

  // Wire FFT analyser to the shared MediaStream from useAudioStream
  useEffect(() => {
    if (!stream) return

    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    source.connect(analyser)
    analyserRef.current = analyser

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(dataArray)
      const levels = Array.from(dataArray.slice(0, NUM_BARS)).map((v) => v / 255)
      setInputLevels(levels)
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(rafRef.current)
      analyserRef.current = null
      ctx.close()
      audioCtxRef.current = null
    }
  }, [stream])

  // Listen for TTS audio playback events to visualize on the OUT bars
  useEffect(() => {
    const handleAudioResponse = (e: Event) => {
      const custom = e as CustomEvent<{ audioBase64: string; audioFormat: string }>
      if (voiceState.muted) return

      try {
        const binary = atob(custom.detail.audioBase64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        const blob = new Blob([bytes], { type: custom.detail.audioFormat || 'audio/mpeg' })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)

        // Create audio context for output visualization
        const ctx = new AudioContext()
        const source = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 64
        source.connect(analyser)
        source.connect(ctx.destination)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        let raf = 0

        const tickOutput = () => {
          analyser.getByteFrequencyData(dataArray)
          const levels = Array.from(dataArray.slice(0, NUM_BARS)).map((v) => v / 255)
          setOutputLevels(levels)
          raf = requestAnimationFrame(tickOutput)
        }

        audio.onplay = () => {
          outputDecayRef.current = 0
          tickOutput()
        }

        audio.onended = () => {
          cancelAnimationFrame(raf)
          setOutputLevels(new Array(NUM_BARS).fill(0))
          URL.revokeObjectURL(url)
          ctx.close()
        }

        audio.onerror = () => {
          cancelAnimationFrame(raf)
          setOutputLevels(new Array(NUM_BARS).fill(0))
          URL.revokeObjectURL(url)
          ctx.close()
        }

        audio.play().catch((err) => {
          console.warn('[AudioPanel] TTS playback failed:', err)
          URL.revokeObjectURL(url)
          ctx.close()
        })
      } catch (err) {
        console.warn('[AudioPanel] TTS audio decode failed:', err)
      }
    }

    window.addEventListener('sylphie:audio_response', handleAudioResponse)
    return () => {
      window.removeEventListener('sylphie:audio_response', handleAudioResponse)
    }
  }, [voiceState.muted])

  const inputData = {
    labels: new Array(NUM_BARS).fill(''),
    datasets: [
      {
        data: inputLevels,
        backgroundColor: isStreaming ? 'rgba(76, 175, 80, 0.7)' : error ? 'rgba(244, 67, 54, 0.5)' : 'rgba(255,255,255,0.15)',
        borderRadius: 2,
        barPercentage: 0.8,
        categoryPercentage: 0.9,
      },
    ],
  }

  const outputData = {
    labels: new Array(NUM_BARS).fill(''),
    datasets: [
      {
        data: outputLevels,
        backgroundColor: outputLevels.some((v) => v > 0)
          ? 'rgba(100, 181, 246, 0.7)'
          : 'rgba(255,255,255,0.15)',
        borderRadius: 2,
        barPercentage: 0.8,
        categoryPercentage: 0.9,
      },
    ],
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* Input level */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.65rem', whiteSpace: 'nowrap' }}
          >
            IN
          </Typography>
          <Box sx={{ flex: 1 }}>
            <Bar data={inputData} options={barOptions} />
          </Box>
        </Box>

        {/* Status indicator */}
        <Chip
          label={error ? 'MIC ERR' : isStreaming ? 'LIVE' : 'CONNECTING'}
          size="small"
          sx={{
            fontSize: '0.6rem',
            height: 20,
            fontFamily: 'monospace',
            bgcolor: error
              ? 'rgba(244, 67, 54, 0.15)'
              : isStreaming
                ? 'rgba(76, 175, 80, 0.15)'
                : 'rgba(255, 152, 0, 0.15)',
            color: error
              ? '#f44336'
              : isStreaming
                ? '#4caf50'
                : '#ff9800',
            border: '1px solid',
            borderColor: error
              ? 'rgba(244, 67, 54, 0.4)'
              : isStreaming
                ? 'rgba(76, 175, 80, 0.4)'
                : 'rgba(255, 152, 0, 0.4)',
          }}
        />

        {/* Output level */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          <Box sx={{ flex: 1 }}>
            <Bar data={outputData} options={barOptions} />
          </Box>
          <Typography
            variant="caption"
            sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.65rem', whiteSpace: 'nowrap' }}
          >
            OUT
          </Typography>
        </Box>
      </Box>

      {/* Live transcription display */}
      {transcript && (
        <Box
          sx={{
            mt: 0.5,
            px: 1,
            py: 0.5,
            bgcolor: 'rgba(255,255,255,0.04)',
            borderRadius: 1,
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: 'rgba(255,255,255,0.6)',
              fontSize: '0.7rem',
              fontStyle: 'italic',
            }}
          >
            {transcript}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
