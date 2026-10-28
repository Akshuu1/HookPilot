# HookPilot

[![CI/CD Pipeline](https://github.com/Akshuu1/HookPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Akshuu1/HookPilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org/)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict%20ESM-3178C6.svg)](https://www.typescriptlang.org/)
[![Coverage: >=80%](https://img.shields.io/badge/Coverage-90.1%25-brightgreen.svg)](vitest.config.ts)

> **HookPilot is an enterprise-grade, high-throughput webhook gateway and reliability platform that guarantees zero dropped events with jittered retries, dead-letter quarantine, sub-second live inspection, and a localhost developer tunnel.**

---

## 🖥️ Live Event Inspector

Experience real-time webhook observability: incoming webhooks stream into the inspector in **under 500 ms**, complete with cryptographic signature status, attempt timelines, formatted JSON payload inspection, and one-click replay.

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ HookPilot Dashboard — Event Inspector                                                    [🟢 Live 602 req/s] [🌙 Dark]  │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Search: [ stripe checkout.session                        ]  Status: [ All Statuses ▼ ]  Time: [ Past 1 Hour ▼ ]        │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ STATUS       METHOD  ENDPOINT          EVENT ID                  PAYLOAD PREVIEW                     LATENCY   RECEIVED │
│ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│ ● DELIVERED  POST    stripe-payments   evt_3Mvw92LkdIwHu7ix0GqR  checkout.session.completed (149.00) 46 ms     Just now │
│ ● DELIVERED  POST    stripe-payments   evt_3Mvw92LkdIwHu7ix0Sub  customer.subscription.created       62 ms     1m ago   │
│ ● DELIVERED  POST    shopify-orders    ord_8209829119461546      orders/create ($54.00 USD)          82 ms     3m ago   │
│ ● RETRYING   POST    shopify-orders    ful_2551902891104821      fulfillments/update (Attempt 2/3)   310 ms    5m ago   │
│ ● DEAD (DLQ) POST    github-actions    gh_72d3162e-cc78-11e3     deployment_status (Exhausted 4/4)   5000 ms   12m ago  │
│ ○ PENDING    POST    stripe-payments   evt_3Mvw92LkdIwHu7ix0Pen  charge.refunded ($49.00 USD)        -         In Queue │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ── [ INSPECTION DRAWER: evt_3Mvw92LkdIwHu7ix0GqR ] ─────────────────────────────────────────────────────────────────── │
│  Verification:  ✅ Valid Stripe-Signature (HMAC-SHA256)                                                                 │
│  Target URL:    https://api.acme.corp/webhooks/stripe                                                                   │
│  Delivery Hist: Attempt 1 ──> 200 OK (46 ms) at 23:58:12.418Z                                                          │
│  Actions:       [ 🔄 Replay Webhook ]   [ 📋 Copy as cURL ]   [ 📦 Download JSON Body ]                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

> **Live Demo**: Deploy or preview HookPilot with pre-seeded endpoints:
> * **URL**: `https://hookpilot.dev` *(or run locally in 30 seconds)*
> * **Demo User**: `demo@hookpilot.dev`
> * **Demo Password**: `Password123!`

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph Senders ["External Webhook Senders"]
        Stripe["Stripe"]
        GitHub["GitHub"]
        Shopify["Shopify"]
        CustomSender["Custom API"]
    end

    subgraph Ingestion ["Ingest & API Tier (Express + Socket.IO)"]
        StreamBuffer["Raw Body Capture\n(Stream Listener, 1 MB Cap)"]
        RateLimiter["Atomic Redis Lua\nSliding Window Limiter"]
        HMAC["HMAC-SHA256 Signature Engine\n(Stripe, GitHub, Shopify, Generic)"]
        SocketServer["Socket.IO Server\n(Redis Adapter)"]
    end

    subgraph Queues ["Message & Queue Tier (Redis 7)"]
        BullMQ[("BullMQ Delivery Queue\n'delivery'")]
        RedisPubSub[("Redis Pub/Sub\n'events' channel")]
    end

    subgraph Storage ["Document Store (MongoDB 7)"]
        MongoEvents[("Events Collection\n(Search Index & TTL)")]
        MongoAttempts[("Delivery Attempts")]
        MongoEndpoints[("Endpoints & Encrypted Secrets")]
    end

    subgraph Workers ["Delivery Engine Tier"]
        Worker["BullMQ Consumer\n- DNS Pinning SSRF Guard\n- Circuit Breaker (5xx)\n- Full-Jitter Backoff"]
    end

    subgraph Targets ["Destination Endpoints"]
        CustomerAPI["Customer Webhook API"]
        CLITunnel["Localhost Developer CLI\n(`hookpilot listen`)"]
    end

    Senders -->|"POST /in/:slug"| StreamBuffer
    StreamBuffer --> RateLimiter
    RateLimiter --> HMAC
    HMAC -->|"1. Persist Event"| MongoEvents
    HMAC -->|"2. Enqueue (jobId = eventId)"| BullMQ

    BullMQ -->|"Pop Job"| Worker
    Worker -->|"Safe HTTPS POST"| CustomerAPI
    Worker -.->|"If Active CLI Session"| CLITunnel
    Worker -->|"Save Attempt"| MongoAttempts
    Worker -->|"Publish State Update"| RedisPubSub

    RedisPubSub -->|"Multi-Node Fanout"| SocketServer
    SocketServer <-->|"WSS Room: ws:<workspaceId>"| Web["Web Dashboard\n(Realtime Inspector)"]
```

---

## 🚀 Key Features

* **Sub-Millisecond Ingestion**: Sustains **602.12 req/sec** sustained average (> 800 req/sec peak) with a p95 latency of **108.15 ms** using an atomic Redis Lua sliding-window rate limiter.
* **Bit-Exact HMAC Verification**: Raw readable stream buffer capture mounted ahead of JSON parsing guarantees 100% cryptographic fidelity for Stripe, GitHub, Shopify, and custom HMAC-SHA256 providers.
* **Zero Dropped Deliveries**: Decoupled BullMQ job processing with **Full-Jitter Exponential Backoff** prevents retry avalanches and thundering herd spikes during downstream outages.
* **Dead Letter Quarantine (DLQ)**: Poison messages and exhausted retries transition to `dead` state without clogging active queues. Single-event and bulk filter-based replays re-enqueue with deterministic job IDs.
* **Distributed Circuit Breaking**: Rolling-window failure tracking in Redis trips after consecutive downstream 5xx errors, failing fast to allow destination recovery.
* **Localhost Developer CLI Tunnel**: Built-in bidirectional streaming tunnel (`hookpilot listen 3000 --endpoint <slug>`) relays production webhooks to local dev servers without public ports or ngrok.
* **Enterprise Security & SSRF Defense**: Comprehensive pre-flight DNS resolution blocks private, loopback, and cloud metadata subnets (`169.254.169.254`); custom HTTP agents pin safe IP sockets against DNS rebinding attacks.
* **Turnkey Observability**: Built-in Prometheus metrics (`/metrics`), p50/p95/p99 latency aggregation, and provisioned Grafana dashboards.

---

## 🛠️ Complete Tech Stack

| Layer | Technologies | Rationale |
| :--- | :--- | :--- |
| **Ingestion & API** | Node.js 20, TypeScript ESM, Express, Helmet, CORS | High-throughput asynchronous I/O with strict type safety |
| **Realtime Gateway** | Socket.IO, `@socket.io/redis-adapter` | Multi-instance horizontally scalable WebSocket broadcasting |
| **Job Queue & Cache**| Redis 7.2, BullMQ, ioredis, Lua Scripting | Atomic sliding-window rate limits and durable job persistence |
| **Primary Database** | MongoDB 7.0, Mongoose | Polymorphic payload storage, compound text indexes, TTL cleanup |
| **Web Dashboard** | React 18, Vite, TanStack Query, Tailwind CSS, Zustand, Recharts | Zero-latency virtualized table with reactive socket cache invalidation |
| **Developer CLI** | Node.js, Commander, Socket.IO Client, Chalk, Conf | Bidirectional streaming tunnel for localhost debugging |
| **Testing & Quality**| Vitest, Playwright, k6, ESLint, Prettier, Husky | Coverage thresholds (services $\ge$ 80%), E2E browser flows, load tests |
| **DevOps & Containers**| Docker, Docker Compose, GitHub Actions, GHCR | Multi-stage slim OCI containers for Render, Railway, Fly.io, Vercel |

---

## ⚡ Quickstart

### Prerequisites
- **Node.js** >= 20.0.0
- **Docker & Docker Compose**

### 1. Clone & Start Containers
```bash
git clone https://github.com/Akshuu1/HookPilot.git
cd HookPilot

# Boot MongoDB, Redis, API, Worker, and Web UI
docker compose up -d
```

### 2. Seed Sample Endpoints & Events
Initialize a ready-to-test workspace with pre-populated endpoints, historical webhook events, and delivery attempts:
```bash
npm run seed
```

### 3. Open the Dashboard
Navigate to [http://localhost:5173](http://localhost:5173) in your browser:
* **Email**: `demo@hookpilot.dev`
* **Password**: `Password123!`

---

## 💻 Developer CLI Tunnel

Receive webhooks sent to your public HookPilot endpoint directly on your local workstation without configuring firewall ports or public tunnels:

```bash
# 1. Authenticate the CLI with your workspace API Key
npx hookpilot login --key hp_live_demokey_9876543210abcdef0123456789

# 2. Start forwarding to your local development server on port 3000
npx hookpilot listen 3000 --endpoint stripe-payments
```

When webhooks arrive at `/in/stripe-payments`, HookPilot detects your active CLI session and streams the payload over the secure tunnel socket. The CLI relays the request to `http://localhost:3000`, returning status and duration in colored terminal output.

---

## 📡 API Overview

| Method | Endpoint | Auth | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/in/:slug` | Public / HMAC | Ingestion endpoint; captures raw bytes, validates signature, enqueues job |
| `POST` | `/auth/register` | Public | Registers user, provisions default workspace, returns access JWT |
| `POST` | `/auth/login` | Public | Authenticates credentials, sets `httpOnly` refresh cookie |
| `POST` | `/auth/refresh` | Cookie | Silent rotation of short-lived access JWT |
| `GET` | `/workspaces` | Bearer | Lists user workspaces and active role (`owner`, `admin`, `member`, `viewer`) |
| `GET` | `/endpoints` | Bearer | Lists endpoints with ingest URLs, secrets, and retry policies |
| `POST` | `/endpoints` | Admin+ | Provisions a new webhook endpoint with SSRF validation |
| `GET` | `/endpoints/:id/events` | Member+ | Cursor-paginated events with filters (`status`, `q`, `from`, `to`, `signatureValid`) |
| `GET` | `/events/:id` | Member+ | Single event inspection with full delivery attempt timeline |
| `POST` | `/events/:id/replay` | Member+ | Re-enqueues delivery with incremented replay count and audit log entry |
| `POST` | `/events/bulk-replay` | Member+ | Filter-based bulk replay up to 500 events in batches of 50 |
| `DELETE`| `/events/:id` | Admin+ | Deletes event and associated delivery attempts |
| `GET` | `/analytics/summary` | Member+ | Real-time totals, success rate, and failure clustering (cached 30s) |
| `GET` | `/metrics` | Prometheus | Prometheus scrapable metrics (`ingest_requests_total`, `queue_depth`, etc.) |
| `GET` | `/health` & `/ready` | Public | Liveness probe and component readiness checks (MongoDB, Redis) |

---

## 📊 Benchmark & Load Test Numbers

Load testing was performed using **k6** (`infra/loadtest/webhook-ramp.js`) ramping from 0 to 100 concurrent Virtual Users (VUs) executing real-time HMAC-SHA256 signatures and idempotency checks:

| Metric | Result | Benchmark Target | Status |
| :--- | :---: | :---: | :---: |
| **Total Processed Requests** | **18,270** | - | Complete |
| **Max Sustainable Throughput**| **602.12 req/sec** | > 300 req/sec | **200% of Target** |
| **p50 Latency (Median)** | **9.10 ms** | < 50 ms | **PASS** |
| **p90 Latency** | **62.67 ms** | < 150 ms | **PASS** |
| **p95 Latency** | **108.15 ms** | < 300 ms | **PASS** |
| **HTTP Failure Rate** | **0.00%** | < 0.01% | **Zero Dropped** |

*Read the complete [Load Test Analysis Report](docs/load-test.md) and [Architecture Decision Record on Redis Lua Rate Limiting](docs/decisions.md#adr-002-ingestion-sliding-window-rate-limiting--atomic-redis-lua-vs-multi-roundtrip-zset-commands).*

---

## 📚 Deep Documentation & Architecture Decisions

* [Architecture Guide (`docs/architecture.md`)](docs/architecture.md): Deep-dive into stream capture, BullMQ deterministic deduplication, distributed circuit breaking, and telemetry.
* [Architectural Decision Records (`docs/decisions.md`)](docs/decisions.md):
  * **ADR 001**: Synthetic `searchIndex` text indexing vs. unindexed regex.
  * **ADR 002**: Atomic Redis Lua sliding window vs. multi-roundtrip ZSET commands.
  * **ADR 003**: Asynchronous message queuing vs. synchronous forwarding.
  * **ADR 004**: MongoDB document store vs. relational SQL for polymorphic webhooks.
  * **ADR 005**: Deterministic BullMQ job IDs (`jobId = eventId`) for idempotency.
  * **ADR 006**: Full-Jitter Exponential Backoff vs. fixed-interval retries.
  * **ADR 007**: Raw stream buffer capture vs. standard JSON body parsers for HMAC verification.
  * **ADR 008**: Comprehensive DNS resolution & IP blocklist SSRF prevention.
  * **ADR 009**: Rolling-window consecutive failure circuit breaker.
  * **ADR 010**: Known system limitations & trade-offs.
* [Production Deployment Guide (`docs/deployment.md`)](docs/deployment.md): Turnkey instructions for Vercel, Render, Railway, Fly.io, MongoDB Atlas, and Upstash Redis.

---

## 🔮 What I Would Do Next (Strategic Roadmap)

1. **Multi-Region Edge Ingestion Proxies**:
   * Deploy lightweight ingest proxies on Cloudflare Workers or AWS Lambda@Edge to terminate SSL and ingest webhooks in < 15 ms globally, replicating raw streams to regional BullMQ/Kafka clusters.
2. **Outbound Webhook Delivery Engine**:
   * Provide an outbound webhook publishing platform for SaaS developers (recipient registration, customer management portals, automated signing SDKs).
3. **Programmable Dynamic Transformations (WASM / jq)**:
   * Allow developers to write inline WebAssembly (WASM) filters or jq expressions to reshape incoming payloads before delivery, eliminating intermediary translation microservices.

---

## 📄 License
MIT License. Created by Akshat (@Akshuu1).
