FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config.py .
COPY schemas.py .
COPY main.py .
COPY models/ models/
COPY training/ training/
COPY inference/ inference/

ENV PYTHONPATH=/app
EXPOSE 8431

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8431"]
