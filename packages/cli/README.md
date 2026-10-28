# HookPilot CLI (`hookpilot`)

The official command-line interface for **HookPilot**. Tunnel live production and staging webhooks directly to your local development server without exposing public ports or configuring ngrok.

---

## Features

- ⚡ **Zero-config Tunneling**: Direct bidirectional Socket.IO tunnel over Redis.
- 🔑 **API Key Authentication**: Secure SHA-256 hashed keys scoped per workspace.
- 🔄 **Automatic Fallback**: If no CLI session is active, webhooks automatically deliver to your remote destination URL.
- ⏱ **Live Heartbeat**: 30-second Redis lease with 10-second automatic heartbeats.
- 🎨 **Colored Terminal Logging**: Live HTTP method, status codes, response time, and event IDs.
- 📦 **No Install Required**: Run instantly with `npx hookpilot`.

---

## Installation & Running

### Using NPX (Recommended)
```bash
npx hookpilot --help
```

### Global Install
```bash
npm install -g hookpilot
```

---

## Commands

### 1. `hookpilot login`

Saves your workspace API key to `~/.hookpilot/config.json` with secure file permissions (`0600`).

```bash
# Login with your API key
npx hookpilot login --key hp_live_abcdef1234567890

# Optional: specify custom HookPilot server URL (defaults to http://localhost:4000)
npx hookpilot login --key hp_live_abcdef1234567890 --server https://api.hookpilot.com
```

### 2. `hookpilot listen`

Connects to the HookPilot tunnel and forwards inbound webhooks directly to your local port and path.

```bash
# Listen on port 3000 for webhooks sent to endpoint slug 'stripe-webhooks'
npx hookpilot listen 3000 --endpoint stripe-webhooks

# Forward to a specific local path (e.g. /api/webhooks)
npx hookpilot listen 3000 --endpoint stripe-webhooks --path /api/webhooks

# Override API key or server URL for a single session
npx hookpilot listen 3000 --endpoint stripe-webhooks --key hp_live_... --server https://api.hookpilot.com
```

---

## Example: Local Express Webhook Server

1. Start your local Express webhook listener:

```javascript
// server.js
import express from 'express';

const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  console.log('Received webhook:', req.body);
  res.status(200).json({ received: true });
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

2. Start the HookPilot tunnel:
```bash
npx hookpilot listen 3000 --endpoint my-webhook-slug --path /webhook
```

3. Send a test webhook to your HookPilot ingest URL:
```bash
curl -X POST http://localhost:4000/in/my-webhook-slug \
  -H "Content-Type: application/json" \
  -d '{"event": "payment.succeeded", "amount": 4200}'
```

4. Watch the CLI output in real-time:
```text
[19:42:15] POST /webhook -> 200 OK (28ms) [event: 6720f1...]
```
The response from your local Express server (status, duration, headers, body snippet) is forwarded back to HookPilot and recorded as a delivery attempt.

---

## How It Works

```
                                      ┌─────────────────────────────────┐
Inbound Webhook                       │      HookPilot Worker           │
      │                               │                                 │
      ▼                               │ 1. Checks Redis for CLI lease   │
┌──────────────┐                      │    tunnel:endpoint:<id>         │
│  apps/api    │                      │                                 │
│  /in/:slug   │─── Enqueue BullMQ ──►│ 2. CLI active?                  │
└──────────────┘                      │    YES ──► Publish to tunnel    │
                                      │    NO  ──► Normal HTTP delivery │
                                      └────────────────┬────────────────┘
                                                       │
                                      Redis Pub/Sub ('tunnel:requests')
                                                       │
                                                       ▼
                                      ┌─────────────────────────────────┐
                                      │      HookPilot Socket Server    │
                                      │  Emits 'tunnel:event' over WS   │
                                      └────────────────┬────────────────┘
                                                       │
                                           WebSocket connection
                                                       │
                                                       ▼
                                      ┌─────────────────────────────────┐
                                      │      hookpilot CLI              │
                                      │  Forwards to localhost:3000     │
                                      │  Replies with 'tunnel:response' │
                                      └─────────────────────────────────┘
```
