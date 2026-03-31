import React, { useEffect } from 'react'
import {
  Box,
  Typography,
  IconButton,
  Chip,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
} from '@mui/material'
import { Refresh as RefreshIcon, TrendingUp as TrendingUpIcon } from '@mui/icons-material'
import {
  useObservatoryData,
  type VocabEntry,
  type DriveEntry,
  type ActionEntry,
  type SessionEntry,
  type ComprehensionEntry,
  type PhraseRatioEntry,
  type ExperientialProvenance,
  type DevStage,
} from '../../hooks/useObservatoryData'

// -- Simple SVG bar chart ---------------------------------------------------

const BarChart: React.FC<{
  data: { label: string; value: number }[]
  maxValue?: number
  height?: number
  color?: string
}> = ({ data, maxValue, height = 80, color = '#4fc3f7' }) => {
  if (data.length === 0) return null
  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1)
  // Scale bar width to fit container (600px max), clamped between 8-40px
  const barWidth = Math.max(8, Math.min(40, (600 - data.length * 2) / data.length))
  const chartWidth = data.length * (barWidth + 2)

  return (
    <svg
      width={Math.min(chartWidth, 600)}
      height={height + 20}
      viewBox={`0 0 ${Math.min(chartWidth, 600)} ${height + 20}`}
    >
      {data.map((d, i) => {
        const barHeight = (d.value / max) * height
        return (
          <g key={i}>
            <Tooltip title={`${d.label}: ${d.value}`}>
              <rect
                x={i * (barWidth + 2)}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                fill={color}
                opacity={0.75}
              />
            </Tooltip>
            {/* Only show x-axis labels when bars are sparse enough to read */}
            {data.length <= 15 && (
              <text
                x={i * (barWidth + 2) + barWidth / 2}
                y={height + 14}
                textAnchor="middle"
                fontSize="8"
                fill="rgba(255,255,255,0.35)"
              >
                {d.label.slice(0, 6)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// -- Drive heatmap (12 drives x sessions) ----------------------------------

// 12 drives x N sessions grid; each cell is colored blue->white->red by pressure value
const DriveHeatmap: React.FC<{ data: DriveEntry[] }> = ({ data }) => {
  if (data.length === 0) return null

  const driveNames = [
    'system_health', 'moral_valence', 'integrity', 'cognitive_awareness',
    'guilt', 'curiosity', 'boredom', 'anxiety', 'satisfaction', 'sadness',
    'information_integrity', 'social',
  ]
  const driveLabels = [
    'Health', 'Moral', 'Integr', 'CogAw', 'Guilt', 'Curio', 'Bored', 'Anxty',
    'Satis', 'Sad', 'InfoInt', 'Social',
  ]

  const cellSize = 28
  const labelWidth = 50
  const headerHeight = 20

  // Maps 0.0-1.0 to a blue->white->red gradient (diverging colormap)
  const heatColor = (v: number): string => {
    if (v == null) return 'rgba(255,255,255,0.06)'
    if (v <= 0.5) {
      const t = v / 0.5
      const r = Math.round(66 + t * 189)
      const g = Math.round(133 + t * 122)
      const b = Math.round(244 - t * 244)
      return `rgb(${r},${g},${b})`
    } else {
      const t = (v - 0.5) / 0.5
      const r = 255
      const g = Math.round(255 - t * 186)
      const b = 0
      return `rgb(${r},${g},${b})`
    }
  }

  return (
    <Box sx={{ overflowX: 'auto' }}>
      <svg
        width={labelWidth + data.length * cellSize}
        height={headerHeight + driveNames.length * cellSize}
      >
        {data.map((_d, ci) => (
          <text key={`h-${ci}`} x={labelWidth + ci * cellSize + cellSize / 2} y={14}
            textAnchor="middle" fontSize="7" fill="rgba(255,255,255,0.4)">
            S{ci + 1}
          </text>
        ))}
        {driveNames.map((drive, ri) => (
          <g key={drive}>
            <text x={labelWidth - 4} y={headerHeight + ri * cellSize + cellSize / 2 + 4}
              textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.6)">
              {driveLabels[ri]}
            </text>
            {data.map((d, ci) => {
              const val = d.drives[drive] ?? 0
              return (
                <g key={`${drive}-${ci}`}>
                  <rect
                    x={labelWidth + ci * cellSize} y={headerHeight + ri * cellSize}
                    width={cellSize - 2} height={cellSize - 2}
                    fill={heatColor(val)} rx={2}
                  />
                  <title>{`${drive}: ${val?.toFixed(3) ?? 'N/A'} (Session ${ci + 1})`}</title>
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </Box>
  )
}

// -- Developmental stage indicator -----------------------------------------

// Developmental stages in progression order per CANON; only one is active at a time
const STAGE_ORDER = ['pre-autonomy', 'emerging', 'developing', 'autonomous']
const STAGE_LABELS: Record<string, string> = {
  'pre-autonomy': 'Pre-Autonomy',
  emerging: 'Emerging',
  developing: 'Developing',
  autonomous: 'Autonomous',
}

const StageIndicator: React.FC<{ stage: DevStage }> = ({ stage }) => {
  const current = stage.overall.stage
  const type1Pct = stage.overall.type1Pct.toFixed(1)

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 0.75 }}>
        {STAGE_ORDER.map((s) => (
          <Chip
            key={s}
            label={STAGE_LABELS[s] ?? s}
            color={s === current ? 'primary' : 'default'}
            variant={s === current ? 'filled' : 'outlined'}
            size="small"
            sx={s !== current ? { borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.4)' } : {}}
          />
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>
        Type 1: {type1Pct}% across {stage.sessions.length} session{stage.sessions.length !== 1 ? 's' : ''}
      </Typography>
    </Box>
  )
}

// -- Experiential Provenance Ratio -----------------------------------------

const ProvenanceDisplay: React.FC<{ data: ExperientialProvenance }> = ({ data }) => {
  const pct = (data.ratio * 100).toFixed(1)
  // Green >= 60%, amber 30-60%, red < 30%
  const ratioColor = data.ratio >= 0.6 ? '#81c784' : data.ratio >= 0.3 ? '#ffb74d' : '#e57373'
  const isHealthy = data.ratio >= 0.5

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
        <Typography sx={{ fontSize: '2rem', fontWeight: 700, color: ratioColor, lineHeight: 1 }}>
          {pct}%
        </Typography>
        {isHealthy && (
          <TrendingUpIcon sx={{ fontSize: 18, color: '#81c784', opacity: 0.8 }} />
        )}
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem', display: 'block' }}>
        of utterances from experiential provenance (SENSOR + GUARDIAN + INFERENCE)
      </Typography>
      {Object.keys(data.byProvenance).length > 0 && (
        <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75, flexWrap: 'wrap' }}>
          {Object.entries(data.byProvenance).map(([prov, count]) => (
            <Typography key={prov} variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.6rem', fontFamily: 'monospace' }}>
              {prov}: {count}
            </Typography>
          ))}
        </Box>
      )}
      {data.totalUtterances === 0 && (
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.65rem', fontStyle: 'italic', display: 'block', mt: 0.5 }}>
          Start a conversation with Sylphie to see data here
        </Typography>
      )}
    </Box>
  )
}

// -- Section wrapper --------------------------------------------------------

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box sx={{
    mb: 2,
    p: 1.5,
    bgcolor: 'rgba(0,0,0,0.15)',
    borderRadius: 1,
    border: '1px solid rgba(255,255,255,0.07)',
  }}>
    <Typography variant="overline" sx={{
      fontSize: '0.65rem', fontWeight: 700, color: 'rgba(255,255,255,0.4)',
      letterSpacing: 1, display: 'block', mb: 1,
    }}>
      {title}
    </Typography>
    {children}
  </Box>
)

const Caption: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography variant="caption" sx={{ mt: 0.75, display: 'block', color: 'rgba(255,255,255,0.3)', fontSize: '0.65rem' }}>
    {children}
  </Typography>
)

const NoData: React.FC<{ message?: string }> = ({ message = 'No data yet' }) => (
  <Typography sx={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.7rem', fontStyle: 'italic' }}>
    {message}
  </Typography>
)

// -- Main Panel ------------------------------------------------------------

export const ObservatoryPanel: React.FC = () => {
  const {
    loading, error, vocabData, driveData, actionData,
    devStage, sessionData, comprehensionData, phraseRatioData,
    experientialProvenance, hasData, fetchAll,
  } = useObservatoryData()

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}>
        <Typography variant="overline" sx={{
          flex: 1, fontSize: '0.65rem', fontWeight: 700,
          color: 'rgba(255,255,255,0.4)', letterSpacing: 1,
        }}>
          Observatory
        </Typography>
        <IconButton onClick={fetchAll} disabled={loading} size="small"
          sx={{ color: 'rgba(255,255,255,0.4)', '&:hover': { color: 'rgba(255,255,255,0.7)' } }}>
          <RefreshIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Scrollable content */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, px: 1.5, pb: 1.5 }}>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} sx={{ color: 'rgba(255,255,255,0.3)' }} />
          </Box>
        )}

        {error && (
          <Typography sx={{ color: 'rgba(244,67,54,0.8)', fontSize: '0.75rem', py: 2 }}>
            Observatory unreachable: {error}
          </Typography>
        )}

        {!loading && !hasData && !error && (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <Typography sx={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.75rem', fontStyle: 'italic', mb: 1 }}>
              No sessions have run yet.
            </Typography>
            <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '0.65rem' }}>
              Start a conversation with Sylphie to see data here.
            </Typography>
          </Box>
        )}

        {!loading && (
          <>
            {/* Experiential Provenance Ratio — always shown, prominent */}
            <Section title="Experiential Provenance Ratio">
              {experientialProvenance !== null ? (
                <ProvenanceDisplay data={experientialProvenance} />
              ) : (
                <NoData message="Start a conversation with Sylphie to see data here" />
              )}
            </Section>

            {/* Developmental Stage */}
            <Section title="Developmental Stage">
              {devStage !== null ? (
                <StageIndicator stage={devStage} />
              ) : (
                <NoData message="No session data yet" />
              )}
            </Section>

            {/* Vocabulary Growth */}
            <Section title="Vocabulary Growth">
              {vocabData.length > 0 ? (
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Box>
                    <Caption>Cumulative Nodes</Caption>
                    <BarChart
                      data={vocabData.map((v: VocabEntry, i: number) => ({ label: `D${i + 1}`, value: v.phrase_nodes }))}
                      color="#4fc3f7"
                    />
                  </Box>
                  <Box>
                    <Caption>Guardian-Provided</Caption>
                    <BarChart
                      data={vocabData.map((v: VocabEntry, i: number) => ({ label: `D${i + 1}`, value: v.can_produce_count }))}
                      color="#81c784"
                    />
                  </Box>
                </Box>
              ) : (
                <NoData message="Start a conversation with Sylphie to see vocabulary growth" />
              )}
            </Section>

            {/* Drive Evolution */}
            <Section title="Drive Evolution (session averages)">
              {driveData.length > 0 ? (
                <>
                  <DriveHeatmap data={driveData} />
                  <Caption>Blue=low · White=mid · Red=high. Each column = one session.</Caption>
                </>
              ) : (
                <NoData message="No drive data yet" />
              )}
            </Section>

            {/* Action Diversity */}
            <Section title="Action Diversity">
              {actionData.length > 0 ? (
                <>
                  <BarChart
                    data={actionData.map((a: ActionEntry, i: number) => ({ label: `S${i + 1}`, value: a.unique_action_types }))}
                    color="#ffb74d"
                  />
                  <Caption>
                    Unique action types per session.
                    {(() => {
                      const last = actionData[actionData.length - 1]
                      return ` Latest: ${last.unique_action_types} types from ${last.total_actions} selections.`
                    })()}
                  </Caption>
                </>
              ) : (
                <NoData message="No action data yet" />
              )}
            </Section>

            {/* Phrase Recognition Ratio */}
            <Section title="Phrase Recognition Ratio">
              {phraseRatioData.length > 0 ? (
                <>
                  <BarChart
                    data={phraseRatioData.map((p: PhraseRatioEntry, i: number) => ({ label: `S${i + 1}`, value: p.ratio }))}
                    maxValue={1.0}
                    color="#ce93d8"
                  />
                  <Caption>Ratio of recognized vs total utterances above confidence threshold.</Caption>
                </>
              ) : (
                <NoData message="No phrase data yet" />
              )}
            </Section>

            {/* Comprehension Accuracy */}
            <Section title="Comprehension Accuracy">
              {comprehensionData.length > 0 ? (
                <>
                  <BarChart
                    data={comprehensionData.map((c: ComprehensionEntry, i: number) => ({ label: `S${i + 1}`, value: c.avg_confidence }))}
                    maxValue={1.0}
                    color="#4dd0e1"
                  />
                  <Caption>
                    Prediction accuracy per session (1 - MAE). Higher = better.
                    {(() => {
                      const last = comprehensionData[comprehensionData.length - 1]
                      return ` ${last.producing_count} prediction samples.`
                    })()}
                  </Caption>
                </>
              ) : (
                <NoData message="No prediction evaluation data yet" />
              )}
            </Section>

            {/* Session Comparison */}
            <Section title="Session Comparison">
              {sessionData.length > 0 ? (
                <TableContainer sx={{ maxHeight: 220 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {['Session', 'Duration', 'Cycles', 'Avg Press.', 'Phrases', 'Speech'].map((h) => (
                          <TableCell key={h} sx={{
                            fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)',
                            bgcolor: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.08)',
                            py: 0.5,
                          }}>
                            {h}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sessionData.map((s: SessionEntry, i: number) => (
                        <TableRow key={s.session_id || i} sx={{ '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' } }}>
                          <TableCell sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.6)', borderColor: 'rgba(255,255,255,0.06)', fontFamily: 'monospace', py: 0.25 }}>
                            <Tooltip title={s.session_id || ''}>
                              <span>{(s.session_id || '').slice(0, 8)}</span>
                            </Tooltip>
                          </TableCell>
                          {([
                            s.duration_seconds !== undefined ? `${Math.round(s.duration_seconds / 60)}m` : '-',
                            s.total_cycles ?? '-',
                            s.avg_pressure !== undefined ? s.avg_pressure.toFixed(2) : '-',
                            s.phrases_created ?? 0,
                            s.total_speech_acts ?? 0,
                          ] as (string | number)[]).map((val, j) => (
                            <TableCell key={j} align="right" sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.06)', fontFamily: 'monospace', py: 0.25 }}>
                              {val}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : (
                <NoData message="No completed sessions yet" />
              )}
            </Section>
          </>
        )}
      </Box>
    </Box>
  )
}
