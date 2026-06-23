# Framecast engine — flat repo, one Dockerfile at the root.
# Playwright base image ships Chromium + every system library it needs.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

# Full ffmpeg (includes the drawtext filter for watermarks) PLUS a real font stack.
#
# WHY THE FONTS: the base image ships almost no fonts. Server-side renders therefore
# silently fall back to Chromium's default face whenever an artifact uses a system
# font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial — the
# default for most Claude/Tailwind artifacts) or emoji/icon glyphs. That fallback
# has different metrics, so text reflows (elements drift off-center) and unsupported
# glyphs drop out (text goes missing) — which is exactly the export-vs-preview
# mismatch reviewers hit. Installing metric-compatible + broad-Unicode + emoji fonts
# and aliasing the common stacks (see fonts-local.conf) closes that gap.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      fonts-liberation \
      fonts-dejavu \
      fonts-noto-core \
      fonts-noto-color-emoji \
      fonts-roboto-unhinted \
    && rm -rf /var/lib/apt/lists/*

# Resolve common browser/OS font-stack families to installed, metric-compatible
# faces so server renders line-break and center the same way the browser preview
# does. Must land before we drop root (fontconfig reads /etc/fonts/local.conf).
COPY fonts-local.conf /etc/fonts/local.conf
RUN fc-cache -f

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
