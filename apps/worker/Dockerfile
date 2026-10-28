# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package.json tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/

# Copy Worker package
COPY apps/worker/package.json ./apps/worker/
COPY apps/worker/tsconfig.json ./apps/worker/
COPY apps/worker/src ./apps/worker/src/

# Install dependencies and build packages
RUN npm install
RUN npm run build --workspace=@hookpilot/shared
RUN npm run build --workspace=@hookpilot/worker

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy node_modules and built artifacts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

# Non-root user
USER node

CMD ["node", "apps/worker/dist/index.js"]
