import React, { useMemo } from 'react'
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Divider,
  Card,
  CardContent,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableRow,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
} from '@mui/material'
import {
  Close as CloseIcon,
  ArrowForward as ArrowForwardIcon,
  ArrowBack as ArrowBackIcon,
  Warning as WarningIcon,
} from '@mui/icons-material'
import { useAppStore } from '../../store'
import { PROVENANCE_COLORS } from './GraphPanel'

// Retrieval threshold from CANON: confidence must exceed 0.50 to be usable
const RETRIEVAL_THRESHOLD = 0.5

export const NodeInspector: React.FC = () => {
  const { nodeInspectorOpen, selectedNodeId, graphData, setNodeInspector } = useAppStore()

  const selectedNode = selectedNodeId
    ? graphData.nodes.find((node) => node.node_id === selectedNodeId)
    : null

  // Memoize to avoid re-filtering edges on every render (graph can have thousands of edges)
  const connectedEdges = useMemo(() => {
    if (!selectedNodeId) return []
    return graphData.edges.filter(
      (edge) => edge.source_node_id === selectedNodeId || edge.target_node_id === selectedNodeId,
    )
  }, [selectedNodeId, graphData.edges])

  const getNodeLabel = (nodeId: string): string => {
    const node = graphData.nodes.find((n) => n.node_id === nodeId)
    if (!node) return nodeId
    return node.label || (node.properties.name as string) || (node.properties.value_repr as string) || node.node_id
  }

  const handleClose = () => {
    setNodeInspector(false)
  }

  // Clicking a connected edge navigates the inspector to the other end of that edge
  const handleNavigateToNode = (nodeId: string) => {
    setNodeInspector(true, nodeId)
  }

  if (!selectedNode) {
    return null
  }

  // Maps KG 3-level schema hierarchy to MUI chip color variants
  const getSchemaLevelColor = (level: string): 'primary' | 'success' | 'warning' | 'default' => {
    switch (level?.toLowerCase()) {
      case 'instance':
        return 'primary'
      case 'schema':
        return 'success'
      case 'meta_schema':
        return 'warning'
      default:
        return 'default'
    }
  }

  return (
    <Drawer
      anchor="right"
      open={nodeInspectorOpen}
      onClose={handleClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: 600,
          maxWidth: '100vw',
        },
      }}
    >
      <Box sx={{ p: 2 }}>
        {/* Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">Node Details</Typography>
          <IconButton onClick={handleClose}>
            <CloseIcon />
          </IconButton>
        </Box>

        <Divider sx={{ mb: 2 }} />

        {/* Node info */}
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1" gutterBottom>
            {selectedNode.label ||
              (selectedNode.properties.name as string) ||
              (selectedNode.properties.value_repr as string) ||
              selectedNode.node_id}
          </Typography>

          <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip label={selectedNode.node_type} size="small" variant="outlined" />
            <Chip
              label={selectedNode.schema_level}
              size="small"
              color={getSchemaLevelColor(selectedNode.schema_level)}
            />
            {/* Provenance badge with color dot */}
            {selectedNode.provenance_type && (
              <Chip
                size="small"
                label={selectedNode.provenance_type}
                sx={{
                  bgcolor: `${PROVENANCE_COLORS[selectedNode.provenance_type] ?? '#607D8B'}22`,
                  color: PROVENANCE_COLORS[selectedNode.provenance_type] ?? '#aaa',
                  border: `1px solid ${PROVENANCE_COLORS[selectedNode.provenance_type] ?? '#607D8B'}`,
                  fontWeight: 600,
                }}
              />
            )}
            {/* Confidence with threshold indicator */}
            {selectedNode.confidence != null && (
              <Tooltip
                title={
                  selectedNode.confidence < RETRIEVAL_THRESHOLD
                    ? `Below retrieval threshold (${RETRIEVAL_THRESHOLD}). This node will not be retrieved for use.`
                    : `Above retrieval threshold (${RETRIEVAL_THRESHOLD}). Usable.`
                }
                arrow
              >
                <Chip
                  size="small"
                  label={`${(selectedNode.confidence * 100).toFixed(1)}%`}
                  color={selectedNode.confidence < RETRIEVAL_THRESHOLD ? 'warning' : 'info'}
                  icon={
                    selectedNode.confidence < RETRIEVAL_THRESHOLD ? (
                      <WarningIcon style={{ fontSize: 14 }} />
                    ) : undefined
                  }
                />
              </Tooltip>
            )}
          </Box>

          <Typography variant="body2" color="text.secondary" gutterBottom>
            ID: {selectedNode.node_id}
          </Typography>
        </Box>

        {/* Properties */}
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Properties
            </Typography>
            <Table size="small">
              <TableBody>
                {Object.entries(selectedNode.properties).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell
                      component="th"
                      scope="row"
                      sx={{ fontWeight: 'bold', border: 'none' }}
                    >
                      {key}
                    </TableCell>
                    <TableCell sx={{ border: 'none' }}>
                      {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Connected Edges */}
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Connected Edges ({connectedEdges.length})
            </Typography>
            {connectedEdges.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No connected edges
              </Typography>
            ) : (
              <List dense disablePadding>
                {connectedEdges.map((edge) => {
                  const isSource = edge.source_node_id === selectedNodeId
                  const otherNodeId = isSource ? edge.target_node_id : edge.source_node_id
                  const otherLabel = getNodeLabel(otherNodeId)

                  return (
                    <ListItemButton
                      key={edge.edge_id}
                      onClick={() => handleNavigateToNode(otherNodeId)}
                      sx={{ px: 1, py: 0.5, borderRadius: 1 }}
                    >
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Chip
                              label={edge.edge_type}
                              size="small"
                              variant="outlined"
                              sx={{ fontSize: '0.7rem' }}
                            />
                            {/* Arrow shows direction: forward = this node is source, back = this node is target */}
                            {isSource ? (
                              <ArrowForwardIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                            ) : (
                              <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                            )}
                            <Typography variant="body2" noWrap>
                              {otherLabel}
                            </Typography>
                          </Box>
                        }
                      />
                    </ListItemButton>
                  )
                })}
              </List>
            )}
          </CardContent>
        </Card>

        {/* Provenance & Meta */}
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Provenance & Meta
            </Typography>
            <Table size="small">
              <TableBody>
                <TableRow>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 'bold', border: 'none' }}>
                    Provenance
                  </TableCell>
                  <TableCell sx={{ border: 'none' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {/* Color dot matching the Cytoscape border color */}
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          flexShrink: 0,
                          bgcolor:
                            PROVENANCE_COLORS[selectedNode.provenance_type] ?? '#607D8B',
                        }}
                      />
                      <Typography variant="body2">
                        {selectedNode.provenance_type || 'unknown'}
                      </Typography>
                    </Box>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 'bold', border: 'none' }}>
                    Confidence
                  </TableCell>
                  <TableCell sx={{ border: 'none' }}>
                    {selectedNode.confidence != null ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography
                          variant="body2"
                          sx={{
                            color:
                              selectedNode.confidence < RETRIEVAL_THRESHOLD
                                ? 'warning.main'
                                : 'text.primary',
                          }}
                        >
                          {(selectedNode.confidence * 100).toFixed(1)}%
                        </Typography>
                        {selectedNode.confidence < RETRIEVAL_THRESHOLD && (
                          <Tooltip title={`Below retrieval threshold of ${RETRIEVAL_THRESHOLD * 100}%`} arrow>
                            <WarningIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                          </Tooltip>
                        )}
                      </Box>
                    ) : (
                      'N/A'
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 'bold', border: 'none' }}>
                    Schema Level
                  </TableCell>
                  <TableCell sx={{ border: 'none' }}>
                    {selectedNode.schema_level || 'unknown'}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 'bold', border: 'none' }}>
                    Created
                  </TableCell>
                  <TableCell sx={{ border: 'none' }}>
                    {selectedNode.created_at
                      ? new Date(selectedNode.created_at).toLocaleString()
                      : 'N/A'}
                  </TableCell>
                </TableRow>
                {selectedNode.updated_at && (
                  <TableRow>
                    <TableCell
                      component="th"
                      scope="row"
                      sx={{ fontWeight: 'bold', border: 'none' }}
                    >
                      Updated
                    </TableCell>
                    <TableCell sx={{ border: 'none' }}>
                      {new Date(selectedNode.updated_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Box>
    </Drawer>
  )
}
