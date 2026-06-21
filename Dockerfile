# Framecast engine — flat repo, one Dockerfile at the root.
# Playwright base image ships Chromium + every system library it needs.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Full ffmpeg (includes the drawtext filter for watermarks — the stripped-down
# ffmpeg-static binary does NOT) plus DejaVu fonts for the watermark text.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    FRAMECAST_CONCURRENCY=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Drop root: run as the non-privileged user the Playwright image ships with, so a
# browser-sandbox escape can't land as root. WORK dir lives under /tmp (writable).
USER pwuser

EXPOSE 8080
CMD ["node", "server.js"]
