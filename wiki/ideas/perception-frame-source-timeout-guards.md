# Idea: Add timeout guards to perception frame source blocking I/O

**Created:** 2026-04-10
**Status:** proposed

## Summary

Wrap the `run_in_executor()` calls in `frame_sources.py` with `asyncio.wait_for()` timeouts so that a hung camera read or file read cannot stall the capture loop indefinitely.

## Motivation

The perception pipeline's frame capture loop delegates blocking OpenCV `camera.read()` calls to a thread executor via `asyncio.get_event_loop().run_in_executor()`. If the underlying device hangs (USB disconnect, driver freeze, corrupted stream), the executor future never resolves and the entire capture task blocks forever. There is no timeout, no retry, and no circuit-breaker around this call path. In a long-running deployment this is a silent availability failure — the pipeline stops producing frames but never raises an error or emits a health signal.

Adding a `wait_for(..., timeout=N)` wrapper with a configurable timeout (defaulting to ~5 seconds) would let the pipeline detect a hung source, log a capture error, and either retry or transition to a degraded state. This pairs naturally with the existing `CaptureError` exception and the circuit-breaker infrastructure already in `shared/`.

## Subsystems Affected

- `packages/perception-service/layer2_perception/frame_sources.py` — primary change site
- `packages/perception-service/layer2_perception/pipeline.py` — capture loop error handling may need to catch `asyncio.TimeoutError`
- `packages/perception-service/layer2_perception/config.py` — add `capture_timeout_seconds` to `CameraConfig`

## Open Questions

- What is a safe default timeout for `camera.read()` on typical USB webcams vs RTSP streams? (5s may be too aggressive for network cameras)
- Should a timeout trigger an automatic reconnect attempt, or just surface the error and let the pipeline's existing retry logic handle it?
- Should the deprecated `asyncio.get_event_loop()` call be updated to `asyncio.get_running_loop()` in the same change?
