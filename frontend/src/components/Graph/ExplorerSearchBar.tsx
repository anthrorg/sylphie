import React, { useState } from 'react'
import { Autocomplete, Box, Chip, CircularProgress, TextField, Typography } from '@mui/material'
import { Search as SearchIcon } from '@mui/icons-material'
import { useNodeSearch } from '../../hooks/useNodeSearch'
import { useAppStore } from '../../store'
import type { SearchNodeResult } from '../../types'
import { NODE_TYPE_COLORS, DEFAULT_NODE_COLOR } from './graphStyles'

interface ExplorerSearchBarProps {
  onNodeSelect: (nodeId: string, label: string) => void
}

export const ExplorerSearchBar: React.FC<ExplorerSearchBarProps> = ({ onNodeSelect }) => {
  const [inputValue, setInputValue] = useState('')
  const { results, loading } = useNodeSearch(inputValue)
  const { explorerDepth, setExplorerDepth } = useAppStore()

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {/* Search input */}
      <Autocomplete<SearchNodeResult, false, false, true>
        freeSolo
        size="small"
        options={results}
        loading={loading}
        inputValue={inputValue}
        onInputChange={(_e, value) => setInputValue(value)}
        onChange={(_e, value) => {
          if (value && typeof value !== 'string') {
            onNodeSelect(value.node_id, value.label)
            setInputValue('')
          }
        }}
        getOptionLabel={(option) => (typeof option === 'string' ? option : option.label)}
        renderOption={(props, option) => (
          <Box
            component="li"
            {...props}
            key={option.node_id}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.5 }}
          >
            <Chip
              label={option.node_type}
              size="small"
              sx={{
                fontSize: '0.55rem',
                height: 16,
                bgcolor: NODE_TYPE_COLORS[option.node_type] ?? DEFAULT_NODE_COLOR,
                color: '#fff',
                fontWeight: 600,
                '& .MuiChip-label': { px: 0.5 },
              }}
            />
            <Box
              component="span"
              sx={{
                flex: 1,
                fontSize: '0.75rem',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {option.label}
            </Box>
          </Box>
        )}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder="Search nodes..."
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <SearchIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.3)', mr: 0.5 }} />
              ),
              endAdornment: (
                <>
                  {loading && (
                    <CircularProgress size={12} sx={{ color: 'rgba(255,255,255,0.4)' }} />
                  )}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: 'rgba(0,0,0,0.3)',
                fontSize: '0.75rem',
                '& fieldset': { borderColor: 'rgba(255,255,255,0.1)' },
                '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.2)' },
                '&.Mui-focused fieldset': { borderColor: 'rgba(100,181,246,0.5)' },
              },
              '& .MuiInputBase-input': { color: '#E0E0E0', py: '6px' },
            }}
          />
        )}
        sx={{ width: '100%' }}
      />

      {/* Hop depth selector */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography
          sx={{
            fontSize: '0.55rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'rgba(255,255,255,0.25)',
            flexShrink: 0,
          }}
        >
          Depth
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          {[1, 2, 3].map((d) => (
            <Box
              key={d}
              onClick={() => setExplorerDepth(d)}
              sx={{
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 0.5,
                cursor: 'pointer',
                fontSize: '0.65rem',
                fontWeight: 600,
                fontFamily: 'monospace',
                bgcolor:
                  explorerDepth === d ? 'rgba(100,181,246,0.25)' : 'rgba(0,0,0,0.3)',
                color: explorerDepth === d ? '#64B5F6' : 'rgba(255,255,255,0.4)',
                border: `1px solid ${explorerDepth === d ? 'rgba(100,181,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                '&:hover': { bgcolor: 'rgba(100,181,246,0.15)' },
              }}
            >
              {d}h
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
