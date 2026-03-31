# ── Stage 1: build the React frontend ─────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# output lands in /build/static (vite.config.ts sets outDir: '../static')


# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM python:3.12-slim

# System packages:
#   ffmpeg        — required by yt-dlp to merge HLS segments and remux containers
#   chromium + deps — Playwright uses the system Chromium on ARM/Linux
#   curl          — health-check helper
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        # Playwright Chromium system dependencies
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
        libcairo2 libatspi2.0-0 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright's bundled Chromium (overrides system one — more reliable)
RUN playwright install chromium --with-deps

# Copy application source (*.py picks up all modules including log.py)
COPY *.py ./

# Copy pre-built frontend static files from stage 1
COPY --from=frontend-builder /build/static ./static

# Downloads volume mount point
RUN mkdir -p /downloads
VOLUME /downloads

ENV DOWNLOAD_DIR=/downloads \
    REDIS_HOST=redis \
    API_HOST=0.0.0.0 \
    API_PORT=8000

EXPOSE 8000
