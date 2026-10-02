# node:*-bookworm (glibc), not alpine (musl) — the stalwart-cli binary is
# published as x86_64-unknown-linux-gnu, which won't run on musl.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -LsSf \
      https://github.com/stalwartlabs/cli/releases/latest/download/stalwart-cli-installer.sh | sh
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/api/me || exit 1

CMD ["node", "server.js"]
