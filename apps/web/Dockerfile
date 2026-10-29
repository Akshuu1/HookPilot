# Stage 1: Build web application
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root configs
COPY package.json tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/

# Copy web package
COPY apps/web/package.json ./apps/web/
COPY apps/web/tsconfig.json ./apps/web/
COPY apps/web/vite.config.ts ./apps/web/
COPY apps/web/tailwind.config.js ./apps/web/
COPY apps/web/postcss.config.js ./apps/web/
COPY apps/web/index.html ./apps/web/
COPY apps/web/src ./apps/web/src/

# Install dependencies and build
RUN npm install
RUN npm run build --workspace=@hookpilot/shared
RUN npm run build --workspace=@hookpilot/web

# Stage 2: Serve static files
FROM node:22-alpine AS runner

WORKDIR /app

# Install lightweight serve utility
RUN npm install -g serve

# Copy compiled static assets
COPY --from=builder /app/apps/web/dist ./dist

# Non-root user
USER node

EXPOSE 5173

CMD ["serve", "-s", "dist", "-l", "5173"]
