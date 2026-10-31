import { useState, useEffect, useRef, useMemo } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Search,
  RotateCcw,
  RefreshCw,
  Check,
  CheckCircle2,
  Clock,
  ShieldCheck,
  ShieldAlert,
  Terminal,
  Activity,
  Layers,
} from 'lucide-react';
import type {
  EventResponse,
  EventStatus,
  EventPubSubMessage,
  PaginatedEventsResponse,
  DeliveryAttemptResponse,
} from '@hookpilot/shared';
import { eventsApi } from '../api/events.api.js';
import { endpointsApi } from '../api/endpoints.api.js';
import { API_URL } from '../api/client.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import { realtimeSocket } from '../realtime/socket.js';
import { StatusBadge } from '../components/common/StatusBadge.js';
import { Drawer } from '../components/common/Drawer.js';
import { CodeBlock } from '../components/common/CodeBlock.js';
import { LoadingSpinner } from '../components/common/LoadingSpinner.js';
import { ErrorAlert } from '../components/common/ErrorAlert.js';
import { EmptyState } from '../components/common/EmptyState.js';
import { Modal } from '../components/common/Modal.js';

export function EventInspectorPage() {
  const queryClient = useQueryClient();
  const { currentWorkspace } = useWorkspaceStore();
  const workspaceId = currentWorkspace?.id;

  // Selected filters
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<EventStatus | 'all'>('all');
  const [signatureFilter, setSignatureFilter] = useState<'all' | 'valid' | 'invalid'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Selected event for detail drawer
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Bulk replay modal
  const [isBulkReplayOpen, setIsBulkReplayOpen] = useState(false);
  const [bulkReplayResult, setBulkReplayResult] = useState<{ count: number } | null>(null);

  // Copy states
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch endpoints in current workspace
  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await endpointsApi.listByWorkspace(workspaceId);
      return res.endpoints;
    },
    enabled: !!workspaceId,
  });

  const endpoints = endpointsData || [];

  // Default to first endpoint if none selected
  useEffect(() => {
    if (!selectedEndpointId && endpoints.length > 0) {
      setSelectedEndpointId(endpoints[0]!.id);
    }
  }, [endpoints, selectedEndpointId]);

  // Infinite query for events
  const queryKey = useMemo(
    () => ['events', selectedEndpointId, statusFilter, signatureFilter, debouncedSearch],
    [selectedEndpointId, statusFilter, signatureFilter, debouncedSearch],
  );

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam = undefined }) => {
      if (!selectedEndpointId) {
        return { events: [], nextCursor: null, hasNextPage: false };
      }

      return eventsApi.listEndpointEvents(selectedEndpointId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        signatureValid: signatureFilter === 'all' ? undefined : signatureFilter === 'valid',
        q: debouncedSearch || undefined,
        limit: 30,
        cursor: pageParam as string | undefined,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: PaginatedEventsResponse) =>
      lastPage.hasNextPage && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!selectedEndpointId,
  });

  // Realtime Socket.IO live updates listener
  useEffect(() => {
    const unsubCreated = realtimeSocket.onEventCreated((msg: EventPubSubMessage) => {
      // If event belongs to the selected endpoint, update the cache live!
      if (!selectedEndpointId || msg.endpointId === selectedEndpointId) {
        queryClient.setQueryData(
          queryKey,
          (oldData: InfiniteData<PaginatedEventsResponse> | undefined) => {
            if (!oldData || !oldData.pages || oldData.pages.length === 0) return oldData;

            // Synthesize new event row
            const newEvent: EventResponse = {
              id: msg.eventId,
              workspaceId: msg.workspaceId,
              endpointId: msg.endpointId || '',
              receivedAt: msg.timestamp || new Date().toISOString(),
              method: 'POST',
              headers: {},
              rawBody: '',
              bodySize: 0,
              contentType: 'application/json',
              sourceIp: 'incoming',
              signatureValid: true,
              idempotencyKey: '',
              status: (msg.status as any) || 'pending',
              attemptCount: msg.attemptCount ?? 0,
              replayCount: 0,
              lastAttemptAt: null,
              nextAttemptAt: null,
            };

            const newFirstPage = {
              ...oldData.pages[0],
              events: [newEvent, ...oldData.pages[0].events],
            };

            return {
              ...oldData,
              pages: [newFirstPage, ...oldData.pages.slice(1)],
            };
          },
        );
      }
    });

    const unsubUpdate = realtimeSocket.onEventUpdate((msg: EventPubSubMessage) => {
      queryClient.setQueryData(
        queryKey,
        (oldData: InfiniteData<PaginatedEventsResponse> | undefined) => {
          if (!oldData || !oldData.pages) return oldData;

          return {
            ...oldData,
            pages: oldData.pages.map((page: PaginatedEventsResponse) => ({
              ...page,
              events: page.events.map((evt: EventResponse) =>
                evt.id === msg.eventId
                  ? {
                      ...evt,
                      status: msg.status,
                      attemptCount: msg.attemptCount,
                    }
                  : evt,
              ),
            })),
          };
        },
      );

      // If drawer is currently viewing this updated event, invalidate it
      if (selectedEventId === msg.eventId) {
        queryClient.invalidateQueries({ queryKey: ['event', msg.eventId] });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdate();
    };
  }, [selectedEndpointId, queryKey, queryClient, selectedEventId]);

  // Flatten events across pages
  const allEvents = useMemo(() => {
    return data?.pages.flatMap((page) => page.events) || [];
  }, [data]);

  // Virtualizer for table rows
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: allEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  // Infinite scroll trigger
  useEffect(() => {
    const virtualItems = rowVirtualizer.getVirtualItems();
    if (!virtualItems.length) return;

    const lastItem = virtualItems[virtualItems.length - 1];
    if (lastItem && lastItem.index >= allEvents.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [
    rowVirtualizer.getVirtualItems(),
    allEvents.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  // Drawer event query
  const { data: drawerEvent, isLoading: isDrawerLoading } = useQuery({
    queryKey: ['event', selectedEventId],
    queryFn: () => eventsApi.getById(selectedEventId!),
    enabled: !!selectedEventId,
  });

  // Single Replay Mutation
  const replayMutation = useMutation({
    mutationFn: (eventId: string) => eventsApi.replay(eventId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      if (selectedEventId) {
        queryClient.invalidateQueries({ queryKey: ['event', selectedEventId] });
      }
    },
  });

  // Bulk Replay Mutation
  const bulkReplayMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace');
      return eventsApi.bulkReplay({
        workspaceId,
        endpointId: selectedEndpointId || undefined,
        status: statusFilter === 'failed' || statusFilter === 'dead' ? statusFilter : undefined,
      });
    },
    onSuccess: (res) => {
      setBulkReplayResult({ count: res.replayedCount });
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const isViewer = currentWorkspace?.role === 'viewer';

  const copyAsCurl = async (event: EventResponse) => {
    const currentEp = endpoints.find((e) => e.id === event.endpointId);
    const ingestUrl = `${API_URL}/in/${currentEp?.slug || 'your-slug'}`;

    const headersList = Object.entries(event.headers || {})
      .map(([k, v]) => `  -H "${k}: ${v}" \\`)
      .join('\n');

    const curlCommand = `curl -X ${event.method || 'POST'} ${ingestUrl} \\\n${headersList ? headersList + '\n' : ''}  -d '${event.rawBody || ''}'`;

    await navigator.clipboard.writeText(curlCommand);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2000);
  };

  return (
    <div className="space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100 tracking-tight flex items-center gap-2.5 font-sans">
            <span>Live Event Inspector</span>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live Socket
            </span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
            Realtime webhook stream, virtualized inspection, payload debugging, and replay controls.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setBulkReplayResult(null);
              setIsBulkReplayOpen(true);
            }}
            disabled={isViewer || allEvents.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900/60 hover:bg-zinc-800 text-zinc-200 hover:text-white font-semibold text-xs border border-white/[0.08] transition-all disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5 text-emerald-400" />
            <span>Bulk Replay</span>
          </button>

          <button
            onClick={() => refetch()}
            className="p-2 rounded-xl border border-white/[0.08] bg-zinc-900/60 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-all"
            title="Refresh stream"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Control Bar: Endpoint selector, Search, and Filters */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
        {/* Endpoint Selector */}
        <div className="w-full lg:w-64 shrink-0">
          <select
            value={selectedEndpointId}
            onChange={(e) => setSelectedEndpointId(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-200 text-xs font-medium focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
          >
            {endpoints.length === 0 ? (
              <option value="">No endpoints available</option>
            ) : (
              endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name} ({ep.slug})
                </option>
              ))
            )}
          </select>
        </div>

        {/* Search input */}
        <div className="relative flex-1">
          <Search className="h-4 w-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search payload text, order IDs, headers (q)..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-100 placeholder:text-zinc-500 text-xs focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition-all font-mono"
          />
        </div>

        {/* Status Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0 font-mono text-xs">
          {(['all', 'pending', 'delivering', 'delivered', 'failed', 'dead'] as const).map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold capitalize shrink-0 transition-all border ${
                statusFilter === st
                  ? 'bg-white text-zinc-950 border-white shadow-sm font-bold'
                  : 'bg-zinc-900/60 text-zinc-400 border-white/[0.08] hover:text-zinc-100 hover:border-white/[0.14]'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        {/* Signature Filter */}
        <div className="shrink-0">
          <select
            value={signatureFilter}
            onChange={(e) => setSignatureFilter(e.target.value as 'all' | 'valid' | 'invalid')}
            className="px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-zinc-900/60 text-zinc-300 text-xs font-medium focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
          >
            <option value="all">All Signatures</option>
            <option value="valid">Verified Only</option>
            <option value="invalid">Invalid Only</option>
          </select>
        </div>
      </div>

      {/* Main Table / Inspector Area */}
      {endpoints.length === 0 ? (
        <EmptyState
          title="No endpoints created yet"
          description="Go to Endpoints and create your first endpoint to start streaming and inspecting webhooks."
        />
      ) : isLoading ? (
        <LoadingSpinner message="Connecting to event stream..." />
      ) : isError ? (
        <ErrorAlert
          message={error instanceof Error ? error.message : 'Failed to fetch events.'}
          onRetry={() => refetch()}
        />
      ) : allEvents.length === 0 ? (
        <EmptyState
          title="No webhooks received yet"
          description={
            debouncedSearch || statusFilter !== 'all'
              ? 'No webhooks match your active search or filter criteria.'
              : 'Send a webhook using the cURL command on the Endpoints page. It will appear live here in under a second.'
          }
          icon={<Activity className="h-10 w-10 text-indigo-400 animate-pulse" />}
        />
      ) : (
        <div className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 backdrop-blur-sm overflow-hidden shadow-2xl ring-1 ring-white/[0.03]">
          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 px-6 py-3.5 border-b border-white/[0.08] bg-zinc-950/80 text-[11px] font-semibold text-zinc-400 uppercase tracking-widest font-mono">
            <div className="col-span-2">Status</div>
            <div className="col-span-1">Method</div>
            <div className="col-span-4">Event ID / Idempotency</div>
            <div className="col-span-3">Received At</div>
            <div className="col-span-2 text-right">Attempts / Replay</div>
          </div>

          {/* Virtualized Table Scroll Container */}
          <div ref={parentRef} className="h-[600px] overflow-y-auto divide-y divide-white/[0.04]">
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const event = allEvents[virtualRow.index];
                if (!event) return null;

                const isSelected = selectedEventId === event.id;
                const formattedDate = new Date(event.receivedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });

                return (
                  <div
                    key={event.id}
                    onClick={() => setSelectedEventId(event.id)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className={`grid grid-cols-12 gap-4 px-6 items-center text-xs cursor-pointer transition-all duration-150 ${
                      isSelected
                        ? 'bg-white/[0.06] border-l-2 border-emerald-400'
                        : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    {/* Status */}
                    <div className="col-span-2 flex items-center">
                      <StatusBadge status={event.status} size="sm" />
                    </div>

                    {/* Method */}
                    <div className="col-span-1 font-mono font-bold text-zinc-300">
                      {event.method}
                    </div>

                    {/* ID & Idempotency Key */}
                    <div className="col-span-4 truncate">
                      <span className="font-mono text-zinc-100 font-semibold mr-2">{event.id}</span>
                      {event.idempotencyKey && (
                        <span className="text-[10px] font-mono text-zinc-400 truncate">
                          ({event.idempotencyKey})
                        </span>
                      )}
                    </div>

                    {/* Timestamp */}
                    <div className="col-span-3 text-zinc-400 flex items-center gap-1.5 truncate font-mono text-[11px]">
                      <Clock className="h-3 w-3 text-zinc-500" />
                      <span>{formattedDate}</span>
                      <span className="text-[10px] text-zinc-500">
                        ({new Date(event.receivedAt).toLocaleDateString()})
                      </span>
                    </div>

                    {/* Attempts / Replay count */}
                    <div className="col-span-2 text-right font-mono text-zinc-300 flex items-center justify-end gap-2">
                      <span className="px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.06] text-[11px] text-zinc-300">
                        {event.attemptCount} att
                      </span>
                      {event.replayCount > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-semibold">
                          +{event.replayCount}r
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {isFetchingNextPage && (
              <div className="py-3 text-center text-xs text-zinc-400 bg-zinc-950/50 font-mono">
                Loading more events...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Event Detail Drawer */}
      <Drawer
        isOpen={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        title={
          drawerEvent ? (
            <div className="flex items-center gap-3">
              <span className="font-mono">{drawerEvent.id}</span>
              <StatusBadge status={drawerEvent.status} size="sm" />
            </div>
          ) : (
            'Event Details'
          )
        }
        subtitle={
          drawerEvent
            ? `Received on ${new Date(drawerEvent.receivedAt).toLocaleString()}`
            : undefined
        }
        footer={
          drawerEvent && (
            <>
              <button
                onClick={() => copyAsCurl(drawerEvent)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/[0.08] bg-zinc-950 text-zinc-300 hover:text-white text-xs font-semibold transition-colors"
              >
                {copiedCurl ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied cURL!</span>
                  </>
                ) : (
                  <>
                    <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copy as cURL</span>
                  </>
                )}
              </button>

              <button
                onClick={() => replayMutation.mutate(drawerEvent.id)}
                disabled={isViewer || replayMutation.isPending}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white text-zinc-950 hover:bg-zinc-200 font-semibold text-xs shadow-sm transition-all active:scale-[0.98] disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>{replayMutation.isPending ? 'Replaying...' : 'Replay Webhook'}</span>
              </button>
            </>
          )
        }
      >
        {isDrawerLoading ? (
          <LoadingSpinner message="Fetching event details and attempts..." />
        ) : !drawerEvent ? (
          <ErrorAlert message="Event not found." />
        ) : (
          <div className="space-y-6 text-sm">
            {/* Overview Grid */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08]">
                <span className="text-zinc-500 block mb-1">Signature Status</span>
                {drawerEvent.signatureValid ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Verified Valid
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-rose-400 font-semibold">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Invalid / Untrusted
                  </span>
                )}
              </div>

              <div className="p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08]">
                <span className="text-zinc-500 block mb-1">Idempotency Key</span>
                <span className="font-mono text-zinc-200 truncate block">
                  {drawerEvent.idempotencyKey || 'Auto-generated hash'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08]">
                <span className="text-zinc-500 block mb-1">Source IP</span>
                <span className="font-mono text-zinc-200">{drawerEvent.sourceIp}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950/80 border border-white/[0.08]">
                <span className="text-zinc-500 block mb-1">Replay Count</span>
                <span className="font-mono text-zinc-200 font-semibold">
                  {drawerEvent.replayCount}
                </span>
              </div>
            </div>

            {/* Inbound Headers */}
            <div>
              <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-emerald-400" />
                <span>Inbound HTTP Headers</span>
              </h4>
              <CodeBlock
                code={JSON.stringify(drawerEvent.headers, null, 2)}
                language="headers (json)"
                maxHeight="max-h-56"
              />
            </div>

            {/* Raw Payload Body */}
            <div>
              <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                <span>Payload Body ({drawerEvent.bodySize} bytes)</span>
              </h4>
              <CodeBlock
                code={(() => {
                  try {
                    return JSON.stringify(JSON.parse(drawerEvent.rawBody), null, 2);
                  } catch {
                    return drawerEvent.rawBody;
                  }
                })()}
                language="body"
                maxHeight="max-h-72"
              />
            </div>

            {/* Delivery Attempts Timeline */}
            <div>
              <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-emerald-400" />
                <span>Delivery Attempts Timeline ({drawerEvent.attempts?.length || 0})</span>
              </h4>

              {!drawerEvent.attempts || drawerEvent.attempts.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-white/[0.08] text-center text-xs text-zinc-500">
                  No delivery attempts recorded yet. Status: {drawerEvent.status}.
                </div>
              ) : (
                <div className="space-y-3">
                  {drawerEvent.attempts.map((att: DeliveryAttemptResponse) => (
                    <div
                      key={att.id}
                      className="rounded-xl border border-white/[0.08] bg-zinc-950/80 p-4 space-y-2.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-zinc-200">
                            Attempt #{att.attemptNumber}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              att.success
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                            }`}
                          >
                            HTTP {att.responseStatus}
                          </span>
                        </div>
                        <span className="text-zinc-400 font-mono text-[11px]">
                          {att.durationMs}ms
                        </span>
                      </div>

                      {att.error && (
                        <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2 rounded-lg font-mono">
                          {att.error}
                        </div>
                      )}

                      {att.responseBodySnippet && (
                        <div>
                          <span className="text-[10px] font-semibold text-zinc-500 uppercase block mb-1">
                            Response Snippet
                          </span>
                          <pre className="text-[11px] font-mono text-zinc-400 bg-zinc-900/60 p-2.5 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-24">
                            {att.responseBodySnippet}
                          </pre>
                        </div>
                      )}

                      <div className="text-[10px] text-zinc-500">
                        Started at {new Date(att.startedAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* Bulk Replay Modal */}
      <Modal
        isOpen={isBulkReplayOpen}
        onClose={() => {
          setIsBulkReplayOpen(false);
          setBulkReplayResult(null);
        }}
        title="Confirm Bulk Replay"
        description="Replay failed and dead-lettered webhooks back to destination endpoints."
      >
        <div className="space-y-4">
          {bulkReplayResult ? (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
              <div className="flex items-center gap-2 font-bold mb-1">
                <CheckCircle2 className="h-4 w-4" />
                <span>Bulk Replay Enqueued!</span>
              </div>
              <p className="text-xs text-emerald-400/90">
                Successfully re-enqueued {bulkReplayResult.count} webhooks in batches of 50. Status
                will update live in the table.
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-300 leading-relaxed">
              This will reset up to 500 failed or dead webhooks in workspace{' '}
              <strong className="text-white">"{currentWorkspace?.name}"</strong> back to{' '}
              <span className="text-amber-400 font-semibold">'pending'</span> and dispatch new
              BullMQ delivery jobs in batches of 50.
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/[0.08]">
            <button
              onClick={() => {
                setIsBulkReplayOpen(false);
                setBulkReplayResult(null);
              }}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              {bulkReplayResult ? 'Done' : 'Cancel'}
            </button>
            {!bulkReplayResult && (
              <button
                onClick={() => bulkReplayMutation.mutate()}
                disabled={bulkReplayMutation.isPending}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-white text-zinc-950 hover:bg-zinc-200 shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {bulkReplayMutation.isPending ? 'Enqueuing...' : 'Confirm Bulk Replay'}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
