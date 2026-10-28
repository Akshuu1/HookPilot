import { Activity, Radio, Cpu, Database, Server, Terminal, ShieldCheck } from 'lucide-react';

export function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-6 md:p-12">
      <header className="max-w-6xl mx-auto w-full flex items-center justify-between border-b border-slate-800/80 pb-6">
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Radio className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              HookPilot
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                Phase 1 Active
              </span>
            </h1>
            <p className="text-xs text-slate-400">Webhook Reliability & Debugging Platform</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-lg">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
            Monorepo Online
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full my-auto py-12">
        <div className="max-w-2xl mb-12">
          <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-4">
            Reliable webhooks.
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-400">
              Zero dropped deliveries.
            </span>
          </h2>
          <p className="text-slate-400 text-base md:text-lg leading-relaxed">
            Ingest webhooks in &lt;50ms, schedule retries with exponential backoff & jitter, inspect
            payloads live, and debug directly on localhost via the HookPilot CLI tunnel.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 rounded-xl bg-indigo-500/10 text-indigo-400">
                <Server className="h-6 w-6" />
              </div>
              <span className="text-xs font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                Port 4000
              </span>
            </div>
            <h3 className="font-semibold text-white mb-1">Express Ingest API</h3>
            <p className="text-xs text-slate-400 mb-4">
              High-throughput ingest route, signature validation, rate limiting, and health probes.
            </p>
            <div className="text-[11px] font-mono text-slate-500 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              GET /health &bull; GET /ready
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 rounded-xl bg-violet-500/10 text-violet-400">
                <Cpu className="h-6 w-6" />
              </div>
              <span className="text-xs font-medium text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                BullMQ
              </span>
            </div>
            <h3 className="font-semibold text-white mb-1">Delivery Worker</h3>
            <p className="text-xs text-slate-400 mb-4">
              Decoupled delivery processor, SSRF guards, exponential backoff, DLQ, & circuit
              breaker.
            </p>
            <div className="text-[11px] font-mono text-slate-500 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              queue: delivery &bull; jittered retries
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 rounded-xl bg-amber-500/10 text-amber-400">
                <Database className="h-6 w-6" />
              </div>
              <span className="text-xs font-medium text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                Infra
              </span>
            </div>
            <h3 className="font-semibold text-white mb-1">State & Storage</h3>
            <p className="text-xs text-slate-400 mb-4">
              MongoDB event store with idempotency indexes and Redis for queues and pub/sub.
            </p>
            <div className="text-[11px] font-mono text-slate-500 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
              MongoDB 7.0 &bull; Redis 7.2 Alpine
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-slate-800/80 bg-slate-900/30 p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-indigo-400 shrink-0" />
            <div className="text-sm">
              <span className="font-semibold text-white">CLI Tunnel Ready:</span>{' '}
              <span className="font-mono text-xs text-slate-400">npx hookpilot listen 3000</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>Strict TypeScript &bull; Docker Ready</span>
          </div>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto w-full border-t border-slate-800/80 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
        <div>HookPilot &copy; 2026. Built with MERN + TypeScript + Redis + Docker.</div>
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-indigo-400" />
          <span>System Healthy</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
