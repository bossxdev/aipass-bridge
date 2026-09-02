# aipass-bridge — OpenAI-compatible bridge server
# The Chrome extension still runs on the host; it reaches the bridge via the
# exposed port (default 8787 → set bridgeUrl in the extension popup if you
# change the host port mapping).

FROM node:22-alpine

# Non-root user
RUN addgroup -S bridge && adduser -S bridge -G bridge
WORKDIR /app

# Only the files that make up the server — no test suite, no extension JS
COPY bridge/package.json ./bridge/
COPY bridge/server.mjs   ./bridge/
COPY security/           ./security/

# No npm install needed — server has zero external dependencies
USER bridge

# Bind to all interfaces inside the container so the host port mapping works
ENV AIPASS_HOST=0.0.0.0
ENV AIPASS_PORT=8787
ENV NODE_ENV=production

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "bridge/server.mjs"]
