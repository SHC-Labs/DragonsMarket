FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN test -z "${DATABASE_URL:-}${AGENT_API_KEY:-}${AGENT_GRANT_KEY:-}${OPERATOR_TOKEN:-}"
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --filter web --frozen-lockfile
COPY web ./web
ARG NEXT_PUBLIC_NETWORK=testnet
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_MARKET_ID
ARG NEXT_PUBLIC_ORACLE_ID
ARG NEXT_PUBLIC_COUNCIL_ID
ARG NEXT_PUBLIC_VERIFIER_ID
ARG NEXT_PUBLIC_COLLATERAL_TOKEN_ID
ARG NEXT_PUBLIC_NFT_ID
ARG NEXT_PUBLIC_TOKEN_ID
ARG NEXT_PUBLIC_AGENT_WALLET_CONTRACT
ARG NEXT_PUBLIC_AGENT_API_HOST
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_MCP_URL
ARG NEXT_PUBLIC_RELEASE_COMMIT
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build:web

FROM caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/out-caddy /app/web/out
USER 1000:1000
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
