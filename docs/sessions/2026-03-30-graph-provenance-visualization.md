# 2026-03-30 -- Graph visualization with provenance and confidence

## Changes
- MODIFIED: frontend/src/types/index.ts -- Added LLM_GENERATED and SYSTEM_BOOTSTRAP to ProvenanceFilter type (was missing 2 of 5 CANON provenance types)
- MODIFIED: frontend/src/components/Graph/GraphPanel.tsx -- Added PROVENANCE_COLORS map (exported), GraphFilterBar component with provenance+schema-level chip filters, Cytoscape provenance border-color selectors for all 5 types, confidence suffix in node labels, confidence-based opacity dimming (nodes below 0.50 threshold), fixed provenance filter bug (was incorrectly lowercasing uppercase provenance values)
- MODIFIED: frontend/src/components/Graph/NodeInspector.tsx -- Added provenance color badge chip, confidence threshold indicator (warning icon + color when below 0.50), Schema Level row in Provenance & Meta table, provenance color dot in meta table

## Wiring Changes
- GraphPanel exports PROVENANCE_COLORS so NodeInspector can import the same color constants
- GraphFilterBar reads/writes graphFilters via useAppStore (schemaLevel and provenance fields already existed)
- No new store fields needed; schemaLevel was already in GraphFilters

## Known Issues
- None at time of writing

## Gotchas for Next Session
- Provenance filter comparison must be uppercase-to-uppercase; the old code was lowercasing the filter value which broke it entirely
- Cytoscape provenance selectors use border-color overlay (not background-color) so both node type and provenance are readable simultaneously; provenance selectors are placed after node-type selectors so border wins on conflict
