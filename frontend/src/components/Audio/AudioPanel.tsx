import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { Mic as MicIcon, Stop as StopIcon } from '@mui/icons-material'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  type ChartOptions,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useVoiceRecording } from '../../hooks/useVoiceRecording'

ChartJS.register(CategoryScale, LinearScale, BarElement)

// Number of frequency bins displayed in each spectrum visualizer bar chart
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
  const { isRecording, isProcessing, toggleRecording } = useVoiceRecording()
  const [inputLevels, setInputLevels] = useState<number[]>(() => new Array(NUM_BARS).fill(0))
  const [outputLevels, setOutputLevels] = useState<number[]>(() => new Array(NUM_BARS).fill(0))
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)

  // Monitor mic input levels when recording
  const startMonitoring = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 64 // 64-sample FFT yields 32 frequency bins; we use first 24
      source.connect(analyser)
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      // rAF loop: poll frequency data and normalize 0-255 -> 0.0-1.0 for chart display
      const tick = () => {
        analyser.getByteFrequencyData(dataArray)
        const levels = Array.from(dataArray.slice(0, NUM_BARS)).map((v) => v / 255)
        setInputLevels(levels)
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // mic not available - levels stay at 0
    }
  }, [])

  const stopMonitoring = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    analyserRef.current = null
    setInputLevels(new Array(NUM_BARS).fill(0))
  }, [])

  useEffect(() => {
    if (isRecording) {
      void startMonitoring()
    } else {
      stopMonitoring()
    }
    return stopMonitoring
  }, [isRecording, startMonitoring, stopMonitoring])

  // Output visualizer is simulated (random bars) while TTS is processing.
  // Real output monitoring would require intercepting the Audio element's output.
  useEffect(() => {
    if (isProcessing) {
      const id = setInterval(() => {
        setOutputLevels(Array.from({ length: NUM_BARS }, () => Math.random() * 0.4 + 0.1))
      }, 100)
      return () => {
        clearInterval(id)
        setOutputLevels(new Array(NUM_BARS).fill(0))
      }
    }
  }, [isProcessing])

  const inputData = {
    labels: new Array(NUM_BARS).fill(''),
    datasets: [
      {
        data: inputLevels,
        backgroundColor: isRecording ? 'rgba(244, 67, 54, 0.7)' : 'rgba(255,255,255,0.15)',
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
        backgroundColor: isProcessing ? 'rgba(76, 175, 80, 0.7)' : 'rgba(255,255,255,0.15)',
        borderRadius: 2,
        barPercentage: 0.8,
        categoryPercentage: 0.9,
      },
    ],
  }

  return (
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

      {/* Record button */}
      <IconButton
        onClick={toggleRecording}
        disabled={isProcessing}
        sx={{
          width: 52,
          height: 52,
          bgcolor: isRecording ? '#f44336' : 'rgba(255,255,255,0.1)',
          border: isRecording ? '2px solid #ef9a9a' : '2px solid rgba(255,255,255,0.2)',
          color: isRecording ? '#fff' : 'rgba(255,255,255,0.7)',
          transition: 'all 0.2s',
          '&:hover': {
            bgcolor: isRecording ? '#d32f2f' : 'rgba(255,255,255,0.2)',
          },
          '&.Mui-disabled': {
            color: 'rgba(255,255,255,0.3)',
            borderColor: 'rgba(255,255,255,0.1)',
          },
        }}
      >
        {isRecording ? <StopIcon sx={{ fontSize: 28 }} /> : <MicIcon sx={{ fontSize: 28 }} />}
      </IconButton>

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
  )
}
