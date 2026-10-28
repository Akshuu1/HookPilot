# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package.json tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/

# Copy API package
COPY apps/api/package.json ./apps/api/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src/

# Install dependencies and build packages
RUN npm install
RUN npm run build --workspace=@hookpilot/shared
RUN npm run build --workspace=@hookpilot/api

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Copy node_modules and built artifacts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Non-root user
USER node

EXPOSE 4000

CMD ["node", "apps/api/dist/index.js"]
