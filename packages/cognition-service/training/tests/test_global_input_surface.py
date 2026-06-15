"""Round-trip test for the surfaced global input vector (cluster 3b loop close).

The supervisor reinforcement/correction loop requires the EXACT 1561-dim
assembled global input vector for a cycle. The sidecar splits it back into
components via main._split_input_vector(); the cycle surfaces it via
CognitionCycleResponse.global_input_vector. This test proves those two are
inverse operations and byte-identical, so a vector that round-trips from
cognition-service -> supervisor -> sidecar reconstructs the original request.
"""

from __future__ import annotations

import config
from inference.cycle import CognitiveCycle
from main import _split_input_vector
from schemas import CognitionCycleRequest

_EMB = config.EMBEDDING_DIM
_DV = config.DRIVE_VECTOR_DIM


def _request() -> CognitionCycleRequest:
    # Distinct, non-zero values per component so a mis-ordered slice would fail.
    return CognitionCycleRequest(
        fused_embedding=[0.11] * _EMB,
        drive_vector=[0.22] * _DV,
        drive_deltas=[0.33] * _DV,
        total_pressure=0.44,
        episodic_context=[0.55] * _EMB,
    )


def test_assemble_global_input_has_canonical_dim() -> None:
    req = _request()
    # _assemble_global_input reads only `req` + module `config`; no instance
    # state is touched, so we can invoke it without loading TF models.
    vec = CognitiveCycle._assemble_global_input(None, req)  # type: ignore[arg-type]
    assert vec.shape == (config.GLOBAL_INPUT_DIM,)
    assert config.GLOBAL_INPUT_DIM == 1561


def test_surfaced_vector_splits_back_to_request_components() -> None:
    req = _request()
    vec = CognitiveCycle._assemble_global_input(None, req)  # type: ignore[arg-type]

    # This is exactly what cycle.run() puts on CognitionCycleResponse.global_input_vector.
    surfaced = vec.astype(float).tolist()
    assert len(surfaced) == config.GLOBAL_INPUT_DIM

    # The sidecar's reinforce/correct handlers split it back — must reconstruct
    # the original request components byte-for-byte (within float32 tolerance).
    components = _split_input_vector(surfaced)

    def _close(a, b):  # noqa: ANN001
        return all(abs(x - y) < 1e-5 for x, y in zip(a, b))

    assert _close(components["fused_embedding"], req.fused_embedding)
    assert _close(components["drive_vector"], req.drive_vector)
    assert _close(components["drive_deltas"], req.drive_deltas)
    assert abs(components["total_pressure"] - req.total_pressure) < 1e-5
    assert _close(components["episodic_context"], req.episodic_context)


def test_response_carries_global_input_vector_field() -> None:
    # The carrier field exists on the response model and is optional/back-compat.
    from schemas import CognitionCycleResponse, GlobalPrior

    resp = CognitionCycleResponse(
        global_prior=GlobalPrior(
            action_bias=[0.0] * config.ACTION_SPACE_DIM,
            urgency=0.0,
            novelty_score=0.0,
        ),
    )
    assert resp.global_input_vector is None  # omitted when not surfaced

    resp2 = CognitionCycleResponse(
        global_prior=resp.global_prior,
        global_input_vector=[0.0] * config.GLOBAL_INPUT_DIM,
    )
    assert resp2.global_input_vector is not None
    assert len(resp2.global_input_vector) == config.GLOBAL_INPUT_DIM
