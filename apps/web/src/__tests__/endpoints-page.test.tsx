import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CreateEndpointInputSchema,
  type CreateEndpointInput,
  type WorkspaceResponse,
} from '@hookpilot/shared';
import { EndpointsPage } from '../pages/EndpointsPage.js';
import { useWorkspaceStore } from '../store/workspace.store.js';

describe('EndpointsPage & Endpoint Creation Configuration', () => {
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

  describe('Endpoints Page Shell Rendering', () => {
    it('renders the endpoints header, tab buttons, and new endpoint CTA', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EndpointsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('Webhook Delivery Network');
      expect(html).toContain('Endpoints');
      expect(html).toContain('Destinations');
      expect(html).toContain('Fan-Out');
      expect(html).toContain('New Endpoint');
    });
  });

  describe('Endpoint Creation Schema & Retry Policy Validation', () => {
    it('validates retry policy defaults with 8 maxAttempts', () => {
      const validPayload: CreateEndpointInput = {
        name: 'Stripe Inbound Webhooks',
        destinationUrl: 'https://api.example.com/webhooks',
        mode: 'forward',
        rateLimitPerMin: 60,
        signatureConfig: {
          provider: 'stripe',
          secret: 'whsec_test_secret_12345',
          enforce: true,
        },
        retryPolicy: {
          maxAttempts: 8,
          baseDelayMs: 1000,
          maxDelayMs: 3600000,
        },
      };

      const parsed = CreateEndpointInputSchema.safeParse(validPayload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.retryPolicy?.maxAttempts).toBe(8);
        expect(parsed.data.retryPolicy?.baseDelayMs).toBe(1000);
        expect(parsed.data.retryPolicy?.maxDelayMs).toBe(3600000);
      }
    });

    it('allows custom maxAttempts within the valid range (1 to 20)', () => {
      const customPayload: CreateEndpointInput = {
        name: 'Critical Payment Gateway',
        destinationUrl: 'https://api.example.com/payments',
        mode: 'forward',
        rateLimitPerMin: 100,
        retryPolicy: {
          maxAttempts: 15,
          baseDelayMs: 500,
          maxDelayMs: 600000,
        },
      };

      const parsed = CreateEndpointInputSchema.safeParse(customPayload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.retryPolicy?.maxAttempts).toBe(15);
      }
    });

    it('rejects invalid maxAttempts values outside boundary (0 or >20)', () => {
      const zeroAttempts = {
        name: 'Invalid Endpoint',
        destinationUrl: 'https://api.example.com/webhooks',
        retryPolicy: {
          maxAttempts: 0,
        },
      };

      const excessiveAttempts = {
        name: 'Invalid Endpoint',
        destinationUrl: 'https://api.example.com/webhooks',
        retryPolicy: {
          maxAttempts: 25,
        },
      };

      expect(CreateEndpointInputSchema.safeParse(zeroAttempts).success).toBe(false);
      expect(CreateEndpointInputSchema.safeParse(excessiveAttempts).success).toBe(false);
    });
  });
});
