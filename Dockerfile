# syntax=docker/dockerfile:1

# ---------- China mirrors (overridable) ----------
# Defaults speed up builds for developers in China. International users can
# restore upstream sources at build time, e.g.:
#   docker build \
#     --build-arg NODE_IMAGE=node:24-bookworm-slim \
#     --build-arg APT_MIRROR=deb.debian.org \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim
ARG APT_MIRROR=mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- Stage 1: build ----------
# Build the Vite frontend (-> dist/) and bundle the server (-> dist/server.cjs).
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR
ARG NPM_REGISTRY

# Point apt at the China mirror (bookworm uses the deb822 .sources format, with
# a fallback to the legacy sources.list), then install build tools for the
# native better-sqlite3 module.
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Electron: devDependency for the desktop build only — skip its binary download.
# better_sqlite3 mirror: pull the prebuilt native binary from npmmirror (falls
# back to compiling from source via the build tools above if unavailable).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_registry=${NPM_REGISTRY} \
    better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3/

WORKDIR /app

# Install all deps (incl. dev) using the lockfile for reproducible builds.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Build frontend + server bundle.
COPY . .
RUN npm run build

# Drop devDependencies so the runtime image carries only what `dist/server.cjs`
# needs at runtime (esbuild bundles with --packages=external, so node_modules
# must be present). better-sqlite3 stays compiled against this Node ABI.
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    # Persisted user data (db, config, history, taste). Mount a volume here.
    CLAUDIO_DIR=/data

WORKDIR /app

# Runtime assets only: pruned prod deps, built output, prompt template, manifest.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/taste-profile-generation.md ./taste-profile-generation.md

# Writable data dir owned by the unprivileged `node` user that ships with the image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "dist/server.cjs"]
