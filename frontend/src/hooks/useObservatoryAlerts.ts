import { useState, useEffect, useCallback } from 'react'

export interface AttractorAlert {
  attractor_id: number
  name: string
  risk_score: number
  risk_level: string
  summary: string
  intervention: string
  timestamp: string
}

interface MetricValue {
  name: string
  value: number
  trend: 'improving' | 'stable' | 'declining'
}

interface UseObservatoryAlertsReturn {
  alerts: AttractorAlert[]
  reachable: boolean
  dismissed: Set<number>
  dismiss: (id: number) => void
}

/**
 * Derive attractor-state alerts from GET /api/metrics/health.
 *
 * The 6 CANON attractor states are detected from the health metric values:
 *   1. Type 2 Addict — Type1Type2Ratio < 0.1 (LLM always wins, Type 1 never forms)
 *   2. Rule Drift — ProvenanceRatio declining trend (LLM_GENERATED growing)
 *   3. Hallucinated Knowledge — ProvenanceRatio < 0.4 (too much LLM_GENERATED knowledge)
 *   4. Depressive Attractor — GuardianResponseRate < 0.2 AND trend declining
 *   5. Planning Runaway — PredictionMAE > 0.5 (too many prediction failures)
 *   6. Prediction Pessimist — PredictionMAE > 0.3 AND GuardianResponseRate < 0.3
 *
 * Falls back gracefully if the endpoint is unreachable.
 */
function deriveAttractorAlerts(metrics: MetricValue[]): AttractorAlert[] {
  const get = (name: string): MetricValue | undefined => metrics.find((m) => m.name === name)
  const now = new Date().toISOString()
  const alerts: AttractorAlert[] = []

  const type1Type2 = get('Type1Type2Ratio')
  const predictionMae = get('PredictionMAE')
  const provenanceRatio = get('ProvenanceRatio')
  const guardianResponse = get('GuardianResponseRate')

  // 1. Type 2 Addict — Type 1/Type 2 ratio never increases
  if (type1Type2 && isFinite(type1Type2.value) && type1Type2.value < 0.1) {
    const score = Math.max(0, 1.0 - type1Type2.value * 10)
    alerts.push({
      attractor_id: 1,
      name: 'Type 2 Addict',
      risk_score: score,
      risk_level: score > 0.7 ? 'HIGH' : 'MEDIUM',
      summary: `Type 1/Type 2 ratio is ${(type1Type2.value * 100).toFixed(1)}% — LLM deliberation dominates; reflexes are not forming.`,
      intervention: 'Check that prediction evaluation is running and that Type 1 graduation thresholds are not set too high.',
      timestamp: now,
    })
  }

  // 2. Rule Drift — provenance ratio declining (LLM_GENERATED growing)
  if (provenanceRatio && provenanceRatio.trend === 'declining') {
    alerts.push({
      attractor_id: 2,
      name: 'Rule Drift',
      risk_score: 0.5,
      risk_level: 'MEDIUM',
      summary: `Experiential provenance ratio is declining — LLM_GENERATED nodes may be accumulating faster than experiential ones.`,
      intervention: 'Review recent WKG additions for LLM_GENERATED provenance. Ensure guardian corrections are being applied.',
      timestamp: now,
    })
  }

  // 3. Hallucinated Knowledge — too much LLM_GENERATED content (low provenance ratio)
  if (provenanceRatio && isFinite(provenanceRatio.value) && provenanceRatio.value < 0.4) {
    const score = Math.max(0, (0.4 - provenanceRatio.value) / 0.4)
    alerts.push({
      attractor_id: 3,
      name: 'Hallucinated Knowledge',
      risk_score: score,
      risk_level: score > 0.6 ? 'HIGH' : 'MEDIUM',
      summary: `Experiential provenance ratio is ${(provenanceRatio.value * 100).toFixed(1)}% — graph may contain too much unverified LLM-generated knowledge.`,
      intervention: 'Review WKG nodes with LLM_GENERATED provenance. Correct or confirm via guardian interaction.',
      timestamp: now,
    })
  }

  // 4. Depressive Attractor — guardian engagement collapsing
  if (guardianResponse && isFinite(guardianResponse.value) && guardianResponse.value < 0.2 && guardianResponse.trend === 'declining') {
    const score = Math.max(0, (0.2 - guardianResponse.value) / 0.2)
    alerts.push({
      attractor_id: 4,
      name: 'Depressive Attractor',
      risk_score: score,
      risk_level: score > 0.7 ? 'CRITICAL' : 'HIGH',
      summary: `Guardian response rate is ${(guardianResponse.value * 100).toFixed(1)}% and declining — social drive is not resolving.`,
      intervention: 'Engage Sylphie directly. Check Social drive pressure. Review whether initiated comments are relevant.',
      timestamp: now,
    })
  }

  // 5. Planning Runaway — prediction MAE too high
  if (predictionMae && isFinite(predictionMae.value) && predictionMae.value > 0.5) {
    const score = Math.min(1.0, (predictionMae.value - 0.5) / 0.5)
    alerts.push({
      attractor_id: 5,
      name: 'Planning Runaway',
      risk_score: score,
      risk_level: score > 0.6 ? 'HIGH' : 'MEDIUM',
      summary: `Prediction MAE is ${predictionMae.value.toFixed(3)} — predictions are consistently inaccurate, creating excessive Type 2 load.`,
      intervention: 'Review prediction evaluation logic. Consider resetting poorly-performing procedures below graduation threshold.',
      timestamp: now,
    })
  }

  // 6. Prediction Pessimist — moderate MAE combined with low guardian response
  if (
    predictionMae && isFinite(predictionMae.value) && predictionMae.value > 0.3 &&
    guardianResponse && isFinite(guardianResponse.value) && guardianResponse.value < 0.3
  ) {
    const maeContrib = (predictionMae.value - 0.3) / 0.7
    const responseContrib = (0.3 - guardianResponse.value) / 0.3
    const score = Math.min(1.0, (maeContrib + responseContrib) / 2)
    if (score > 0.2) {
      alerts.push({
        attractor_id: 6,
        name: 'Prediction Pessimist',
        risk_score: score,
        risk_level: score > 0.6 ? 'HIGH' : 'MEDIUM',
        summary: `Combined signal: prediction MAE ${predictionMae.value.toFixed(3)} and guardian response rate ${(guardianResponse.value * 100).toFixed(1)}% suggest early failure flooding.`,
        intervention: 'Allow more time for prediction evaluation to stabilise. Check that failure events are not overwhelming the learning queue.',
        timestamp: now,
      })
    }
  }

  return alerts
}

export function useObservatoryAlerts(pollIntervalMs: number = 15_000): UseObservatoryAlertsReturn {
  const [alerts, setAlerts] = useState<AttractorAlert[]>([])
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const [reachable, setReachable] = useState(false)

  useEffect(() => {
    let active = true

    const poll = async () => {
      // First try the dedicated alerts endpoint (may be added in a future sprint)
      try {
        const res = await fetch('/api/metrics/observatory/alerts')
        if (res.ok) {
          const data: AttractorAlert[] = await res.json()
          if (active) {
            setAlerts(data)
            setReachable(true)
          }
          return
        }
      } catch {
        // Dedicated endpoint not available — fall through to health metrics derivation
      }

      // Fall back to deriving attractor alerts from GET /api/metrics/health
      try {
        const res = await fetch('/api/metrics/health')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const metrics: MetricValue[] = data.metrics ?? []
        const derived = deriveAttractorAlerts(metrics)
        if (active) {
          setAlerts(derived)
          setReachable(true)
        }
      } catch {
        if (active) {
          setAlerts([])
          setReachable(false)
        }
      }
    }

    poll()
    const interval = setInterval(poll, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollIntervalMs])

  const dismiss = useCallback((id: number) => {
    setDismissed((prev) => new Set([...prev, id]))
  }, [])

  return { alerts, reachable, dismissed, dismiss }
}
