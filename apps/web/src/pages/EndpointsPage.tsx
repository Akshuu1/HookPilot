import { useState } from 'react';
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
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: CreateEndpointInput = {
      name: name.trim(),
      destinationUrl: destinationUrl.trim(),
      mode,
      rateLimitPerMin,
      signatureConfig: {
        provider,
        ...(secret ? { secret: secret.trim() } : {}),
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <span>Webhook Endpoints</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
              {endpoints.length}
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Receive webhooks at unique ingress URLs and forward them reliably to your destinations.
          </p>
        </div>

        <button
          onClick={openCreateModal}
          disabled={isViewer}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-lg shadow-indigo-500/20 transition-all disabled:opacity-40"
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
          icon={<Radio className="h-10 w-10 text-indigo-400" />}
          action={
            <button
              onClick={openCreateModal}
              disabled={isViewer}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-colors"
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
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 flex flex-col justify-between hover:border-slate-700 transition-all shadow-lg shadow-black/20"
              >
                <div>
                  {/* Top line: Name & Badges */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <h3 className="text-base font-bold text-white tracking-tight">{ep.name}</h3>
                      <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mt-0.5">
                        <Globe className="h-3.5 w-3.5 text-slate-500" />
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
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
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
                  <div className="mt-4 p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">
                        Inbound Ingest URL
                      </div>
                      <div className="text-xs font-mono text-indigo-300 truncate">{ingestUrl}</div>
                    </div>

                    <button
                      onClick={() => copyToClipboard(ingestUrl, 'url', ep.slug)}
                      className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors"
                      title="Copy Ingest URL"
                    >
                      {copiedSlug === ep.slug ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="text-emerald-400 text-[11px]">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span className="text-[11px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Metadata Chips */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-4 text-xs">
                    <div className="p-2 rounded-xl bg-slate-800/40 border border-slate-800/80">
                      <div className="text-[10px] text-slate-400 font-medium">Signature</div>
                      <div className="text-slate-200 font-semibold capitalize flex items-center gap-1 mt-0.5">
                        <Shield className="h-3 w-3 text-indigo-400" />
                        <span>{ep.signatureConfig.provider}</span>
                        {ep.signatureConfig.secretMasked && (
                          <span className="text-[10px] text-slate-400 font-mono">
                            ({ep.signatureConfig.secretMasked})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="p-2 rounded-xl bg-slate-800/40 border border-slate-800/80">
                      <div className="text-[10px] text-slate-400 font-medium">Retries</div>
                      <div className="text-slate-200 font-semibold flex items-center gap-1 mt-0.5">
                        <Zap className="h-3 w-3 text-amber-400" />
                        <span>{ep.retryPolicy.maxAttempts} max</span>
                      </div>
                    </div>

                    <div className="p-2 rounded-xl bg-slate-800/40 border border-slate-800/80 col-span-2 sm:col-span-1">
                      <div className="text-[10px] text-slate-400 font-medium">Rate Limit</div>
                      <div className="text-slate-200 font-semibold mt-0.5">
                        {ep.rateLimitPerMin} req/min
                      </div>
                    </div>
                  </div>
                </div>

                {/* Card Actions Footer */}
                <div className="flex items-center justify-between gap-2 mt-6 pt-4 border-t border-slate-800/80">
                  <button
                    onClick={() => copyToClipboard(curlSample, 'curl', ep.slug)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-950 text-slate-300 hover:text-white text-xs font-medium transition-colors"
                    title="Copy cURL command to send a test webhook"
                  >
                    <Terminal className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{copiedCurlSlug === ep.slug ? 'Copied cURL!' : 'Copy cURL Test'}</span>
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setRotatedSecret(null);
                        setRotatingEndpoint(ep);
                      }}
                      disabled={isViewer}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800 transition-colors disabled:opacity-30"
                      title="Rotate Webhook Secret"
                    >
                      <KeyRound className="h-4 w-4" />
                    </button>

                    <button
                      onClick={() => openEditModal(ep)}
                      disabled={isViewer}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-30"
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
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-30"
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
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Endpoint Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stripe Webhook Ingest"
              className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Destination URL (SSRF Protected)
            </label>
            <input
              type="url"
              required
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              placeholder="https://api.yourdomain.com/webhooks"
              className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Private, loopback and cloud-metadata addresses are strictly rejected.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as EndpointMode)}
                className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="forward">Forward (Deliver to destination)</option>
                <option value="capture-only">Capture-Only (Store without delivery)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Rate Limit (req / min)
              </label>
              <input
                type="number"
                min={1}
                max={10000}
                value={rateLimitPerMin}
                onChange={(e) => setRateLimitPerMin(parseInt(e.target.value, 10) || 60)}
                className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Signature Config */}
          <div className="pt-2 border-t border-slate-800/80">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-2">
              Signature Verification
            </h4>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as SignatureProvider)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                >
                  <option value="none">None</option>
                  <option value="stripe">Stripe</option>
                  <option value="github">GitHub</option>
                  <option value="generic">Generic HMAC-SHA256</option>
                </select>
              </div>

              {provider !== 'none' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Secret Key
                  </label>
                  <input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={editingEndpoint ? 'Leave empty to keep existing' : 'whsec_...'}
                    className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}
            </div>

            {provider === 'generic' && (
              <div className="mb-3">
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Custom Header Name
                </label>
                <input
                  type="text"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                  placeholder="X-Webhook-Signature"
                  className="w-full px-3 py-2 rounded-xl border border-slate-800 bg-slate-950 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {provider !== 'none' && (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={enforceSignature}
                  onChange={(e) => setEnforceSignature(e.target.checked)}
                  className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                />
                <span>Reject unverified webhooks with 401 Unauthorized</span>
              </label>
            )}
          </div>

          {/* Retry Policy */}
          <div className="pt-2 border-t border-slate-800/80">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-2">
              Exponential Backoff & Jitter
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Max Attempts
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(parseInt(e.target.value, 10) || 8)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-slate-100 text-xs focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Base Delay (ms)
                </label>
                <input
                  type="number"
                  min={100}
                  max={60000}
                  step={100}
                  value={baseDelayMs}
                  onChange={(e) => setBaseDelayMs(parseInt(e.target.value, 10) || 1000)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-slate-100 text-xs focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Max Delay (ms)
                </label>
                <input
                  type="number"
                  min={1000}
                  max={86400000}
                  step={1000}
                  value={maxDelayMs}
                  onChange={(e) => setMaxDelayMs(parseInt(e.target.value, 10) || 3600000)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-slate-100 text-xs focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending || !name.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
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
              <div className="font-mono text-xs text-white p-2.5 bg-slate-950 rounded-lg border border-emerald-500/30 break-all select-all flex items-center justify-between">
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
            <p className="text-sm text-slate-300">
              Rotating this secret will immediately invalidate the current verification key.
              Existing webhooks signed with the previous key may fail signature verification if
              enforced.
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              onClick={() => {
                setRotatingEndpoint(null);
                setRotatedSecret(null);
              }}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
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
