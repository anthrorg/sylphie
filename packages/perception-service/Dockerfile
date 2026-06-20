FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgles2 libegl1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- P3 backbone weights, baked for deterministic offline startup ---
# Positioned AFTER pip install (needs transformers/insightface) but BEFORE the
# source COPY, so editing cobeing/ or main.py does NOT bust this ~600MB weight
# cache on the P3.1/P3.2 rebuilds. HF_HOME / INSIGHTFACE_HOME are persisted as
# ENV so the runtime extractors resolve the baked caches instead of re-fetching.
#   - facebook/dinov2-base  -> 768-D object embeddings (P3.1)
#   - buffalo_l (w600k_r50) -> 512-D face embeddings   (P3.2)
ENV HF_HOME=/app/.cache/huggingface
ENV INSIGHTFACE_HOME=/app/.cache/insightface
RUN python -c "from transformers import AutoModel, AutoImageProcessor; AutoModel.from_pretrained('facebook/dinov2-base'); AutoImageProcessor.from_pretrained('facebook/dinov2-base')"
RUN python -c "import insightface; insightface.app.FaceAnalysis(name='buffalo_l').prepare(ctx_id=-1)"

COPY cobeing/ cobeing/
COPY main.py .
COPY blaze_face_short_range.tflite .
COPY face_landmarker.task .

ENV PYTHONPATH=/app
EXPOSE 8430

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8430"]
