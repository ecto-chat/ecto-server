# Build context: parent directory containing ecto-shared, ecto-server
# docker build -f ecto-server/Dockerfile -t ecto-server .

# Stage 1: Build ecto-shared
FROM node:22-slim AS shared-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build/ecto-shared
COPY ecto-shared/package.json ecto-shared/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY ecto-shared/src ./src
COPY ecto-shared/tsup.config.ts ecto-shared/tsconfig.json ./
RUN pnpm build

# Stage 2: Build ecto-server
FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y python3 python3-pip g++ make && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build/ecto-shared
COPY --from=shared-builder /build/ecto-shared ./
WORKDIR /build/ecto-server
COPY ecto-server/package.json ecto-server/pnpm-lock.yaml ./
RUN sed -i 's|link:../ecto-shared|file:../ecto-shared|g' package.json
RUN pnpm install
COPY ecto-server/src ./src
COPY ecto-server/tsconfig.json ./
RUN pnpm build
# Reinstall production-only dependencies
RUN rm -rf node_modules && pnpm install --prod

# Stage 3: Runtime
FROM node:22-slim
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /build/ecto-server/package.json ./
COPY --from=builder /build/ecto-server/node_modules ./node_modules
COPY --from=builder /build/ecto-server/dist ./dist
COPY ecto-server/drizzle ./drizzle
EXPOSE 3000
EXPOSE 40000/udp
EXPOSE 40000/tcp
CMD ["node", "dist/index.js"]
