# Dockerfile
FROM node:current-bookworm-slim AS base
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
COPY ./patches ./patches
COPY ./server/package.json ./server/package.json
COPY ./client/package.json ./client/package.json

FROM base AS prod-deps
RUN pnpm install --prod

FROM base AS build-deps
RUN pnpm install

FROM build-deps AS build
COPY . .
RUN pnpm run build

FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Declare volumes for torrent and download storage.
VOLUME [ "/torrents", "/downloads" ]

# Do not set defaults here—values will come from Compose.
# ENV NODE_ENV="production"
# ENV ADDON_DIR="/addon"
# ENV TORRENT_DIR="/downloads"

EXPOSE 4000
CMD ["pnpm", "start"]
