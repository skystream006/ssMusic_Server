FROM denoland/deno:bin AS deno

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
COPY src ./src
COPY vite.config.js ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    WEB_API_PORT=3123 \
    HTTPS_WEB_PORT=4123 \
    YTDLP_OUTPUT_ROOT=/app/output \
    YTDLP_PATH=/app/runtime/yt-dlp/yt-dlp \
    DENO_PATH=/app/runtime/deno/bin/deno \
    FFMPEG_PATH=/usr/bin
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/runtime/yt-dlp /app/runtime/deno/bin /app/data /app/output \
    && case "$(dpkg --print-architecture)" in \
        amd64) asset=yt-dlp_linux ;; \
        arm64) asset=yt-dlp_linux_aarch64 ;; \
        *) echo "Unsupported yt-dlp architecture" >&2; exit 1 ;; \
    esac \
    && curl -fL --retry 3 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" -o /app/runtime/yt-dlp/yt-dlp \
    && chmod 755 /app/runtime/yt-dlp/yt-dlp
COPY --from=deno /deno /app/runtime/deno/bin/deno
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY package.json package-lock.json ./
COPY src ./src
RUN chown -R node:node /app/runtime /app/data /app/output
USER node
EXPOSE 3123 4123
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "const https = require('node:https'); const request = https.get({ hostname: '127.0.0.1', port: process.env.HTTPS_WEB_PORT || 4000, path: '/health', rejectUnauthorized: false }, response => { response.resume(); process.exit(response.statusCode === 200 ? 0 : 1); }); request.setTimeout(4000, () => request.destroy()); request.on('error', () => process.exit(1));"
CMD ["node", "--import=dotenv/config", "src/server.js"]