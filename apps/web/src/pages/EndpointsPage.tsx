import { useState } from 'react';
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
} from 'lucide-react';
import type {
  CreateEndpointInput,
  UpdateEndpointInput,
  EndpointResponse,
  SignatureProvider,
  EndpointMode,
} from '@hookpilot/shared';
import { endpointsApi } from '../api/endpoints.api.js';
import { API_URL } from '../api/client.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { EmptyState } from '../components/common/EmptyState.js';
import { Modal } from '../components/common/Modal.js';

export function EndpointsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspace } = useWorkspaceStore();

  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [copiedCurlSlug, setCopiedCurlSlug] = useState<string | null>(null);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointResponse | null>(null);
  const [rotatingEndpoint, setRotatingEndpoint] = useState<EndpointResponse | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<{ raw: string; masked: string } | null>(null);
  const [isReplacingSecret, setIsReplacingSecret] = useState(false);

  // Form states
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

  const workspaceId = currentWorkspace?.id;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await endpointsApi.listByWorkspace(workspaceId);
      return res.endpoints;
    },
    enabled: !!workspaceId,
  });

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

  const handleSubmit = (e: React.FormEvent) => {
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

  const copyToClipboard = async (text: string, type: 'url' | 'curl', slug: string) => {
    await navigator.clipboard.writeText(text);
    if (type === 'url') {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 2000);
    } else {
      setCopiedCurlSlug(slug);
      setTimeout(() => setCopiedCurlSlug(null), 2000);
    }
  };

  const isViewer = currentWorkspace?.role === 'viewer';
  const endpoints = data || [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100 tracking-tight flex items-center gap-2.5 font-sans">
            <span>Webhook Endpoints</span>
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-300 border border-white/[0.08] font-mono">
              {endpoints.length}
            </span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
            Receive webhooks at unique ingress URLs and forward them reliably to your internal
            destinations.
          </p>
        </div>

        <button
          onClick={openCreateModal}
          disabled={isViewer}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98] disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
          <span>New Endpoint</span>
        </button>
      </div>

      {/* Content */}
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
                      <div className="text-xs font-mono text-emerald-400 truncate">{ingestUrl}</div>
                    </div>

                    <button
                      onClick={() => copyToClipboard(ingestUrl, 'url', ep.slug)}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors border border-white/[0.06]"
                      title="Copy Ingest URL"
                    >
                      {copiedSlug === ep.slug ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="text-emerald-400 text-[11px] font-medium">Copied</span>
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
                    <span>{copiedCurlSlug === ep.slug ? 'Copied cURL!' : 'Copy cURL Test'}</span>
                  </button>

                  <div className="flex items-center gap-1">
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

      {/* Create / Edit Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={closeModal}
        title={editingEndpoint ? 'Edit Webhook Endpoint' : 'Create Webhook Endpoint'}
        description="Configure target forwarding URL, signature verification, and retry backoff."
        maxWidth="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
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
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
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
              className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors font-mono text-xs"
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
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
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
                className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
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
                  className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-colors"
                >
                  <option value="none">None</option>
                  <option value="stripe">Stripe</option>
                  <option value="github">GitHub</option>
                  <option value="generic">Generic HMAC-SHA256</option>
                </select>
              </div>

              {provider !== 'none' && (
                <div>
                  {editingEndpoint &&
                  (editingEndpoint.signatureConfig.secretConfigured ||
                    editingEndpoint.signatureConfig.secretMasked) &&
                  !isReplacingSecret ? (
                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1">
                        Secret Key
                      </label>
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-xs">
                        <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                          <Shield className="h-3.5 w-3.5" />
                          <span>
                            Secret configured
                            {editingEndpoint.signatureConfig.secretLast4
                              ? ` (••••${editingEndpoint.signatureConfig.secretLast4})`
                              : editingEndpoint.signatureConfig.secretMasked
                                ? ` (${editingEndpoint.signatureConfig.secretMasked})`
                                : ''}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setIsReplacingSecret(true)}
                          className="text-[11px] font-semibold text-zinc-200 hover:text-white underline ml-2"
                        >
                          Replace secret
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-xs font-semibold text-zinc-400">
                          {editingEndpoint &&
                          (editingEndpoint.signatureConfig.secretConfigured ||
                            editingEndpoint.signatureConfig.secretMasked)
                            ? 'New Secret Key'
                            : 'Secret Key'}
                        </label>
                        {editingEndpoint &&
                          (editingEndpoint.signatureConfig.secretConfigured ||
                            editingEndpoint.signatureConfig.secretMasked) && (
                            <button
                              type="button"
                              onClick={() => {
                                setIsReplacingSecret(false);
                                setSecret('');
                              }}
                              className="text-[11px] text-zinc-400 hover:text-white"
                            >
                              Keep existing
                            </button>
                          )}
                      </div>
                      <input
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder={
                          editingEndpoint &&
                          (editingEndpoint.signatureConfig.secretConfigured ||
                            editingEndpoint.signatureConfig.secretMasked)
                            ? 'Enter new secret...'
                            : 'whsec_...'
                        }
                        className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 font-mono transition-colors"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Provider change notification */}
            {editingEndpoint &&
              provider !== 'none' &&
              !editingEndpoint.signatureConfig.secretConfigured &&
              !editingEndpoint.signatureConfig.secretMasked && (
                <div className="mb-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-sans">
                  Provider requires a signing secret. Please provide a secret key above.
                </div>
              )}

            {editingEndpoint &&
              provider !== 'none' &&
              provider !== editingEndpoint.signatureConfig.provider &&
              (editingEndpoint.signatureConfig.secretConfigured ||
                editingEndpoint.signatureConfig.secretMasked) &&
              !isReplacingSecret && (
                <div className="mb-3 px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-[11px] text-zinc-400 font-sans">
                  Provider changed to {provider}. Your existing secret is preserved. Click
                  &quot;Replace secret&quot; to provide a new one.
                </div>
              )}

            {provider === 'generic' && (
              <div className="mb-3">
                <label className="block text-xs font-semibold text-zinc-400 mb-1">
                  Custom Header Name
                </label>
                <input
                  type="text"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                  placeholder="X-Webhook-Signature"
                  className="w-full px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-100 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 font-mono text-xs transition-colors"
                />
              </div>
            )}

            {provider !== 'none' && (
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={enforceSignature}
                  onChange={(e) => setEnforceSignature(e.target.checked)}
                  className="rounded border-white/[0.1] bg-zinc-950 text-emerald-500 focus:ring-0"
                />
                <span>Reject unverified webhooks with 401 Unauthorized</span>
              </label>
            )}
          </div>

          {/* Retry Policy */}
          <div className="pt-2 border-t border-white/[0.08]">
            <h4 className="text-xs font-bold text-zinc-200 uppercase tracking-wider mb-2">
              Exponential Backoff & Jitter
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-zinc-400 mb-1">
                  Max Attempts
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(parseInt(e.target.value, 10) || 8)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs focus:outline-none focus:border-white/30 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-zinc-400 mb-1">
                  Base Delay (ms)
                </label>
                <input
                  type="number"
                  min={100}
                  max={60000}
                  step={100}
                  value={baseDelayMs}
                  onChange={(e) => setBaseDelayMs(parseInt(e.target.value, 10) || 1000)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs focus:outline-none focus:border-white/30 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-zinc-400 mb-1">
                  Max Delay (ms)
                </label>
                <input
                  type="number"
                  min={1000}
                  max={86400000}
                  step={1000}
                  value={maxDelayMs}
                  onChange={(e) => setMaxDelayMs(parseInt(e.target.value, 10) || 3600000)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-zinc-950 text-zinc-100 text-xs focus:outline-none focus:border-white/30 font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
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

      {/* Secret Rotation Modal */}
      <Modal
        isOpen={!!rotatingEndpoint}
        onClose={() => {
          setRotatingEndpoint(null);
          setRotatedSecret(null);
        }}
        title="Rotate Endpoint Secret"
        description={`Generate a new cryptographic signature verification secret for "${rotatingEndpoint?.name}".`}
      >
        <div className="space-y-4">
          {rotatedSecret ? (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
              <div className="text-xs font-semibold text-emerald-200 mb-1">
                New Secret Generated (Save it now!)
              </div>
              <div className="font-mono text-xs text-white p-2.5 bg-zinc-950 rounded-lg border border-emerald-500/30 break-all select-all flex items-center justify-between">
                <span>{rotatedSecret.raw}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(rotatedSecret.raw)}
                  className="ml-2 text-xs text-emerald-400 hover:text-white"
                >
                  Copy
                </button>
              </div>
              <p className="text-[11px] text-emerald-400/80 mt-2">
                This raw secret will never be shown again. Future requests will preview as{' '}
                {rotatedSecret.masked}.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-300">
              Rotating this secret will immediately invalidate the current verification key.
              Existing webhooks signed with the previous key may fail signature verification if
              enforced.
            </p>
          )}

          {rotateMutation.error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {(rotateMutation.error as AxiosError<{ error?: { message?: string } }>)?.response
                ?.data?.error?.message ||
                (rotateMutation.error as Error)?.message ||
                'Failed to rotate secret.'}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/[0.08]">
            <button
              onClick={() => {
                setRotatingEndpoint(null);
                setRotatedSecret(null);
              }}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
            >
              {rotatedSecret ? 'Close' : 'Cancel'}
            </button>
            {!rotatedSecret && (
              <button
                onClick={() => {
                  if (rotatingEndpoint) {
                    rotateMutation.mutate(rotatingEndpoint.id);
                  }
                }}
                disabled={rotateMutation.isPending}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
              >
                {rotateMutation.isPending ? 'Rotating...' : 'Confirm Secret Rotation'}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
