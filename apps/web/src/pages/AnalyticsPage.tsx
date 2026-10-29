import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Zap,
  TrendingUp,
  AlertTriangle,
} from 'lucide-react';
import type { AnalyticsRange, EndpointResponse } from '@hookpilot/shared';
import { analyticsApi } from '../api/analytics.api.js';
import { endpointsApi } from '../api/endpoints.api.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { EmptyState } from '../components/common/EmptyState.js';

export function AnalyticsPage() {
  const { currentWorkspace } = useWorkspaceStore();
  const workspaceId = currentWorkspace?.id;

  const [range, setRange] = useState<AnalyticsRange>('24h');
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('');

  // Fetch endpoints for filter dropdown
  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await endpointsApi.listByWorkspace(workspaceId);
      return res.endpoints;
    },
    enabled: !!workspaceId,
  });

  // Fetch analytics data (cached 30s)
  const {
    data: analytics,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['analytics', workspaceId, range, selectedEndpointId],
    queryFn: async () => {
      if (!workspaceId) throw new Error('No workspace selected');
      return analyticsApi.getAnalytics(workspaceId, range, selectedEndpointId || undefined);
    },
    enabled: !!workspaceId,
    refetchInterval: 30000, // Poll every 30s matching Redis TTL
  });

  if (!workspaceId) {
    return (
      <div className="p-8">
        <EmptyState
          title="No workspace selected"
          description="Select or create a workspace to view webhook analytics."
        />
      </div>
    );
  }

  // Format chart timestamps based on range
  const formatXAxis = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      if (range === '1h') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (range === '7d') {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  };

  const latencyChartData = analytics?.latency
    ? [
        { name: 'p50 (Median)', latencyMs: analytics.latency.p50, fill: '#38bdf8' },
        { name: 'p95', latencyMs: analytics.latency.p95, fill: '#fbbf24' },
        { name: 'p99', latencyMs: analytics.latency.p99, fill: '#f87171' },
      ]
    : [];

  return (
    <div className="space-y-8">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-white/[0.08]">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight flex items-center gap-2.5 font-sans">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <TrendingUp className="w-5 h-5" />
            </div>
            <span>Analytics & Observability</span>
          </h1>
          <p className="text-zinc-400 text-xs mt-1.5 leading-relaxed">
            Real-time webhook ingestion metrics, delivery success rates, and latency percentiles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Endpoint Filter */}
          <select
            value={selectedEndpointId}
            onChange={(e) => setSelectedEndpointId(e.target.value)}
            className="px-3.5 py-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-200 text-xs font-medium focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
          >
            <option value="">All Endpoints</option>
            {endpointsData?.map((ep: EndpointResponse) => (
              <option key={ep.id} value={ep.id}>
                {ep.name} ({ep.slug})
              </option>
            ))}
          </select>

          {/* Range Selector */}
          <div className="flex bg-zinc-950/80 p-1 rounded-xl border border-white/[0.08] text-xs shadow-inner">
            {(['1h', '24h', '7d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-3 py-1 font-semibold rounded-lg transition-all font-mono text-[11px] ${
                  range === r
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => refetch()}
            className="p-2 text-zinc-400 hover:text-zinc-100 bg-zinc-900/60 border border-white/[0.08] rounded-xl hover:bg-white/[0.05] transition-all"
            title="Refresh metrics"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
        </div>
      </div>

      {error && <ErrorAlert message={(error as Error).message || 'Failed to load analytics'} />}

      {isLoading ? (
        <LoadingSpinner message="Calculating workspace analytics..." />
      ) : (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Ingested */}
            <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between text-zinc-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 font-mono">
                  Total Ingested
                </span>
                <Activity className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-3xl font-extrabold font-mono text-zinc-100">
                {analytics?.summary.total.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-zinc-500 mt-1.5">Inbound requests in past {range}</div>
            </div>

            {/* Delivered & Success Rate */}
            <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between text-zinc-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 font-mono">
                  Delivered
                </span>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-3xl font-extrabold font-mono text-emerald-400">
                {analytics?.summary.delivered.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-zinc-400 mt-1.5 flex items-center gap-1 font-mono">
                <span className="font-semibold text-emerald-400">
                  {analytics?.summary.successRate ?? 100}%
                </span>{' '}
                success rate
              </div>
            </div>

            {/* Failed & Dead */}
            <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between text-zinc-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 font-mono">
                  Failed / Dead
                </span>
                <XCircle className="w-4 h-4 text-rose-400" />
              </div>
              <div className="text-3xl font-extrabold font-mono text-rose-400">
                {analytics?.summary.failed.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-zinc-500 mt-1.5">Exhausted retry policies</div>
            </div>

            {/* p95 Latency */}
            <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between text-zinc-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 font-mono">
                  p95 Latency
                </span>
                <Clock className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-3xl font-extrabold font-mono text-zinc-100">
                {analytics?.latency.p95 ?? 0}
                <span className="text-sm text-zinc-400 font-normal ml-1">ms</span>
              </div>
              <div className="text-xs text-zinc-500 mt-1.5 font-mono">
                p50: {analytics?.latency.p50 ?? 0}ms · p99: {analytics?.latency.p99 ?? 0}ms
              </div>
            </div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Timeseries Area Chart (Spans 2 cols) */}
            <div className="lg:col-span-2 bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2 font-sans tracking-tight">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  Webhook Volume & Delivery Stream
                </h2>
                <span className="text-xs text-zinc-400 font-mono px-2 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06]">
                  Bucket: {range === '1h' ? '1m' : range === '7d' ? '1d' : '1h'}
                </span>
              </div>

              {analytics?.timeseries && analytics.timeseries.length > 0 ? (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={analytics.timeseries}
                      margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ffffff" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#ffffff" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorDelivered" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={formatXAxis}
                        stroke="#71717a"
                        fontSize={11}
                        fontFamily="JetBrains Mono"
                      />
                      <YAxis
                        stroke="#71717a"
                        fontSize={11}
                        fontFamily="JetBrains Mono"
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0c0c0e',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '12px',
                          color: '#f4f4f5',
                          fontSize: '12px',
                          fontFamily: 'JetBrains Mono',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                      <Area
                        type="monotone"
                        dataKey="total"
                        name="Ingested"
                        stroke="#ffffff"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorTotal)"
                      />
                      <Area
                        type="monotone"
                        dataKey="delivered"
                        name="Delivered"
                        stroke="#10b981"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorDelivered)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-72 flex items-center justify-center text-zinc-500 text-sm">
                  No webhook events recorded in this time range.
                </div>
              )}
            </div>

            {/* Latency Percentiles Bar Chart (1 col) */}
            <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2 font-sans tracking-tight">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Latency Percentiles
                </h2>
                <span className="text-xs text-zinc-400 font-mono">Duration (ms)</span>
              </div>

              {latencyChartData.some((d) => d.latencyMs > 0) ? (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={latencyChartData}
                      margin={{ top: 20, right: 10, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis
                        dataKey="name"
                        stroke="#71717a"
                        fontSize={11}
                        fontFamily="JetBrains Mono"
                      />
                      <YAxis stroke="#71717a" fontSize={11} fontFamily="JetBrains Mono" />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0c0c0e',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '12px',
                          color: '#f4f4f5',
                          fontSize: '12px',
                          fontFamily: 'JetBrains Mono',
                        }}
                        formatter={(val) => [`${val ?? 0} ms`, 'Latency']}
                      />
                      <Bar dataKey="latencyMs" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-72 flex flex-col items-center justify-center text-zinc-500 text-sm gap-2">
                  <Clock className="w-8 h-8 text-zinc-600" />
                  <span>No delivery attempts recorded yet</span>
                </div>
              )}
            </div>
          </div>

          {/* Top Failure Reasons */}
          <div className="bg-zinc-900/40 border border-white/[0.08] rounded-2xl p-6 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]">
            <h2 className="text-base font-semibold text-zinc-100 mb-5 flex items-center gap-2 font-sans tracking-tight">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              Top Delivery Failure Reasons
            </h2>

            {analytics?.topFailures && analytics.topFailures.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                <table className="w-full text-left text-sm text-zinc-300">
                  <thead className="text-xs uppercase bg-zinc-950/80 text-zinc-400 border-b border-white/[0.08] font-mono">
                    <tr>
                      <th className="px-5 py-3.5">Failure Reason / Status</th>
                      <th className="px-5 py-3.5 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {analytics.topFailures.map(
                      (failure: { reason: string; count: number }, idx: number) => (
                        <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-5 py-3.5 font-mono text-xs text-rose-300">
                            {failure.reason}
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold text-zinc-100">
                            {failure.count}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-8 text-center text-zinc-500 text-sm font-sans">
                🎉 No failure events recorded in the selected period!
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
