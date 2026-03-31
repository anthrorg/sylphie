# 2026-03-30 -- Drive visualization updated to full [-10, 1] CANON range

## Changes
- MODIFIED: frontend/src/components/Drives/DriveRadarChart.tsx -- axis range [-10, 1]; amber zero ring; loading placeholder; stale badge + dim at 55%
- MODIFIED: frontend/src/components/Drives/DriveBarChart.tsx -- bar axes [-10, 1]; amber zero gridline; teal color for negative values; loading placeholder per chart; stale badge + dim
- MODIFIED: frontend/src/components/Drives/DrivesPanel.tsx -- getDriveColor extended for negatives (teal); DriveRow replaced LinearProgress with bidirectional CSS bar (zero at 90.9%); DriveControlRow slider min changed from 0 to -10; removed unused LinearProgress import

## Wiring Changes
- DriveRadarChart and both DriveBarChart components now read pressureSequenceNumber, pressureTimestampMs, pressureIsStale from store for loading/staleness state
- No new store fields; all three fields already existed in store/index.ts

## Known Issues
- None

## Gotchas for Next Session
- Zero line in radar is at ~90.9% of radius from center (10/11 of range), not at center; this is correct per CANON [-10, 1] range
- DrivesPanel bidirectional bar uses CSS absolute positioning; if the container width is very narrow the zero marker may overlap the fill
