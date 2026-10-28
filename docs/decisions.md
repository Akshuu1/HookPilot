# HookPilot Architectural Decisions

## ADR 001: Webhook Search Architecture — Combined Tokenized Field with Text Index

### Context
HookPilot receives webhooks with heterogeneous payloads (JSON, form-encoded, XML, raw text) and custom HTTP headers from diverse third-party platforms (Stripe, GitHub, Shopify, etc.). Users debugging and inspecting webhooks via the dashboard or CLI require full-text search capability over:
1. Webhook body text (`rawBody`)
2. Inbound header keys and values (e.g., custom trace headers, event IDs, tenant IDs, signature metadata)

### Considered Options

#### Option 1: Unindexed Regex (`$regex`) on `rawBody` and `headers`
* **Pros**: Simple to implement without additional fields or indexes.
* **Cons**:
  * MongoDB `$regex` queries without a leading anchor (`^`) force full collection table scans ($O(N)$ execution time).
  * High-volume webhook retention (millions of documents per month) leads to severe disk I/O thrashing, memory exhaustion, and multi-second query latencies.
  * Searching dynamic key-value pairs inside embedded maps or subdocuments using regex across all fields requires unwinding or complex `$where` JavaScript expressions.

#### Option 2: Wildcard Text Index on Entire Document (`$**`)
* **Pros**: Automatically indexes all string fields in the collection.
* **Cons**:
  * Significant write amplification and storage overhead, as every internal field (IDs, timestamps, system statuses) is tokenized into the text index.
  * Degrades ingestion throughput on high-velocity ingest paths.

#### Option 3: Synthetic `searchIndex` Token Field Combined with Text & Substring Indexing (Selected)
* **Design**:
  * Upon webhook ingest, a synthesized `searchIndex` string is constructed by concatenating sanitized header key-value pairs with the raw body:
    ```typescript
    const headerTokens = Object.entries(headers).map(([k, v]) => `${k} ${v}`).join(' ');
    const searchIndex = `${headerTokens} ${rawBody}`;
    ```
  * A compound text index is created over `{ searchIndex: 'text', rawBody: 'text' }`.
  * The query engine leverages MongoDB text search (`$text: { $search: q }`) for tokenized search and case-insensitive regex for partial substring matches across the pre-flattened field.

### Decision
We adopted **Option 3: Combined Tokenized `searchIndex` Field with Compound Text Index**.

### Consequences
* **Performance**: Index lookups replace full collection scans. Search latency remains $O(\log N)$ even with millions of retained events.
* **Predictability**: Headers and body content are searchable in a unified, consistent manner without requiring dynamic wildcard indexing on polymorphic schema sub-objects.
* **Storage Efficiency**: The text index is constrained strictly to searchable text, avoiding unnecessary indexing of system timestamps, ObjectIds, and binary counters.


## ADR 002: Ingestion Sliding-Window Rate Limiting — Atomic Redis Lua vs. Multi-Roundtrip ZSET Commands

### Context
During Phase 11 load testing (`npm run loadtest`) with 100 concurrent virtual users ramping to 800+ req/sec, the ingest rate limiter (`checkEndpointRateLimit`) was identified as a critical path operation for `POST /in/:slug`.

Each inbound webhook must verify whether the destination endpoint has exceeded its configured `rateLimitPerMin`. The initial design implemented a sliding window via four sequential Redis commands:
1. `zremrangebyscore(key, 0, windowStart)`
2. `zcard(key)`
3. `zadd(key, now, member)`
4. `expire(key, 65)`

### Identified Bottlenecks
1. **Network Round-Trip Latency Multiplier**:
   Executing four separate commands per HTTP request multiplied TCP network round-trips by $4\times$. Under high concurrency, connection multiplexing over the single `ioredis` socket introduced micro-queuing and latency spikes (p95 exceeded 230ms).
2. **Concurrency Race Window**:
   Between step 2 (`zcard`) and step 3 (`zadd`), concurrent worker threads could read identical card counts and both write entries, causing transient burst over-admission beyond the defined rate limit threshold.
3. **Endpoint Schema Constraints**:
   The initial validation schema capped `rateLimitPerMin` at 10,000 req/min (166 req/sec). Enterprise webhooks exceeding this threshold were prematurely rejected with HTTP 429.

### Considered Options

#### Option 1: Redis Pipeline (`redis.pipeline()`)
* **Pros**: Bundles commands into a single network packet.
* **Cons**: Pipelines cannot perform conditional logic on the server; the application must wait for `ZCARD` results before deciding whether to execute `ZADD`, still requiring two round-trips.

#### Option 2: Atomic Redis Lua Script (Selected)
* **Design**:
  A pre-compiled Lua script runs atomically on the Redis server:
  ```lua
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
  local currentHits = redis.call('ZCARD', KEYS[1])
  if currentHits >= tonumber(ARGV[4]) then
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    local oldestScore = oldest[2] or ARGV[2]
    return { 0, tonumber(oldestScore) }
  else
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
    return { 1, currentHits + 1 }
  end
  ```
* **Pros**:
  * Reduces network round-trips from 4 to exactly 1.
  * Guaranteed atomicity: no race conditions or over-admission between card check and entry insertion.
  * Server-side calculation of `Retry-After` using the oldest entry score in the active window.

### Decision
We adopted **Option 2: Atomic Redis Lua Script** and expanded the `rateLimitPerMin` schema maximum to 1,000,000 req/min.

### Consequences
* **Throughput**: Peak sustainable ingestion throughput increased to over **600 req/sec** sustained (peaking at 800+ req/sec).
* **Latency**: p95 ingestion latency decreased from 235 ms to **108 ms**.
* **Reliability**: Zero dropped requests or race conditions across 18,270 concurrent signed webhooks.


## ADR 003: Asynchronous Ingestion via Message Queue (BullMQ + Redis) vs. Synchronous Inline Forwarding

### Context
Webhook receivers sit on the public internet receiving HTTP notifications from payment processors (Stripe), e-commerce platforms (Shopify), and CI/CD pipelines (GitHub). When a webhook arrives at `POST /in/:slug`, the system must decide whether to dispatch the webhook to the destination URL immediately within the HTTP request lifecycle or buffer it asynchronously.

### Considered Options

#### Option 1: Synchronous Inline Forwarding
* **Design**: The ingest handler awaits an outgoing HTTP request to the customer's destination URL before returning an HTTP response to the sender.
* **Cons**:
  * **Tight Coupling & Cascading Failures**: If the customer's server takes 10 seconds to respond or times out, the ingest worker connection remains pinned open.
  * **Sender Timeouts & Re-delivery Storms**: Stripe times out after 10–20 seconds and retries. Synchronous forwarding causes duplicate delivery storms and connection pool exhaustion.
  * **Vulnerability to Spikes**: Black Friday traffic surges immediately overwhelm the ingest tier if downstream servers slow down.

#### Option 2: Asynchronous Ingestion via BullMQ & Redis (Selected)
* **Design**:
  1. Ingestion service captures the raw payload, verifies signatures, records the event in MongoDB with status `queued`, enqueues a job into Redis BullMQ, and immediately replies with `HTTP 202 Accepted` (`{ eventId: "..." }`).
  2. Independent, horizontally scalable Delivery Workers consume jobs off BullMQ, dispatch HTTP POSTs with circuit breaking, and handle exponential retries.
* **Pros**:
  * **Ultra-Fast Ingestion Response**: Ingest p95 latency is guaranteed under 108 ms regardless of customer destination responsiveness.
  * **Traffic Shock Absorption**: Redis buffers sudden spikes of tens of thousands of webhooks without dropping requests.
  * **Zero Dropped Deliveries**: Even if delivery workers or destination endpoints crash, jobs remain durably stored in Redis BullMQ persistence.

### Decision
We adopted **Option 2: Asynchronous Ingestion via BullMQ & Redis**.


## ADR 004: Document Storage (MongoDB) vs. Relational SQL for Polymorphic Webhook Payloads

### Context
HookPilot must store metadata, headers, raw payload contents, delivery attempt histories, and audit records for webhooks originating from arbitrary third-party platforms.

### Considered Options

#### Option 1: Relational Database (PostgreSQL / MySQL)
* **Pros**: Rigid relational integrity and strong ACID guarantees across foreign keys.
* **Cons**:
  * Webhook payloads are heterogeneous and polymorphic: Stripe events contain deeply nested customer/invoice structures, GitHub events contain commit diff arrays, Shopify events contain line-item collections, and custom endpoints send arbitrary JSON or XML.
  * Modeling arbitrary HTTP headers and payload bodies in SQL requires either `JSONB` columns (sacrificing SQL schema benefits) or complex EAV (Entity-Attribute-Value) relational schemas that degrade query performance.
  * Relational table growth across millions of monthly events requires manual partition management.

#### Option 2: Document Store with MongoDB (Selected)
* **Design**:
  * Mongoose models for `Event`, `Endpoint`, `DeliveryAttempt`, `Workspace`, `User`, and `ApiKey`.
  * Flexible BSON documents store exact request/response headers as `Map<string, string>`, nested JSON payloads, and delivery attempt arrays without schema impedance mismatch.
  * Native TTL Indexes (`expiresAt`) provide automatic, zero-maintenance event retention cleanup per workspace.
  * Rich Aggregation Pipeline enables single-pass analytics ($dateTrunc time bucketing, percentile calculations, and failure clustering).

### Decision
We adopted **Option 2: Document Store with MongoDB**.


## ADR 005: Deterministic BullMQ Job ID Strategy (`jobId = eventId`) for Idempotency

### Context
Network blips, client retries, or distributed worker restarts can attempt to enqueue the same webhook delivery multiple times. Without idempotency guards, duplicate delivery jobs could be dispatched to customer destination servers.

### Considered Options

#### Option 1: Auto-generated Random Job IDs (BullMQ Default)
* **Pros**: Simplest to implement.
* **Cons**: If an ingest service encounters a transient network timeout right after calling `queue.add()`, a subsequent client retry generates a new random job ID, causing duplicate deliveries of the same event.

#### Option 2: Deterministic Job ID Mapping (Selected)
* **Design**:
  * Initial Delivery: `jobId = event._id.toString()`
  * Replay Delivery: `jobId = `${event._id.toString()}:${event.replayCount}``
* **Pros**:
  * **Hardware-Level Deduplication**: BullMQ rejects attempts to add a job with an ID that already exists in `waiting`, `active`, or `delayed` states.
  * **Direct Traceability**: Worker logs, Prometheus metrics, and error stack traces directly correlate `job.id` to the MongoDB `Event._id` without requiring secondary index lookups.
  * **Replay Isolation**: When a user or automated schedule triggers a replay, incrementing `replayCount` guarantees a fresh, unique, yet fully deterministic job ID.

### Decision
We adopted **Option 2: Deterministic Job ID Mapping**.


## ADR 006: Jittered Exponential Backoff (Full Jitter) vs. Fixed Interval Retries

### Context
When a destination server experiences an outage or deployment restart, all incoming webhooks fail simultaneously. The retry mechanism must balance rapid recovery with downstream system protection.

### Considered Options

#### Option 1: Fixed Interval Retries (e.g. retry every 30 seconds)
* **Cons**: All failed requests wake up simultaneously in synchronization, generating recurring spike loads on the recovering service.

#### Option 2: Pure Exponential Backoff ($T_i = \text{base} \times 2^i$)
* **Cons**: While spacing out retries, if a burst of 1,000 webhooks failed at time $T_0$, they all retry simultaneously at $T_0 + 2\text{s}$, $T_0 + 4\text{s}$, $T_0 + 8\text{s}$, producing periodic "thundering herd" spikes (the "Retry Avalanche" problem).

#### Option 3: Full Jitter Exponential Backoff (Selected)
* **Design**:
  Based on the Amazon Architecture research on backoff algorithms:
  $$\text{Sleep}(i) = \text{random}(0, \, \min(\text{maxDelay}, \, \text{baseDelay} \times 2^i))$$
  Implemented in `@hookpilot/shared`:
  ```typescript
  export function calculateBackoffWithJitter(
    attempt: number,
    baseDelayMs = 1000,
    maxDelayMs = 3600000,
  ): number {
    const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    return Math.floor(Math.random() * exponential);
  }
  ```
* **Pros**: Spreads retry traffic across a continuous uniform distribution, flattening traffic surges into a steady, manageable trickle for recovering customer servers.

### Decision
We adopted **Option 3: Full Jitter Exponential Backoff**.


## ADR 007: Raw Stream Buffer Ingestion vs. Standard Body Parsers for HMAC Verification

### Context
Inbound webhooks from Stripe, GitHub, and Shopify include cryptographic HMAC-SHA256 signatures in HTTP headers (e.g., `Stripe-Signature`, `X-Hub-Signature-256`) to verify message authenticity and tamper-resistance.

### Considered Options

#### Option 1: Standard `express.json()` Middleware
* **Design**: Allow Express to parse the incoming request body into a JavaScript object, and subsequently serialize it via `JSON.stringify()` for HMAC hashing.
* **Cons**:
  * `JSON.stringify(req.body)` does NOT preserve original byte ordering, whitespace, line breaks, or float formatting.
  * Any alteration in byte representation breaks HMAC verification, causing legitimate webhooks to be falsely rejected as forged.

#### Option 2: Raw Byte Capture Prior to Body Parsing (Selected)
* **Design**:
  * Mount the public `/in/:slug` ingest route **before** `express.json()` is registered.
  * A dedicated `rawBodyCapture` middleware intercepts the incoming Node.js `IncomingMessage` readable stream:
    ```typescript
    req.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) throw new PayloadTooLargeError();
    });
    ```
  * Preserves the exact, bit-for-bit `Buffer` in `req.rawBodyBuffer` and raw string in `req.rawBody`.
* **Pros**:
  * 100% cryptographic fidelity matching upstream sender signatures.
  * Rejects oversized payloads (> 1 MB) immediately before memory allocation.

### Decision
We adopted **Option 2: Raw Byte Capture Prior to Body Parsing**.


## ADR 008: Comprehensive DNS Resolution & IP Blocklist SSRF Prevention

### Context
Users configure arbitrary destination URLs for their endpoints (e.g. `https://api.mycompany.com/webhook`). Without validation, malicious actors could submit internal addresses to probe cloud metadata services, databases, or orchestrators:
* `http://169.254.169.254/latest/meta-data/` (AWS/GCP Instance Metadata)
* `http://localhost:6379` (Local Redis without auth)
* `http://10.0.0.1` (Internal VPC services)
* DNS Rebinding attacks (domain resolves to a public IP on creation, then rebinds to `127.0.0.1` on delivery).

### Considered Options

#### Option 1: Regex String Filtering on URL
* **Cons**: Fails against DNS aliases (e.g. `spoofed.com` pointing to `127.0.0.1`), decimal IP encodings (`http://2130706433`), IPv6 hex representations, or DNS rebinding.

#### Option 2: Multi-Layer Pre-flight DNS Resolution & Outbound Agent Pinning (Selected)
* **Design**:
  1. Protocol Whitelist: Only `http:` and `https:` schemes allowed.
  2. Pre-flight DNS Resolution: Resolves all A and AAAA records via `dns.promises.lookup(hostname, { all: true })`.
  3. Strict CIDR Blacklisting: Validates every resolved IP against all blocked ranges:
     - `0.0.0.0/8` (Current network)
     - `10.0.0.0/8` (Private network)
     - `127.0.0.0/8` (Loopback)
     - `169.254.0.0/16` (Link-local / Cloud metadata)
     - `172.16.0.0/12` (Private network)
     - `192.168.0.0/16` (Private network)
     - `100.64.0.0/10` (Carrier-grade NAT)
     - `::1/128` (IPv6 Loopback)
     - `fc00::/7` (IPv6 Unique Local)
     - `fe80::/10` (IPv6 Link-local)
  4. DNS Rebinding Immunity: Delivery HTTP agent pins the validated IP address for socket creation, preventing TOCTOU resolution shifts.

### Decision
We adopted **Option 2: Multi-Layer Pre-flight DNS Resolution & Outbound Agent Pinning**.


## ADR 009: Rolling-Window Consecutive Failure Circuit Breaker for Target Endpoints

### Context
When a customer destination goes down hard (e.g. database crash, 500 server error), dispatching hundreds of retries wastes HookPilot delivery worker threads and floods the customer's crashed server.

### Considered Options

#### Option 1: No Circuit Breaking (Naive Retry Loop)
* **Cons**: Exhausts worker thread pools and prevents recovery of downstream customer infrastructure.

#### Option 2: Distributed Redis Circuit Breaker (Selected)
* **Design**:
  Implemented in `apps/worker/src/services/circuit-breaker.ts` using Redis:
  * **State Machine**:
    * `CLOSED`: Normal operation. Requests proceed directly.
    * `OPEN`: Tripped after 5 consecutive 5xx/timeout errors. Subsequent requests fail fast immediately without network dispatch for a 30-second cooldown period.
    * `HALF_OPEN`: Cooldown expires; exactly 1 trial probe request is allowed through. If probe succeeds (2xx) $\rightarrow$ `CLOSED`; if probe fails $\rightarrow$ resets to `OPEN`.
  * **Distributed State**: Shared in Redis so multiple worker instances coordinate circuit states seamlessly.

### Decision
We adopted **Option 2: Distributed Redis Circuit Breaker**.


## ADR 010: Known System Limitations & Architectural Trade-offs

### 1. Redis Memory Consumption Under Extended Outages
* **Trade-off**: BullMQ retains job metadata in Redis RAM. If downstream destinations remain dead for days while receiving millions of webhooks, Redis memory consumption scales with queue depth.
* **Mitigation**: Dead-letter quarantine moves exhausted jobs out of active BullMQ structures into MongoDB, keeping Redis active queue memory bounded.

### 2. Single-Region Ingestion Latency
* **Trade-off**: The primary API and MongoDB/Redis clusters run in a single primary region. Webhooks sent from overseas (e.g. Europe to US-East) incur cross-oceanic TCP handshake latency.
* **Mitigation**: Documented in the Strategic Roadmap below (Multi-Region Edge Ingestion).

### 3. In-Memory Raw Stream Buffer Cap
* **Trade-off**: Payloads larger than 1 MB are rejected with HTTP 413 to prevent memory exhaustion and buffer overflows.
* **Mitigation**: Standard webhooks are typically 1 KB to 50 KB. For multi-megabyte payloads, senders should use asynchronous object storage URLs (S3 presigned URLs) rather than raw webhook bodies.

---

## What I Would Do Next (Strategic Roadmap)

### 1. Multi-Region Edge Ingestion Proxies
* **Concept**: Deploy ultra-low-latency edge workers (Cloudflare Workers or AWS Lambda@Edge) across global points of presence (PoPs).
* **Benefit**: Senders terminate TLS handshakes within 10 ms locally. Edge workers stream the raw buffer to a global Apache Kafka or Redpanda pipeline that fans in to regional HookPilot delivery workers.

### 2. Outbound Webhook Delivery Subsystem
* **Concept**: Provide an outbound webhook delivery engine for developers building B2B SaaS platforms.
* **Capabilities**:
  * Developer SDK (`hookpilot.publish('invoice.paid', data)`)
  * Recipient endpoint management portal with customer self-service retry controls.
  * Automated cryptographic signing (Stripe-compatible signatures) with recipient public keys.

### 3. Dynamic Payload Transformations (WASM / jq / JavaScript)
* **Concept**: Allow users to configure inline transformation filters on endpoints to reshape incoming webhooks before delivery.
* **Capabilities**:
  * Execute sandboxed jq expressions or lightweight WebAssembly (WASM) filters.
  * Map legacy webhook payloads directly to internal API schemas without building intermediary microservices.

