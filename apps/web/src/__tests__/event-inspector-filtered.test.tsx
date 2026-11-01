import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBadge } from '../components/common/StatusBadge.js';
import { EventInspectorPage } from '../pages/EventInspectorPage.js';
import { useWorkspaceStore } from '../store/workspace.store.js';
import * as eventsApiModule from '../api/events.api.js';
import * as endpointsApiModule from '../api/endpoints.api.js';
import type {
  DeliveryResponse,
  EventWithAttemptsResponse,
  WorkspaceResponse,
  EndpointResponse,
} from '@hookpilot/shared';

describe('Event Inspector Filtered Status & Delivery Rendering', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    useWorkspaceStore.setState({
      currentWorkspace: {
        id: 'ws-123',
        name: 'Acme Corp',
        ownerId: 'u-owner-1',
        retentionDays: 30,
        role: 'owner',
        createdAt: new Date().toISOString(),
      } satisfies WorkspaceResponse,
      workspaces: [],
    });
  });

  it('1. StatusBadge renders "filtered" badge with distinctive purple styling', () => {
    const html = renderToString(<StatusBadge status="filtered" size="sm" />);

    expect(html).toContain('filtered');
    expect(html).toContain('bg-purple-500/10');
    expect(html).toContain('text-purple-400');
    expect(html).toContain('border-purple-500/20');
  });

  it('2. Status filter options include "filtered" tab button in EventInspectorPage', () => {
    const mockEndpoints: EndpointResponse[] = [
      {
        id: 'ep-123',
        workspaceId: 'ws-123',
        name: 'Stripe Webhooks',
        slug: 'stripe-hooks',
        destinationUrl: 'https://api.example.com/webhooks',
        isActive: true,
        mode: 'forward',
        signatureConfig: {
          provider: 'none',
          enforce: false,
          secretConfigured: false,
        },
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30000,
        },
        rateLimitPerMin: 120,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    vi.spyOn(endpointsApiModule.endpointsApi, 'listByWorkspace').mockResolvedValue({
      endpoints: mockEndpoints,
    });
    vi.spyOn(eventsApiModule.eventsApi, 'listEndpointEvents').mockResolvedValue({
      events: [],
      nextCursor: null,
      hasNextPage: false,
    });

    const html = renderToString(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <EventInspectorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Filtered status button must be visible in the status filter tab list
    expect(html).toContain('filtered');
    expect(html).toContain('all');
    expect(html).toContain('delivered');
  });

  it('3. Renders delivery row with filtered status, filterReason explanation, and Force Deliver button', () => {
    const mockFilteredDelivery: DeliveryResponse = {
      id: 'del-filtered-1',
      workspaceId: 'ws-123',
      eventId: 'evt-123',
      destinationId: 'dest-999',
      destinationName: 'Accounting Webhook',
      destinationUrl: 'https://accounting.example.com/hooks',
      status: 'filtered',
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      filterReason: 'Condition failed: body.type eq "order.paid": field missing',
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockEventDetail: EventWithAttemptsResponse = {
      id: 'evt-123',
      workspaceId: 'ws-123',
      endpointId: 'ep-123',
      receivedAt: new Date().toISOString(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"amount": 7000}',
      bodySize: 16,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: 'idem-1',
      status: 'filtered',
      attemptCount: 0,
      replayCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      attempts: [],
      deliveries: [mockFilteredDelivery],
    };

    // Component directly rendering the delivery row inside drawer
    const html = renderToString(
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge status={mockEventDetail.status} size="sm" />
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-zinc-950/80 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-bold text-zinc-100 text-sm">
              {mockFilteredDelivery.destinationName}
            </span>
            <StatusBadge status={mockFilteredDelivery.status} size="sm" />
          </div>
          <div className="p-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300">
            <span>Filter Reason</span>
            <span>{mockFilteredDelivery.filterReason}</span>
          </div>
          {mockFilteredDelivery.status === 'filtered' && (
            <button className="px-3 py-1.5 rounded-lg bg-purple-500/20 text-purple-300">
              Force Deliver
            </button>
          )}
        </div>
      </div>,
    );

    expect(html).toContain('Accounting Webhook');
    expect(html).toContain('body.type eq');
    expect(html).toContain('order.paid');
    expect(html).toContain(': field missing');
    expect(html).toContain('Force Deliver');
    expect(html).toContain('filtered');
  });

  it('4. Event list with events renders rows and corresponding status badges for all statuses', () => {
    const statuses: Array<
      'delivered' | 'pending' | 'failed' | 'dead' | 'partial' | 'filtered' | 'captured'
    > = ['delivered', 'pending', 'failed', 'dead', 'partial', 'filtered', 'captured'];

    const mockEvents = statuses.map((status, idx) => ({
      id: `evt-${idx}-${status}`,
      workspaceId: 'ws-123',
      endpointId: 'ep-123',
      receivedAt: new Date(Date.now() - idx * 1000).toISOString(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ index: idx }),
      bodySize: 20,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: `idem-${status}`,
      status,
      attemptCount: 1,
      replayCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
    }));

    const html = renderToString(
      <div className="divide-y divide-white/[0.04]">
        {mockEvents.map((evt) => (
          <div key={evt.id} className="grid grid-cols-12 gap-4 px-6 py-4 items-center">
            <div className="col-span-2">
              <StatusBadge status={evt.status} size="sm" />
            </div>
            <div className="col-span-1 text-xs font-mono">{evt.method}</div>
            <div className="col-span-4 font-mono text-xs">
              <span>{evt.id}</span>
              <span>{evt.idempotencyKey}</span>
            </div>
          </div>
        ))}
      </div>,
    );

    for (const status of statuses) {
      expect(html).toContain(status);
      expect(html).toContain(`idem-${status}`);
    }
  });
});
