import React, { useState, useRef, useCallback, useEffect } from 'react'
import {
  Box,
  InputBase,
  Paper,
  Typography,
  CircularProgress,
  Chip,
  ClickAwayListener,
} from '@mui/material'
import { Search as SearchIcon } from '@mui/icons-material'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  name: string
  type: 'Function' | 'Type' | string
  filePath: string
  lineNumber: number | null
  returnType: string | null
  isExported: boolean
  isAsync: boolean
  matchLines: string[]
}

interface SearchBarProps {
  onSelect: (result: SearchResult) => void
  onHighlightResults: (names: string[]) => void
}

// ---------------------------------------------------------------------------
// SearchBar
// ---------------------------------------------------------------------------

export const SearchBar: React.FC<SearchBarProps> = ({ onSelect, onHighlightResults }) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const search = useCallback(async (pattern: string) => {
    if (pattern.length < 2) {
      setResults([])
      setOpen(false)
      onHighlightResults([])
      return
    }

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)

    try {
      const res = await fetch(
        `/api/graph/pkg/search?pattern=${encodeURIComponent(pattern)}&limit=15`,
        { signal: ac.signal },
      )
      if (!res.ok) { setResults([]); return }
      const data: SearchResult[] = await res.json()
      setResults(data)
      setOpen(data.length > 0)
      onHighlightResults(data.map((r) => r.name))
    } catch {
      // abort or network error
    } finally {
      setLoading(false)
    }
  }, [onHighlightResults])

  const handleChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => search(value), 300)
  }

  const handleSelect = (result: SearchResult) => {
    setOpen(false)
    onSelect(result)
  }

  const handleClear = () => {
    setQuery('')
    setResults([])
    setOpen(false)
    onHighlightResults([])
  }

  // Cleanup
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ position: 'relative', zIndex: 20 }}>
        {/* Input */}
        <Paper
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.5,
            bgcolor: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(184,217,198,0.12)',
            borderRadius: 1.5,
            '&:focus-within': {
              borderColor: 'rgba(69,183,209,0.4)',
              bgcolor: 'rgba(255,255,255,0.06)',
            },
          }}
          elevation={0}
        >
          <SearchIcon sx={{ fontSize: '1rem', color: 'rgba(255,255,255,0.3)' }} />
          <InputBase
            placeholder="Search functions, types, code..."
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            sx={{
              flex: 1,
              fontSize: '0.8rem',
              color: 'rgba(255,255,255,0.8)',
              '& input::placeholder': { color: 'rgba(255,255,255,0.3)', opacity: 1 },
            }}
          />
          {loading && <CircularProgress size={14} sx={{ color: 'rgba(69,183,209,0.5)' }} />}
          {query && !loading && (
            <Typography
              onClick={handleClear}
              sx={{
                fontSize: '0.65rem',
                color: 'rgba(255,255,255,0.3)',
                cursor: 'pointer',
                '&:hover': { color: 'rgba(255,255,255,0.6)' },
              }}
            >
              ESC
            </Typography>
          )}
        </Paper>

        {/* Results dropdown */}
        {open && results.length > 0 && (
          <Paper
            sx={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              mt: 0.5,
              maxHeight: 400,
              overflow: 'auto',
              bgcolor: '#0d1117',
              border: '1px solid rgba(184,217,198,0.15)',
              borderRadius: 1.5,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
            elevation={0}
          >
            {results.map((r, i) => (
              <Box
                key={`${r.name}-${r.filePath}-${i}`}
                onClick={() => handleSelect(r)}
                sx={{
                  px: 1.5,
                  py: 1,
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  '&:hover': { bgcolor: 'rgba(69,183,209,0.08)' },
                  '&:last-child': { borderBottom: 'none' },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                  <Chip
                    label={r.type}
                    size="small"
                    sx={{
                      height: 16,
                      fontSize: '0.55rem',
                      fontFamily: 'monospace',
                      bgcolor: r.type === 'Function' ? 'rgba(69,183,209,0.15)' : 'rgba(206,147,216,0.15)',
                      color: r.type === 'Function' ? '#45B7D1' : '#CE93D8',
                      '& .MuiChip-label': { px: 0.5 },
                    }}
                  />
                  <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace' }}>
                    {r.name}
                  </Typography>
                  {r.isExported && (
                    <Typography sx={{ fontSize: '0.55rem', color: 'rgba(102,187,106,0.6)' }}>export</Typography>
                  )}
                  {r.isAsync && (
                    <Typography sx={{ fontSize: '0.55rem', color: 'rgba(255,183,77,0.6)' }}>async</Typography>
                  )}
                </Box>
                <Typography sx={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>
                  {r.filePath}{r.lineNumber ? `:${r.lineNumber}` : ''}
                </Typography>
                {r.matchLines.length > 0 && (
                  <Box sx={{ mt: 0.5 }}>
                    {r.matchLines.slice(0, 2).map((line, j) => (
                      <Typography
                        key={j}
                        sx={{
                          fontSize: '0.6rem',
                          fontFamily: 'monospace',
                          color: 'rgba(255,255,255,0.35)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {line}
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            ))}
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  )
}
