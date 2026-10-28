# discojockey engine: downloads a DJ set, identifies the tracks, measures blends, BPM and key.
FROM node:22-bookworm-slim AS node

FROM python:3.13-slim-bookworm
# ffmpeg decodes the audio; node runs YouTube's player JavaScript for yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY discojockey_engine ./discojockey_engine

# Hugging Face Spaces expects port 7860 and runs the container as user 1000.
ENV PORT=7860 \
    YTDLP_JS_RUNTIMES=node \
    CACHE_DIR=/tmp/discojockey-cache \
    PYTHONUNBUFFERED=1
RUN useradd -m -u 1000 dj
USER dj
EXPOSE 7860
CMD ["sh", "-c", "uvicorn discojockey_engine.server:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
