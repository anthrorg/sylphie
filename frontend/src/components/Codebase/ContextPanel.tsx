import React, { useEffect, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Tab,
  Tabs,
  Typography,
} from '@mui/material'
import {
  Close as CloseIcon,
  CallMade as CallMadeIcon,
  CallReceived as CallReceivedIcon,
} from '@mui/icons-material'
import type { GraphNode } from '../../types'

// ---------------------------------------------------------------------------
// Types (matching backend DTOs)
// ---------------------------------------------------------------------------

interface FunctionDetail {
  name: string
  filePath: string
  lineNumber: number | null
  args: string | null
  returnType: string | null
  comment: string | null
  body: string | null
  isAsync: boolean
  isExported: boolean
  relatedTypes: Array<{ name: string; filePath: string; kind: string }>
  callers: Array<{ name: string; filePath: string }>
  callees: Array<{ name: string; filePath: string }>
  recentChanges: Array<{ hash: string; message: string; date: string; author: string }>
}

interface DataFlowResult {
  startNode: { name: string; filePath: string; type: string }
  upstream: Array<{ name: string; filePath: string; type: string; hopDistance: number }>
  downstream: Array<{ name: string; filePath: string; type: string; hopDistance: number }>
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ContextPanelProps {
  node: GraphNode | null
  open: boolean
  onClose: () => void
  childCount?: number
  onNavigateToNode: (name: string) => void
  onHighlightDataFlow: (names: string[]) => void
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography
    sx={{
      fontSize: '0.6rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)',
      textTransform: 'uppercase', letterSpacing: 1, mb: 0.5, mt: 1.5,
    }}
  >
    {children}
  </Typography>
)

const CodeLink: React.FC<{
  name: string
  filePath?: string
  type?: string
  onClick: () => void
}> = ({ name, filePath, type, onClick }) => (
  <Box
    onClick={onClick}
    sx={{
      display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25, px: 0.5,
      cursor: 'pointer', borderRadius: 0.5,
      '&:hover': { bgcolor: 'rgba(69,183,209,0.08)' },
    }}
  >
    {type && (
      <Chip
        label={type}
        size="small"
        sx={{
          height: 14, fontSize: '0.5rem', fontFamily: 'monospace',
          bgcolor: type === 'Function' ? 'rgba(69,183,209,0.12)' : 'rgba(206,147,216,0.12)',
          color: type === 'Function' ? '#45B7D1' : '#CE93D8',
          '& .MuiChip-label': { px: 0.4 },
        }}
      />
    )}
    <Typography sx={{ fontSize: '0.72rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.75)' }}>
      {name}
    </Typography>
    {filePath && (
      <Typography sx={{ fontSize: '0.55rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.2)', ml: 'auto' }}>
        {filePath.split('/').pop()}
      </Typography>
    )}
  </Box>
)

// ---------------------------------------------------------------------------
// ContextPanel
// ---------------------------------------------------------------------------

export const ContextPanel: React.FC<ContextPanelProps> = ({
  node,
  open,
  onClose,
  childCount,
  onNavigateToNode,
  onHighlightDataFlow,
}) => {
  const [tab, setTab] = useState(0)
  const [detail, setDetail] = useState<FunctionDetail | null>(null)
  const [dataFlow, setDataFlow] = useState<DataFlowResult | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch function detail when a Function node is selected
  useEffect(() => {
    if (!node || !open) return
    setDetail(null)
    setDataFlow(null)
    setTab(0)

    if (node.node_type !== 'Function' && node.node_type !== 'Type') return

    const name = (node.properties?.name as string) || node.label || ''
    if (!name) return

    setLoading(true)
    const ac = new AbortController()

    // Fetch function detail + data flow in parallel
    Promise.all([
      fetch(`/api/graph/pkg/function/${encodeURIComponent(name)}`, { signal: ac.signal })
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null),
      fetch(`/api/graph/pkg/dataflow/${encodeURIComponent(name)}?direction=both&depth=2`, { signal: ac.signal })
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null),
    ]).then(([d, f]) => {
      setDetail(d)
      setDataFlow(f)
      setLoading(false)
    })

    return () => ac.abort()
  }, [node, open])

  // Notify parent about data flow nodes for highlighting
  useEffect(() => {
    if (!dataFlow) { onHighlightDataFlow([]); return }
    const names = [
      dataFlow.startNode.name,
      ...dataFlow.upstream.map((n) => n.name),
      ...dataFlow.downstream.map((n) => n.name),
    ]
    onHighlightDataFlow(names)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataFlow])

  if (!node || !open) return null

  const nodeProps = node.properties ?? {}
  const isCodeEntity = node.node_type === 'Function' || node.node_type === 'Type'
  const nodeColor =
    node.node_type === 'Service' ? '#FF6B6B' :
    node.node_type === 'Module' ? '#4ECDC4' :
    node.node_type === 'Function' ? '#45B7D1' :
    node.node_type === 'Type' ? '#CE93D8' :
    node.node_type === 'Change' ? '#FFB74D' :
    '#666'

  return (
    <Box
      sx={{
        width: 380,
        minWidth: 380,
        height: '100%',
        bgcolor: '#0a0e17',
        borderLeft: '1px solid rgba(184,217,198,0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box sx={{ px: 2, pt: 1.5, pb: 1, flexShrink: 0 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: nodeColor }} />
            <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1 }}>
              {node.node_type}
            </Typography>
            {childCount != null && (
              <Typography sx={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>
                ({childCount})
              </Typography>
            )}
          </Box>
          <IconButton size="small" onClick={onClose} sx={{ color: 'rgba(255,255,255,0.3)', p: 0.25 }}>
            <CloseIcon sx={{ fontSize: '0.9rem' }} />
          </IconButton>
        </Box>
        <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: 'rgba(255,255,255,0.9)', wordBreak: 'break-word' }}>
          {node.label || node.node_id}
        </Typography>
        {typeof nodeProps.filePath === 'string' && (
          <Typography sx={{ fontSize: '0.6rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)', mt: 0.25 }}>
            {nodeProps.filePath}{nodeProps.lineNumber ? `:${String(nodeProps.lineNumber)}` : ''}
          </Typography>
        )}
      </Box>

      {/* Tabs (for code entities) */}
      {isCodeEntity && (
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{
            minHeight: 32, flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            '& .MuiTab-root': {
              minHeight: 32, py: 0, px: 1.5,
              fontSize: '0.65rem', textTransform: 'none',
              color: 'rgba(255,255,255,0.35)',
              '&.Mui-selected': { color: '#45B7D1' },
            },
            '& .MuiTabs-indicator': { bgcolor: '#45B7D1', height: 2 },
          }}
        >
          <Tab label="Overview" />
          <Tab label="Source" />
          <Tab label="Dependencies" />
          <Tab label="Changes" />
        </Tabs>
      )}

      {/* Loading */}
      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={20} sx={{ color: 'rgba(69,183,209,0.4)' }} />
        </Box>
      )}

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
        {/* ── Tab 0: Overview ─────────────────────────────────── */}
        {(tab === 0 || !isCodeEntity) && !loading && (
          <Box>
            {/* Signature badges */}
            {isCodeEntity && detail && (
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 1 }}>
                {detail.isExported && <Chip label="export" size="small" sx={{ height: 18, fontSize: '0.55rem', bgcolor: 'rgba(102,187,106,0.12)', color: '#66BB6A' }} />}
                {detail.isAsync && <Chip label="async" size="small" sx={{ height: 18, fontSize: '0.55rem', bgcolor: 'rgba(255,183,77,0.12)', color: '#FFB74D' }} />}
                {detail.returnType && <Chip label={`→ ${detail.returnType}`} size="small" sx={{ height: 18, fontSize: '0.55rem', fontFamily: 'monospace', bgcolor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }} />}
              </Box>
            )}

            {/* JSDoc comment */}
            {detail?.comment && (
              <>
                <SectionLabel>Documentation</SectionLabel>
                <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)', fontStyle: 'italic', lineHeight: 1.5 }}>
                  {detail.comment}
                </Typography>
              </>
            )}

            {/* Quick stats */}
            {detail && (
              <>
                <SectionLabel>Connections</SectionLabel>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)' }}>
                    <CallReceivedIcon sx={{ fontSize: '0.7rem', verticalAlign: 'middle', mr: 0.25 }} />
                    {detail.callers.length} callers
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)' }}>
                    <CallMadeIcon sx={{ fontSize: '0.7rem', verticalAlign: 'middle', mr: 0.25 }} />
                    {detail.callees.length} callees
                  </Typography>
                  <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)' }}>
                    {detail.relatedTypes.length} types
                  </Typography>
                </Box>
              </>
            )}

            {/* Properties (non-code entities, or as fallback) */}
            {!isCodeEntity && (
              <Box sx={{ mt: 1 }}>
                {Object.entries(nodeProps)
                  .filter(([k]) => !['bodyText', 'contentHash'].includes(k))
                  .map(([key, raw]) => (
                    <Box key={key} sx={{ mb: 0.5 }}>
                      <Typography sx={{ fontSize: '0.55rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)' }}>{key}</Typography>
                      <Typography sx={{ fontSize: '0.68rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.6)', wordBreak: 'break-all' }}>
                        {typeof raw === 'string' ? raw : JSON.stringify(raw)}
                      </Typography>
                    </Box>
                  ))}
              </Box>
            )}
          </Box>
        )}

        {/* ── Tab 1: Source ────────────────────────────────────── */}
        {tab === 1 && !loading && (
          <Box sx={{ mt: 1 }}>
            {detail?.body ? (
              <Box
                sx={{
                  p: 1.5, borderRadius: 1,
                  bgcolor: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  maxHeight: 'calc(100vh - 250px)',
                  overflow: 'auto',
                }}
              >
                <Typography
                  component="pre"
                  sx={{
                    fontSize: '0.65rem', fontFamily: 'monospace',
                    color: 'rgba(255,255,255,0.7)', whiteSpace: 'pre-wrap', m: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {detail.body}
                </Typography>
              </Box>
            ) : (
              <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)', fontStyle: 'italic', mt: 2 }}>
                Source code not available. The backend may need to be restarted.
              </Typography>
            )}
          </Box>
        )}

        {/* ── Tab 2: Dependencies ──────────────────────────────── */}
        {tab === 2 && !loading && (
          <Box sx={{ mt: 1 }}>
            {/* Callers */}
            {detail && detail.callers.length > 0 && (
              <>
                <SectionLabel>Callers ({detail.callers.length})</SectionLabel>
                {detail.callers.map((c, i) => (
                  <CodeLink key={i} name={c.name} filePath={c.filePath} type="Function" onClick={() => onNavigateToNode(c.name)} />
                ))}
              </>
            )}

            {/* Callees */}
            {detail && detail.callees.length > 0 && (
              <>
                <SectionLabel>Calls ({detail.callees.length})</SectionLabel>
                {detail.callees.map((c, i) => (
                  <CodeLink key={i} name={c.name} filePath={c.filePath} type="Function" onClick={() => onNavigateToNode(c.name)} />
                ))}
              </>
            )}

            {/* Related types */}
            {detail && detail.relatedTypes.length > 0 && (
              <>
                <SectionLabel>Uses Types ({detail.relatedTypes.length})</SectionLabel>
                {detail.relatedTypes.map((t, i) => (
                  <CodeLink key={i} name={t.name} filePath={t.filePath} type={t.kind || 'Type'} onClick={() => onNavigateToNode(t.name)} />
                ))}
              </>
            )}

            {/* Data flow summary */}
            {dataFlow && (
              <>
                <Divider sx={{ my: 1.5, borderColor: 'rgba(255,255,255,0.06)' }} />
                <SectionLabel>Data Flow (2 hops)</SectionLabel>
                {dataFlow.upstream.length > 0 && (
                  <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', mb: 0.5 }}>
                    <CallReceivedIcon sx={{ fontSize: '0.7rem', verticalAlign: 'middle', mr: 0.25, color: '#66BB6A' }} />
                    {dataFlow.upstream.length} upstream nodes
                  </Typography>
                )}
                {dataFlow.downstream.length > 0 && (
                  <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>
                    <CallMadeIcon sx={{ fontSize: '0.7rem', verticalAlign: 'middle', mr: 0.25, color: '#FF6B6B' }} />
                    {dataFlow.downstream.length} downstream nodes
                  </Typography>
                )}
              </>
            )}

            {detail && detail.callers.length === 0 && detail.callees.length === 0 && detail.relatedTypes.length === 0 && (
              <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)', fontStyle: 'italic', mt: 2 }}>
                No dependencies found.
              </Typography>
            )}
          </Box>
        )}

        {/* ── Tab 3: Changes ──────────────────────────────────── */}
        {tab === 3 && !loading && (
          <Box sx={{ mt: 1 }}>
            {detail && detail.recentChanges.length > 0 ? (
              detail.recentChanges.map((c, i) => (
                <Box key={i} sx={{ mb: 1, py: 0.5, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Chip
                      label={c.hash}
                      size="small"
                      sx={{
                        height: 16, fontSize: '0.55rem', fontFamily: 'monospace',
                        bgcolor: 'rgba(255,183,77,0.12)', color: '#FFB74D',
                        '& .MuiChip-label': { px: 0.5 },
                      }}
                    />
                    {c.author && (
                      <Typography sx={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.3)' }}>
                        {c.author}
                      </Typography>
                    )}
                    {c.date && (
                      <Typography sx={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.2)', ml: 'auto' }}>
                        {c.date.slice(0, 10)}
                      </Typography>
                    )}
                  </Box>
                  <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.6)', mt: 0.25, lineHeight: 1.4 }}>
                    {c.message}
                  </Typography>
                </Box>
              ))
            ) : (
              <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)', fontStyle: 'italic', mt: 2 }}>
                No change history found.
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}
