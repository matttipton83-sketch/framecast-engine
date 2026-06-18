# Framecast engine — flat repo, one Dockerfile at the root.
# Playwright base image ships Chromium + every system library it needs.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV NODE_ENV=production \
    PORT=8080 \
    FRAMECAST_CONCURRENCY=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
