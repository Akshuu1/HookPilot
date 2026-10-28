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

