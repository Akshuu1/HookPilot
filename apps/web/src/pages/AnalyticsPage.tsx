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
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-brand-400" />
            Analytics & Observability
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Real-time webhook ingestion metrics, delivery success rates, and latency percentiles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Endpoint Filter */}
          <select
            value={selectedEndpointId}
            onChange={(e) => setSelectedEndpointId(e.target.value)}
            className="px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900 text-slate-300 text-xs font-medium focus:outline-none focus:border-brand-500"
          >
            <option value="">All Endpoints</option>
            {endpointsData?.map((ep: EndpointResponse) => (
              <option key={ep.id} value={ep.id}>
                {ep.name} ({ep.slug})
              </option>
            ))}
          </select>

          {/* Range Selector */}
          <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
            {(['1h', '24h', '7d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-3 py-1 font-semibold rounded-lg transition-all ${
                  range === r
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
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
            className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-xl hover:bg-slate-850 transition"
            title="Refresh metrics"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-brand-400' : ''}`} />
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
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Total Ingested
                </span>
                <Activity className="w-5 h-5 text-brand-400" />
              </div>
              <div className="text-3xl font-extrabold text-white">
                {analytics?.summary.total.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-1">Inbound requests in past {range}</div>
            </div>

            {/* Delivered & Success Rate */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">Delivered</span>
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="text-3xl font-extrabold text-emerald-400">
                {analytics?.summary.delivered.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                <span className="font-semibold text-emerald-400">
                  {analytics?.summary.successRate ?? 100}%
                </span>{' '}
                success rate
              </div>
            </div>

            {/* Failed & Dead */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Failed / Dead
                </span>
                <XCircle className="w-5 h-5 text-rose-400" />
              </div>
              <div className="text-3xl font-extrabold text-rose-400">
                {analytics?.summary.failed.toLocaleString() ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-1">Permanent or exhausting retries</div>
            </div>

            {/* p95 Latency */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">p95 Latency</span>
                <Clock className="w-5 h-5 text-amber-400" />
              </div>
              <div className="text-3xl font-extrabold text-white">
                {analytics?.latency.p95 ?? 0}
                <span className="text-lg text-slate-400 font-normal ml-1">ms</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                p50: {analytics?.latency.p50 ?? 0}ms · p99: {analytics?.latency.p99 ?? 0}ms
              </div>
            </div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Timeseries Area Chart (Spans 2 cols) */}
            <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-brand-400" />
                  Webhook Volume & Delivery
                </h2>
                <span className="text-xs text-slate-500">
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
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorDelivered" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={formatXAxis}
                        stroke="#64748b"
                        fontSize={11}
                      />
                      <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: '12px',
                          color: '#f8fafc',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                      <Area
                        type="monotone"
                        dataKey="total"
                        name="Ingested"
                        stroke="#818cf8"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorTotal)"
                      />
                      <Area
                        type="monotone"
                        dataKey="delivered"
                        name="Delivered"
                        stroke="#34d399"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorDelivered)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-72 flex items-center justify-center text-slate-500 text-sm">
                  No webhook events recorded in this time range.
                </div>
              )}
            </div>

            {/* Latency Percentiles Bar Chart (1 col) */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Latency Percentiles
                </h2>
                <span className="text-xs text-slate-500">Duration (ms)</span>
              </div>

              {latencyChartData.some((d) => d.latencyMs > 0) ? (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={latencyChartData}
                      margin={{ top: 20, right: 10, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: '12px',
                          color: '#f8fafc',
                          fontSize: '12px',
                        }}
                        formatter={(val) => [`${val ?? 0} ms`, 'Latency']}
                      />
                      <Bar dataKey="latencyMs" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-72 flex flex-col items-center justify-center text-slate-500 text-sm gap-2">
                  <Clock className="w-8 h-8 text-slate-600" />
                  <span>No delivery attempts recorded yet</span>
                </div>
              )}
            </div>
          </div>

          {/* Top Failure Reasons */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              Top Delivery Failure Reasons
            </h2>

            {analytics?.topFailures && analytics.topFailures.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="text-xs uppercase bg-slate-950 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="px-4 py-3 rounded-l-lg">Failure Reason / Status</th>
                      <th className="px-4 py-3 text-right rounded-r-lg">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {analytics.topFailures.map((failure, idx) => (
                      <tr key={idx} className="hover:bg-slate-850/50">
                        <td className="px-4 py-3 font-mono text-xs text-rose-300">
                          {failure.reason}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-white">
                          {failure.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-8 text-center text-slate-500 text-sm">
                🎉 No failure events recorded in the selected period!
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
