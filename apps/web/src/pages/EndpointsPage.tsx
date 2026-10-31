import React, { useState } from 'react';
import type { AxiosError } from 'axios';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Copy,
  Check,
  Globe,
  Radio,
  Terminal,
  KeyRound,
  Trash2,
  Edit,
  Shield,
  Zap,
  Send,
  Sliders,
  Lock,
  AlertTriangle,
} from 'lucide-react';
import type {
  CreateEndpointInput,
  UpdateEndpointInput,
  EndpointResponse,
  SignatureProvider,
  EndpointMode,
  DestinationResponse,
  CreateDestinationInput,
  UpdateDestinationInput,
  FilterRule,
} from '@hookpilot/shared';
import { endpointsApi } from '../api/endpoints.api.js';
import { destinationsApi } from '../api/destinations.api.js';
import { eventsApi } from '../api/events.api.js';
import { analyticsApi } from '../api/analytics.api.js';
import { API_URL } from '../api/client.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { EmptyState } from '../components/common/EmptyState.js';
import { Modal } from '../components/common/Modal.js';
import { FilterBuilder } from '../components/filters/FilterBuilder.js';

function getFilterSummary(filter: FilterRule | null | undefined): string {
  if (!filter || !filter.conditions || filter.conditions.length === 0) {
    return 'All events (no filter)';
  }
  const count = filter.conditions.length;
  const combinator = (filter.combinator || 'and').toUpperCase();
  const first = filter.conditions[0];
  if (first && 'field' in first) {
    const valStr = first.value !== undefined ? ` ${JSON.stringify(first.value)}` : '';
    const desc = `${first.field} ${first.op}${valStr}`;
    return count > 1 ? `[${combinator}] ${desc} (+${count - 1} more)` : `[${combinator}] ${desc}`;
  }
  return `[${combinator}] ${count} condition${count === 1 ? '' : 's'}`;
}

export function EndpointsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspace } = useWorkspaceStore();
  const workspaceId = currentWorkspace?.id;

  // Active Tab: 'endpoints' vs 'destinations'
  const [activeTab, setActiveTab] = useState<'endpoints' | 'destinations'>('endpoints');

  // Copy states
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [copiedCurlSlug, setCopiedCurlSlug] = useState<string | null>(null);
  const [copiedDestUrl, setCopiedDestUrl] = useState<string | null>(null);

  // ----------------------------------------------------------------------
  // Endpoint Modals & State
  // ----------------------------------------------------------------------
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointResponse | null>(null);
  const [rotatingEndpoint, setRotatingEndpoint] = useState<EndpointResponse | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<{ raw: string; masked: string } | null>(null);
  const [isReplacingSecret, setIsReplacingSecret] = useState(false);

  // Endpoint Form state
  const [name, setName] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [mode, setMode] = useState<EndpointMode>('forward');
  const [rateLimitPerMin, setRateLimitPerMin] = useState(60);
  const [provider, setProvider] = useState<SignatureProvider>('none');
  const [secret, setSecret] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [enforceSignature, setEnforceSignature] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState(8);
  const [baseDelayMs, setBaseDelayMs] = useState(1000);
  const [maxDelayMs, setMaxDelayMs] = useState(3600000);

  // ----------------------------------------------------------------------
  // Destination Modals & State
  // ----------------------------------------------------------------------
  const [selectedDestEndpointId, setSelectedDestEndpointId] = useState<string>('');
  const [isDestModalOpen, setIsDestModalOpen] = useState(false);
  const [editingDestination, setEditingDestination] = useState<DestinationResponse | null>(null);
  const [deletingDestination, setDeletingDestination] = useState<DestinationResponse | null>(null);

  // Destination Form state
  const [destName, setDestName] = useState('');
  const [destUrl, setDestUrl] = useState('');
  const [destIsActive, setDestIsActive] = useState(true);
  const [destRateLimit, setDestRateLimit] = useState<number | null>(null);
  const [destHeaders, setDestHeaders] = useState<
    Array<{ name: string; value: string; isMasked?: boolean }>
  >([]);
  const [destSecret, setDestSecret] = useState('');
  const [isReplacingDestSecret, setIsReplacingDestSecret] = useState(false);
  const [destOverrideRetry, setDestOverrideRetry] = useState(false);
  const [destMaxAttempts, setDestMaxAttempts] = useState(5);
  const [destBaseDelay, setDestBaseDelay] = useState(1000);
  const [destMaxDelay, setDestMaxDelay] = useState(3600000);
  const [destFilter, setDestFilter] = useState<FilterRule | null>(null);

  // ----------------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------------
  const {
    data: endpointsData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await endpointsApi.listByWorkspace(workspaceId);
      return res.endpoints;
    },
    enabled: !!workspaceId,
  });

  const endpoints = endpointsData || [];

  // Default selected endpoint for destinations tab
  const activeEndpointId = selectedDestEndpointId || (endpoints.length > 0 ? endpoints[0]!.id : '');

  // Query Destinations for active endpoint
  const {
    data: destinationsData,
    isLoading: isDestinationsLoading,
    error: destinationsError,
    refetch: refetchDestinations,
  } = useQuery({
    queryKey: ['destinations', activeEndpointId],
    queryFn: async () => {
      if (!activeEndpointId) return [];
      const res = await destinationsApi.listByEndpoint(activeEndpointId);
      return res.data;
    },
    enabled: !!activeEndpointId,
  });

  const destinations = destinationsData || [];

  // Query Recent Events for Filter Testing
  const { data: recentEventsData } = useQuery({
    queryKey: ['recent-events', activeEndpointId],
    queryFn: async () => {
      if (!activeEndpointId) return [];
      const res = await eventsApi.listEndpointEvents(activeEndpointId, { limit: 10 });
      return res.events;
    },
    enabled: !!activeEndpointId && activeTab === 'destinations',
  });

  // Query 24h Endpoint Success Rate Analytics
  const { data: analyticsSummary } = useQuery({
    queryKey: ['analytics-summary-24h', workspaceId, activeEndpointId],
    queryFn: async () => {
      if (!workspaceId) return null;
      return analyticsApi.getAnalytics(workspaceId, '24h', activeEndpointId || undefined);
    },
    enabled: !!workspaceId && !!activeEndpointId,
  });

  // ----------------------------------------------------------------------
  // Mutations: Endpoints
  // ----------------------------------------------------------------------
  const createMutation = useMutation({
    mutationFn: async (input: CreateEndpointInput) => {
      if (!workspaceId) throw new Error('No workspace selected');
      return endpointsApi.create(workspaceId, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['endpoints', workspaceId] });
      closeModal();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateEndpointInput }) => {
      return endpointsApi.update(id, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['endpoints', workspaceId] });
      closeModal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return endpointsApi.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['endpoints', workspaceId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: async (id: string) => {
      return endpointsApi.rotateSecret(id);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['endpoints', workspaceId] });
      setRotatedSecret({ raw: res.secret, masked: res.secretMasked });
    },
  });

  // ----------------------------------------------------------------------
  // Mutations: Destinations
  // ----------------------------------------------------------------------
  const createDestMutation = useMutation({
    mutationFn: async (input: CreateDestinationInput) => {
      if (!activeEndpointId) throw new Error('No endpoint selected');
      return destinationsApi.create(activeEndpointId, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations', activeEndpointId] });
      closeDestModal();
    },
  });

  const updateDestMutation = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateDestinationInput }) => {
      return destinationsApi.update(id, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations', activeEndpointId] });
      closeDestModal();
    },
  });

  const deleteDestMutation = useMutation({
    mutationFn: async (id: string) => {
      return destinationsApi.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations', activeEndpointId] });
      setDeletingDestination(null);
    },
  });

  // ----------------------------------------------------------------------
  // Modal Handlers: Endpoints
  // ----------------------------------------------------------------------
  const openCreateModal = () => {
    setEditingEndpoint(null);
    setIsReplacingSecret(true);
    setName('');
    setDestinationUrl('https://httpbin.org/post');
    setMode('forward');
    setRateLimitPerMin(60);
    setProvider('none');
    setSecret('');
    setHeaderName('');
    setEnforceSignature(false);
    setMaxAttempts(8);
    setBaseDelayMs(1000);
    setMaxDelayMs(3600000);
    setIsCreateOpen(true);
  };

  const openEditModal = (ep: EndpointResponse) => {
    setEditingEndpoint(ep);
    setIsReplacingSecret(false);
    setName(ep.name);
    setDestinationUrl(ep.destinationUrl);
    setMode(ep.mode);
    setRateLimitPerMin(ep.rateLimitPerMin);
    setProvider(ep.signatureConfig.provider);
    setSecret('');
    setHeaderName(ep.signatureConfig.headerName || '');
    setEnforceSignature(ep.signatureConfig.enforce || false);
    setMaxAttempts(ep.retryPolicy.maxAttempts);
    setBaseDelayMs(ep.retryPolicy.baseDelayMs);
    setMaxDelayMs(ep.retryPolicy.maxDelayMs);
    setIsCreateOpen(true);
  };

  const closeModal = () => {
    setIsCreateOpen(false);
    setEditingEndpoint(null);
    setIsReplacingSecret(false);
  };

  const handleEndpointSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hasSecretToSubmit = (!editingEndpoint || isReplacingSecret) && secret.length > 0;
    const payload: CreateEndpointInput = {
      name: name.trim(),
      destinationUrl: destinationUrl.trim(),
      mode,
      rateLimitPerMin,
      signatureConfig: {
        provider,
        ...(hasSecretToSubmit ? { secret } : {}),
        ...(headerName ? { headerName: headerName.trim() } : {}),
        enforce: enforceSignature,
      },
      retryPolicy: {
        maxAttempts,
        baseDelayMs,
        maxDelayMs,
      },
    };

    if (editingEndpoint) {
      updateMutation.mutate({ id: editingEndpoint.id, input: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  // ----------------------------------------------------------------------
  // Modal Handlers: Destinations
  // ----------------------------------------------------------------------
  const openCreateDestModal = () => {
    setEditingDestination(null);
    setDestName('');
    setDestUrl('https://httpbin.org/post');
    setDestIsActive(true);
    setDestRateLimit(null);
    setDestHeaders([]);
    setDestSecret('');
    setIsReplacingDestSecret(true);
    setDestOverrideRetry(false);
    setDestMaxAttempts(5);
    setDestBaseDelay(1000);
    setDestMaxDelay(3600000);
    setDestFilter(null);
    setIsDestModalOpen(true);
  };

  const openEditDestModal = (dest: DestinationResponse) => {
    setEditingDestination(dest);
    setDestName(dest.name);
    setDestUrl(dest.url);
    setDestIsActive(dest.isActive);
    setDestRateLimit(dest.rateLimitPerMin ?? null);
    setDestHeaders(
      (dest.customHeaders || []).map((h) => ({
        name: h.name,
        value: '••••••••',
        isMasked: true,
      })),
    );
    setDestSecret('');
    setIsReplacingDestSecret(!dest.outboundSecretConfigured);
    if (dest.retryPolicy) {
      setDestOverrideRetry(true);
      setDestMaxAttempts(dest.retryPolicy.maxAttempts);
      setDestBaseDelay(dest.retryPolicy.baseDelayMs);
      setDestMaxDelay(dest.retryPolicy.maxDelayMs);
    } else {
      setDestOverrideRetry(false);
      setDestMaxAttempts(5);
      setDestBaseDelay(1000);
      setDestMaxDelay(3600000);
    }
    setDestFilter(dest.filter || null);
    setIsDestModalOpen(true);
  };

  const closeDestModal = () => {
    setIsDestModalOpen(false);
    setEditingDestination(null);
    setIsReplacingDestSecret(false);
  };

  const handleDestinationSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeEndpointId) return;

    // Filter valid headers
    const validHeaders = destHeaders
      .filter((h) => h.name.trim().length > 0 && (!h.isMasked || !editingDestination))
      .map((h) => ({ name: h.name.trim(), value: h.value }));

    const retryPolicy = destOverrideRetry
      ? {
          maxAttempts: destMaxAttempts,
          baseDelayMs: destBaseDelay,
          maxDelayMs: destMaxDelay,
        }
      : undefined;

    if (editingDestination) {
      const updatePayload: UpdateDestinationInput = {
        name: destName.trim(),
        url: destUrl.trim(),
        isActive: destIsActive,
        rateLimitPerMin: destRateLimit,
        filter: destFilter,
        retryPolicy,
        ...(validHeaders.length > 0 ? { customHeaders: validHeaders } : {}),
        ...(isReplacingDestSecret && destSecret.trim().length > 0
          ? { outboundSecret: destSecret.trim() }
          : {}),
      };
      updateDestMutation.mutate({ id: editingDestination.id, input: updatePayload });
    } else {
      const createPayload: CreateDestinationInput = {
        name: destName.trim(),
        url: destUrl.trim(),
        isActive: destIsActive,
        rateLimitPerMin: destRateLimit ?? undefined,
        filter: destFilter,
        retryPolicy,
        customHeaders: validHeaders.length > 0 ? validHeaders : undefined,
        outboundSecret: destSecret.trim().length > 0 ? destSecret.trim() : undefined,
      };
      createDestMutation.mutate(createPayload);
    }
  };

  const copyToClipboard = async (text: string, type: 'url' | 'curl' | 'dest', slug: string) => {
    await navigator.clipboard.writeText(text);
    if (type === 'url') {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 2000);
    } else if (type === 'curl') {
      setCopiedCurlSlug(slug);
      setTimeout(() => setCopiedCurlSlug(null), 2000);
    } else {
      setCopiedDestUrl(slug);
      setTimeout(() => setCopiedDestUrl(null), 2000);
    }
  };

  const isViewer = currentWorkspace?.role === 'viewer';
  const activeEndpoint = endpoints.find((ep) => ep.id === activeEndpointId);
  const successRate24h = analyticsSummary?.summary?.successRate ?? 100;

  return (
    <div className="space-y-8">
      {/* Header and Page Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-zinc-100 tracking-tight font-sans">
              Webhook Delivery Network
            </h2>
            <div className="flex bg-zinc-950 p-1 rounded-xl border border-white/[0.08] text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('endpoints')}
                className={`px-3 py-1 rounded-lg font-semibold transition-all ${
                  activeTab === 'endpoints'
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Endpoints ({endpoints.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('destinations')}
                className={`px-3 py-1 rounded-lg font-semibold transition-all flex items-center gap-1.5 ${
                  activeTab === 'destinations'
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <span>Destinations</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 font-mono">
                  Fan-Out
                </span>
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
            {activeTab === 'endpoints'
              ? 'Receive webhooks at unique ingress URLs and inspect traffic.'
              : 'Fan-out incoming webhooks to multiple destinations with independent retries and rule-based filters.'}
          </p>
        </div>

        {activeTab === 'endpoints' ? (
          <button
            onClick={openCreateModal}
            disabled={isViewer}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-40 shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>New Endpoint</span>
          </button>
        ) : (
          <button
            onClick={openCreateDestModal}
            disabled={isViewer || endpoints.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-40 shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>New Destination</span>
          </button>
        )}
      </div>

      {/* =================================================================== */}
      {/* TAB 1: ENDPOINTS OVERVIEW                                           */}
      {/* =================================================================== */}
      {activeTab === 'endpoints' && (
        <>
          {isLoading ? (
            <LoadingSpinner message="Loading endpoints..." />
          ) : error ? (
            <ErrorAlert message="Failed to load endpoints." onRetry={() => refetch()} />
          ) : endpoints.length === 0 ? (
            <EmptyState
              title="No webhook endpoints created yet"
              description="Create your first endpoint to get a dedicated public URL for receiving and forwarding webhook traffic."
              icon={<Radio className="h-10 w-10 text-emerald-400" />}
              action={
                <button
                  onClick={openCreateModal}
                  disabled={isViewer}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Endpoint</span>
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {endpoints.map((ep) => {
                const ingestUrl = `${API_URL}/in/${ep.slug}`;
                const curlSample = `curl -X POST ${ingestUrl} \\\n  -H "Content-Type: application/json" \\\n  -d '{"event":"order.placed","amount":99.00}'`;

                return (
                  <div
                    key={ep.id}
                    className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 flex flex-col justify-between hover:border-white/[0.16] transition-all shadow-xl backdrop-blur-sm ring-1 ring-white/[0.03]"
                  >
                    <div>
                      {/* Top line: Name & Badges */}
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-base font-bold text-zinc-100 tracking-tight font-sans">
                            {ep.name}
                          </h3>
                          <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono mt-1">
                            <Globe className="h-3.5 w-3.5 text-zinc-500" />
                            <span
                              className="truncate max-w-[260px] sm:max-w-md"
                              title={ep.destinationUrl}
                            >
                              {ep.destinationUrl}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`text-[11px] font-mono uppercase tracking-wider font-semibold px-2.5 py-0.5 rounded-full border ${
                              ep.mode === 'forward'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            }`}
                          >
                            {ep.mode}
                          </span>
                        </div>
                      </div>

                      {/* Ingest URL with Copy button */}
                      <div className="mt-4 p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08] flex items-center justify-between gap-2 shadow-inner">
                        <div className="min-w-0">
                          <div className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-0.5">
                            Inbound Ingest URL
                          </div>
                          <div className="text-xs font-mono text-emerald-400 truncate">
                            {ingestUrl}
                          </div>
                        </div>

                        <button
                          onClick={() => copyToClipboard(ingestUrl, 'url', ep.slug)}
                          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors border border-white/[0.06]"
                          title="Copy Ingest URL"
                        >
                          {copiedSlug === ep.slug ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                              <span className="text-emerald-400 text-[11px] font-medium">
                                Copied
                              </span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5 text-zinc-400" />
                              <span className="text-[11px]">Copy</span>
                            </>
                          )}
                        </button>
                      </div>

                      {/* Metadata Chips */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-4 text-xs">
                        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                          <div className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">
                            Signature
                          </div>
                          <div className="text-zinc-200 font-semibold capitalize flex items-center gap-1.5 mt-1">
                            <Shield className="h-3.5 w-3.5 text-emerald-400" />
                            <span>{ep.signatureConfig.provider}</span>
                            {ep.signatureConfig.secretMasked && (
                              <span className="text-[10px] text-zinc-500 font-mono">
                                ({ep.signatureConfig.secretMasked})
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                          <div className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">
                            Retries
                          </div>
                          <div className="text-zinc-200 font-semibold flex items-center gap-1.5 mt-1">
                            <Zap className="h-3.5 w-3.5 text-amber-400" />
                            <span>{ep.retryPolicy.maxAttempts} max</span>
                          </div>
                        </div>

                        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] col-span-2 sm:col-span-1">
                          <div className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider">
                            Rate Limit
                          </div>
                          <div className="text-zinc-200 font-semibold mt-1">
                            {ep.rateLimitPerMin} req/min
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Card Actions Footer */}
                    <div className="flex items-center justify-between gap-2 mt-6 pt-4 border-t border-white/[0.08]">
                      <button
                        onClick={() => copyToClipboard(curlSample, 'curl', ep.slug)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] hover:border-white/[0.16] bg-zinc-950 text-zinc-300 hover:text-white text-xs font-medium transition-colors font-mono"
                        title="Copy cURL command to send a test webhook"
                      >
                        <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                        <span>
                          {copiedCurlSlug === ep.slug ? 'Copied cURL!' : 'Copy cURL Test'}
                        </span>
                      </button>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDestEndpointId(ep.id);
                            setActiveTab('destinations');
                          }}
                          className="px-2.5 py-1 rounded-lg text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/20 text-xs font-semibold flex items-center gap-1 transition-colors"
                          title="Manage Fan-out Destinations"
                        >
                          <Send className="h-3.5 w-3.5" />
                          <span>Destinations</span>
                        </button>

                        <button
                          onClick={() => {
                            setRotatedSecret(null);
                            setRotatingEndpoint(ep);
                          }}
                          disabled={isViewer}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-amber-400 hover:bg-zinc-800/60 transition-colors disabled:opacity-30"
                          title="Rotate Webhook Secret"
                        >
                          <KeyRound className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => openEditModal(ep)}
                          disabled={isViewer}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors disabled:opacity-30"
                          title="Edit Endpoint"
                        >
                          <Edit className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => {
                            if (confirm(`Delete endpoint "${ep.name}"?`)) {
                              deleteMutation.mutate(ep.id);
                            }
                          }}
                          disabled={isViewer}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-30"
                          title="Delete Endpoint"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* =================================================================== */}
      {/* TAB 2: FAN-OUT DESTINATIONS                                         */}
      {/* =================================================================== */}
      {activeTab === 'destinations' && (
        <div className="space-y-6">
          {/* Endpoint Selector Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-zinc-900/40 border border-white/[0.08]">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Endpoint:
              </span>
              <select
                value={activeEndpointId}
                onChange={(e) => setSelectedDestEndpointId(e.target.value)}
                className="px-3.5 py-1.5 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-semibold focus:outline-none focus:border-white/30"
              >
                {endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name} ({ep.slug})
                  </option>
                ))}
              </select>
            </div>

            {activeEndpoint && (
              <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
                <span>Ingress:</span>
                <span className="text-emerald-400">
                  {API_URL}/in/{activeEndpoint.slug}
                </span>
              </div>
            )}
          </div>

          {/* Destinations List */}
          {isDestinationsLoading ? (
            <LoadingSpinner message="Loading destinations..." />
          ) : destinationsError ? (
            <ErrorAlert
              message="Failed to load destinations."
              onRetry={() => refetchDestinations()}
            />
          ) : destinations.length === 0 ? (
            <EmptyState
              title="No fan-out destinations configured"
              description="Add your first destination to start forwarding webhooks to one or more endpoints with rule-based filtering."
              icon={<Send className="h-10 w-10 text-emerald-400" />}
              action={
                <button
                  onClick={openCreateDestModal}
                  disabled={isViewer || endpoints.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" />
                  <span>Add Destination</span>
                </button>
              }
            />
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-950/80 border-b border-white/[0.08] text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                    <tr>
                      <th className="px-5 py-3.5">Destination</th>
                      <th className="px-5 py-3.5">Target URL</th>
                      <th className="px-5 py-3.5">Rule Filter Summary</th>
                      <th className="px-5 py-3.5">24h Success Rate</th>
                      <th className="px-5 py-3.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {destinations.map((dest) => (
                      <tr key={dest.id} className="hover:bg-white/[0.02] transition-colors">
                        {/* Name with Status Dot */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ring-2 shrink-0 ${
                                dest.isActive
                                  ? 'bg-emerald-400 ring-emerald-400/20'
                                  : 'bg-zinc-600 ring-zinc-600/20'
                              }`}
                              title={dest.isActive ? 'Active' : 'Inactive'}
                            />
                            <div>
                              <div className="font-bold text-zinc-100 flex items-center gap-2">
                                <span>{dest.name}</span>
                                {dest.outboundSecretConfigured && (
                                  <span title="Outbound secret configured">
                                    <Lock className="h-3 w-3 text-emerald-400" />
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                                {dest.isActive ? 'Active' : 'Disabled'}
                                {dest.rateLimitPerMin ? ` • ${dest.rateLimitPerMin} req/m` : ''}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Truncated URL with Copy */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2 font-mono text-zinc-300">
                            <span className="truncate max-w-[220px]" title={dest.url}>
                              {dest.url}
                            </span>
                            <button
                              onClick={() => copyToClipboard(dest.url, 'dest', dest.id)}
                              className="p-1 hover:text-white text-zinc-500 transition-colors"
                              title="Copy Destination URL"
                            >
                              {copiedDestUrl === dest.id ? (
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>

                        {/* Filter Summary */}
                        <td className="px-5 py-4">
                          <span
                            className={`inline-block px-2.5 py-1 rounded-lg text-[11px] font-mono border ${
                              dest.filter &&
                              dest.filter.conditions &&
                              dest.filter.conditions.length > 0
                                ? 'bg-purple-500/10 text-purple-300 border-purple-500/20'
                                : 'bg-zinc-800/60 text-zinc-400 border-white/[0.06]'
                            }`}
                          >
                            {getFilterSummary(dest.filter)}
                          </span>
                        </td>

                        {/* Success Rate 24h */}
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            {successRate24h}%
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openEditDestModal(dest)}
                              disabled={isViewer}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-30"
                              title="Edit Destination & Filter"
                            >
                              <Edit className="h-4 w-4" />
                            </button>

                            <button
                              onClick={() => setDeletingDestination(dest)}
                              disabled={isViewer}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-30"
                              title="Delete Destination"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT ENDPOINT                                       */}
      {/* =================================================================== */}
      <Modal
        isOpen={isCreateOpen}
        onClose={closeModal}
        title={editingEndpoint ? 'Edit Webhook Endpoint' : 'Create Webhook Endpoint'}
        description="Configure target forwarding URL, signature verification, and retry backoff."
        maxWidth="lg"
      >
        <form onSubmit={handleEndpointSubmit} className="space-y-4">
          {(createMutation.error || updateMutation.error) && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {(createMutation.error as AxiosError<{ error?: { message?: string } }>)?.response
                ?.data?.error?.message ||
                (updateMutation.error as AxiosError<{ error?: { message?: string } }>)?.response
                  ?.data?.error?.message ||
                (createMutation.error as Error)?.message ||
                (updateMutation.error as Error)?.message ||
                'An error occurred while saving the endpoint.'}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Endpoint Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stripe Webhook Ingest"
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Destination URL (SSRF Protected)
            </label>
            <input
              type="url"
              required
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              placeholder="https://api.yourdomain.com/webhooks"
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 font-mono text-xs"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              Private, loopback and cloud-metadata addresses are strictly rejected.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as EndpointMode)}
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
              >
                <option value="forward">Forward (Deliver to destination)</option>
                <option value="capture-only">Capture-Only (Store without delivery)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Rate Limit (req / min)
              </label>
              <input
                type="number"
                min={1}
                max={10000}
                value={rateLimitPerMin}
                onChange={(e) => setRateLimitPerMin(parseInt(e.target.value, 10) || 60)}
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
              />
            </div>
          </div>

          {/* Signature Config */}
          <div className="pt-2 border-t border-white/[0.08]">
            <h4 className="text-xs font-bold text-zinc-200 uppercase tracking-wider mb-2">
              Signature Verification
            </h4>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as SignatureProvider)}
                  className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
                >
                  <option value="none">None</option>
                  <option value="stripe">Stripe</option>
                  <option value="github">GitHub</option>
                  <option value="generic">Generic HMAC-SHA256</option>
                </select>
              </div>

              {provider === 'generic' && (
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">
                    Signature Header Name
                  </label>
                  <input
                    type="text"
                    required
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    placeholder="X-Hub-Signature-256"
                    className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
                  />
                </div>
              )}
            </div>

            {provider !== 'none' && (
              <div className="space-y-3">
                {editingEndpoint &&
                !isReplacingSecret &&
                editingEndpoint.signatureConfig.secretConfigured ? (
                  <div className="p-3 rounded-xl bg-zinc-900/60 border border-white/[0.08] flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4 text-emerald-400" />
                      <span className="text-zinc-200">
                        Secret configured:{' '}
                        {editingEndpoint.signatureConfig.secretMasked || '••••••••'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsReplacingSecret(true)}
                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold"
                    >
                      Replace Secret
                    </button>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-1">
                      Signing Secret
                    </label>
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="Enter provider webhook secret..."
                      className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 font-mono text-xs"
                    />
                  </div>
                )}

                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={enforceSignature}
                    onChange={(e) => setEnforceSignature(e.target.checked)}
                    className="rounded border-white/20 bg-zinc-900 text-emerald-500 focus:ring-emerald-500/20"
                  />
                  <span>Reject unverified webhooks with HTTP 401 Unauthorized</span>
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending || !name.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-white text-zinc-950 hover:bg-zinc-200 shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {createMutation.isPending || updateMutation.isPending
                ? 'Saving...'
                : editingEndpoint
                  ? 'Update Endpoint'
                  : 'Create Endpoint'}
            </button>
          </div>
        </form>
      </Modal>

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT DESTINATION                                    */}
      {/* =================================================================== */}
      <Modal
        isOpen={isDestModalOpen}
        onClose={closeDestModal}
        title={editingDestination ? 'Edit Fan-Out Destination' : 'Add Fan-Out Destination'}
        description="Target destination URL, custom headers, outbound signature, and rule-based filter."
        maxWidth="2xl"
      >
        <form onSubmit={handleDestinationSubmit} className="space-y-5">
          {(createDestMutation.error || updateDestMutation.error) && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {(createDestMutation.error as AxiosError<{ error?: { message?: string } }>)?.response
                ?.data?.error?.message ||
                (updateDestMutation.error as AxiosError<{ error?: { message?: string } }>)?.response
                  ?.data?.error?.message ||
                'Failed to save destination.'}
            </div>
          )}

          {/* Destination Name & URL */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Destination Name
              </label>
              <input
                type="text"
                required
                value={destName}
                onChange={(e) => setDestName(e.target.value)}
                placeholder="e.g. Analytics Webhook Service"
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Target URL (SSRF Protected)
              </label>
              <input
                type="url"
                required
                value={destUrl}
                onChange={(e) => setDestUrl(e.target.value)}
                placeholder="https://api.yourdomain.com/hooks"
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 font-mono text-xs"
              />
            </div>
          </div>

          {/* Active Status & Rate Limit */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08]">
              <input
                type="checkbox"
                id="destIsActive"
                checked={destIsActive}
                onChange={(e) => setDestIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-zinc-900 text-emerald-500 focus:ring-emerald-500/20"
              />
              <label
                htmlFor="destIsActive"
                className="text-xs font-semibold text-zinc-200 cursor-pointer"
              >
                Destination Active (Deliver Webhooks)
              </label>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">
                Rate Limit Override (req / min, optional)
              </label>
              <input
                type="number"
                min={1}
                max={100000}
                value={destRateLimit ?? ''}
                onChange={(e) =>
                  setDestRateLimit(e.target.value ? parseInt(e.target.value, 10) : null)
                }
                placeholder="Inherit from endpoint default"
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs focus:outline-none focus:border-white/30"
              />
            </div>
          </div>

          {/* Custom Headers */}
          <div className="space-y-2 pt-2 border-t border-white/[0.08]">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider">
                Custom Headers
              </label>
              <button
                type="button"
                onClick={() => setDestHeaders([...destHeaders, { name: '', value: '' }])}
                className="text-[11px] text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                <span>Add Header</span>
              </button>
            </div>

            {destHeaders.length === 0 ? (
              <p className="text-[11px] text-zinc-500 italic">No custom HTTP headers specified.</p>
            ) : (
              <div className="space-y-2">
                {destHeaders.map((hdr, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Header-Name"
                      value={hdr.name}
                      onChange={(e) => {
                        const updated = [...destHeaders];
                        updated[idx]!.name = e.target.value;
                        setDestHeaders(updated);
                      }}
                      className="w-1/2 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-mono"
                    />
                    <input
                      type={hdr.isMasked ? 'text' : 'password'}
                      placeholder={hdr.isMasked ? '••••••••' : 'Header Value'}
                      value={hdr.value}
                      disabled={hdr.isMasked}
                      onChange={(e) => {
                        const updated = [...destHeaders];
                        updated[idx]!.value = e.target.value;
                        setDestHeaders(updated);
                      }}
                      className="w-1/2 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-mono disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setDestHeaders(destHeaders.filter((_, i) => i !== idx))}
                      className="p-1.5 text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Outbound Signing Secret */}
          <div className="space-y-2 pt-2 border-t border-white/[0.08]">
            <label className="block text-xs font-bold text-zinc-300 uppercase tracking-wider">
              Outbound HMAC Signing Secret
            </label>
            {editingDestination?.outboundSecretConfigured && !isReplacingDestSecret ? (
              <div className="p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08] flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-emerald-400" />
                  <span className="text-zinc-200">Outbound signing secret configured</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsReplacingDestSecret(true)}
                  className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold"
                >
                  Replace Secret
                </button>
              </div>
            ) : (
              <input
                type="password"
                value={destSecret}
                onChange={(e) => setDestSecret(e.target.value)}
                placeholder="Optional HMAC secret for signing forwarded requests..."
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs font-mono focus:outline-none focus:border-white/30"
              />
            )}
          </div>

          {/* Retry Policy Override */}
          <div className="space-y-2 pt-2 border-t border-white/[0.08]">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="h-3.5 w-3.5 text-amber-400" />
                <span>Retry Policy Override</span>
              </label>
              <button
                type="button"
                onClick={() => setDestOverrideRetry(!destOverrideRetry)}
                className="text-xs font-semibold text-emerald-400"
              >
                {destOverrideRetry ? 'Use Endpoint Defaults' : 'Override Retries'}
              </button>
            </div>

            {destOverrideRetry && (
              <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08] text-xs">
                <div>
                  <label className="block text-zinc-400 mb-1">Max Attempts</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={destMaxAttempts}
                    onChange={(e) => setDestMaxAttempts(parseInt(e.target.value, 10) || 5)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-900 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">Base Delay (ms)</label>
                  <input
                    type="number"
                    min={100}
                    value={destBaseDelay}
                    onChange={(e) => setDestBaseDelay(parseInt(e.target.value, 10) || 1000)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-900 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">Max Delay (ms)</label>
                  <input
                    type="number"
                    min={1000}
                    value={destMaxDelay}
                    onChange={(e) => setDestMaxDelay(parseInt(e.target.value, 10) || 3600000)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-900 text-zinc-100"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Embedded Filter Builder */}
          <div className="pt-2 border-t border-white/[0.08]">
            <FilterBuilder
              value={destFilter}
              onChange={setDestFilter}
              endpointId={activeEndpointId}
              destinationId={editingDestination?.id}
              recentEvents={recentEventsData}
            />
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={closeDestModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                createDestMutation.isPending || updateDestMutation.isPending || !destName.trim()
              }
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-white text-zinc-950 hover:bg-zinc-200 shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {createDestMutation.isPending || updateDestMutation.isPending
                ? 'Saving...'
                : editingDestination
                  ? 'Update Destination'
                  : 'Add Destination'}
            </button>
          </div>
        </form>
      </Modal>

      {/* =================================================================== */}
      {/* MODAL: DELETE DESTINATION CONFIRMATION                              */}
      {/* =================================================================== */}
      <Modal
        isOpen={!!deletingDestination}
        onClose={() => setDeletingDestination(null)}
        title="Delete Fan-Out Destination"
        description="Destinations can be removed at any time."
      >
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <span className="font-bold">Pending deliveries will be cancelled:</span>
              <p className="mt-1 leading-relaxed text-amber-200/90">
                Deleting destination{' '}
                <strong className="text-white">"{deletingDestination?.name}"</strong> will
                immediately cancel all scheduled retries and pending delivery jobs.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={() => setDeletingDestination(null)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Keep Destination
            </button>
            <button
              type="button"
              onClick={() =>
                deletingDestination && deleteDestMutation.mutate(deletingDestination.id)
              }
              disabled={deleteDestMutation.isPending}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {deleteDestMutation.isPending ? 'Deleting...' : 'Delete Destination'}
            </button>
          </div>
        </div>
      </Modal>
      {/* =================================================================== */}
      {/* MODAL: ROTATE SECRET                                                */}
      {/* =================================================================== */}
      <Modal
        isOpen={!!rotatingEndpoint}
        onClose={() => {
          setRotatingEndpoint(null);
          setRotatedSecret(null);
        }}
        title="Rotate Ingress Secret"
        description="Generate a new HMAC secret for inbound verification."
      >
        <div className="space-y-4">
          {rotatedSecret ? (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                New secret generated! Copy it now; it won't be displayed in full again.
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-white/[0.08] font-mono text-xs text-emerald-400 break-all select-all">
                {rotatedSecret.raw}
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-300">
              Are you sure you want to rotate the secret for endpoint{' '}
              <strong className="text-white">"{rotatingEndpoint?.name}"</strong>? Webhooks signed
              with the old secret will fail verification immediately.
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/[0.08]">
            <button
              onClick={() => {
                setRotatingEndpoint(null);
                setRotatedSecret(null);
              }}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              {rotatedSecret ? 'Close' : 'Cancel'}
            </button>
            {!rotatedSecret && rotatingEndpoint && (
              <button
                onClick={() => rotateMutation.mutate(rotatingEndpoint.id)}
                disabled={rotateMutation.isPending}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold transition-all disabled:opacity-50"
              >
                {rotateMutation.isPending ? 'Rotating...' : 'Rotate Secret'}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
