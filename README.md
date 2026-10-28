# HookPilot

A high-performance webhook reliability and debugging platform built with **MERN + TypeScript + Redis + Docker**.

HookPilot provides developers and organizations with unique ingest URLs (`/in/:slug`) that receive webhooks from any sender (Stripe, GitHub, Shopify, etc.), guarantees zero dropped deliveries with exponential backoff and jittered retries, isolates permanently failed events in a dead-letter queue (DLQ), and offers live inspection and a localhost CLI tunnel.

---

## Architecture Overview

```
 [ Senders: Stripe / GitHub / Custom ]
                   │
                   │ POST /in/:slug
                   ▼
  ┌─────────────────────────────────┐
  │  Express Ingest API             │ ──> Redis Sliding Window Rate Limit
  │  - Raw body capture             │ ──> Idempotency & Mongo Deduplication
  │  - HMAC signature verification  │
  └────────────────┬────────────────┘
                   │
                   ├── Enqueue Job ─────────┐
                   ▼                        ▼
        ┌─────────────────────┐   ┌─────────────────────┐
        │  MongoDB Database   │   │  Redis (BullMQ)     │
        │  - Events           │   │  - Queue 'delivery' │
        │  - Attempts         │   └──────────┬──────────┘
        └─────────────────────┘              │
                   ▲                         ▼
                   │             ┌───────────────────────┐
                   └── Record ───│  Delivery Worker      │ ──> HTTPS POST (Destination)
                                 │  - Backoff + Jitter   │
                                 │  - DLQ & Circuit Break│
                                 └───────────┬───────────┘
                                             │
                                             │ Redis Pub/Sub
                                             ▼
                                 ┌───────────────────────┐
                                 │  Socket.IO & Web/CLI  │
                                 │  - Live Inspector     │
                                 │  - Replay & Tunnel    │
                                 └───────────────────────┘
```

---

## Monorepo Layout (npm workspaces)

```
hookpilot/
├── apps/
│   ├── api/            # Express REST, Ingest, Health, Sockets, Metrics
│   ├── worker/         # BullMQ delivery processors, retries & DLQ
│   └── web/            # React 18 + Vite + Tailwind + TanStack Query + Zustand
├── packages/
│   ├── shared/         # Zod schemas, types, backoff math with jitter
│   └── cli/            # HookPilot CLI tunnel client (npx hookpilot)
├── infra/              # docker-compose.yml, Mongo, Redis, Prometheus, Grafana
├── .husky/             # Pre-commit hooks (lint-staged + typecheck)
└── tsconfig.base.json  # Shared strict TypeScript configuration
```

---

## Quickstart

### Prerequisites
- Node.js >= 20.0.0
- Docker & Docker Compose

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Tests & Validation
```bash
# Run Vitest unit tests across all workspaces
npm test

# Run strict TypeScript typecheck
npm run typecheck

# Run ESLint validation
npm run lint

# Verify Prettier code style
npm run format:check
```

### 3. Start with Docker Compose
```bash
# Starts MongoDB, Redis, API, Worker, and Web
docker compose up -d
```

### 4. Health Check
```bash
curl http://localhost:4000/health
# {"status":"ok","timestamp":"...","uptime":...}

curl http://localhost:4000/ready
# {"status":"ready","timestamp":"...","components":{"mongodb":{"status":"up"},"redis":{"status":"up"}}}
```

---

## License
MIT
