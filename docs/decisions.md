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
