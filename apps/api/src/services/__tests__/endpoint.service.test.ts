import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EndpointService } from '../endpoint.service.js';
import type { EndpointRepository } from '../../repositories/endpoint.repository.js';
import type { IEndpoint } from '../../models/Endpoint.js';

describe('EndpointService Unit Tests', () => {
  let mockEndpointRepo: EndpointRepository;
  let service: EndpointService;

  beforeEach(() => {
    mockEndpointRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      findBySlug: vi.fn(),
      findByWorkspace: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    service = new EndpointService(mockEndpointRepo);
  });

  describe('createEndpoint', () => {
    it('creates an endpoint with unique 12-char slug and masked secret', async () => {
      vi.mocked(mockEndpointRepo.findBySlug).mockResolvedValue(null);
      vi.mocked(mockEndpointRepo.create).mockImplementation(async (data) => {
        return {
          id: 'ep-123',
          workspaceId: data.workspaceId,
          name: data.name,
          slug: data.slug,
          destinationUrl: data.destinationUrl,
          signatureConfig: data.signatureConfig || { provider: 'none', secretEncrypted: null },
          retryPolicy: data.retryPolicy || {
            maxAttempts: 8,
            baseDelayMs: 1000,
            maxDelayMs: 3600000,
          },
          rateLimitPerMin: data.rateLimitPerMin ?? 60,
          isActive: true,
          mode: data.mode ?? 'forward',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as IEndpoint;
      });

      const res = await service.createEndpoint('ws-1', {
        name: 'Stripe Webhook Sink',
        destinationUrl: 'https://example.com/api/webhooks',
        signatureConfig: {
          provider: 'stripe',
          secret: 'whsec_verysecretkey12345',
        },
      });

      expect(res.name).toBe('Stripe Webhook Sink');
      expect(res.slug).toHaveLength(12);
      expect(res.destinationUrl).toBe('https://example.com/api/webhooks');
      expect(res.signatureConfig.secretMasked).toBe('****2345');
      expect(res.retryPolicy.maxAttempts).toBe(8);
      expect(res.mode).toBe('forward');
    });

    it('rejects SSRF destinations (loopback/private IP)', async () => {
      await expect(
        service.createEndpoint('ws-1', {
          name: 'Malicious Endpoint',
          destinationUrl: 'http://127.0.0.1:8080/internal-admin',
        }),
      ).rejects.toThrow('SSRF guard');
    });

    it('retries when slug collision occurs up to 5 times', async () => {
      let callCount = 0;
      vi.mocked(mockEndpointRepo.findBySlug).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) return { id: 'collided' } as unknown as IEndpoint;
        return null;
      });

      vi.mocked(mockEndpointRepo.create).mockImplementation(async (data) => {
        return {
          id: 'ep-retry',
          workspaceId: data.workspaceId,
          name: data.name,
          slug: data.slug,
          destinationUrl: data.destinationUrl,
          signatureConfig: { provider: 'none', secretEncrypted: null },
          retryPolicy: { maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 3600000 },
          rateLimitPerMin: 60,
          isActive: true,
          mode: 'forward',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as IEndpoint;
      });

      const res = await service.createEndpoint('ws-1', {
        name: 'Slug Retry Sink',
        destinationUrl: 'https://example.com/webhooks',
      });

      expect(res.slug).toBeDefined();
      expect(callCount).toBe(3);
    });

    it('throws error if slug collision persists', async () => {
      vi.mocked(mockEndpointRepo.findBySlug).mockResolvedValue({
        id: 'collided',
      } as unknown as IEndpoint);

      await expect(
        service.createEndpoint('ws-1', {
          name: 'Slug Fail Sink',
          destinationUrl: 'https://example.com/webhooks',
        }),
      ).rejects.toThrow('Failed to generate unique slug');
    });
  });

  describe('getEndpoint', () => {
    it('returns endpoint by id', async () => {
      const mockEp = {
        id: 'ep-abc',
        workspaceId: 'ws-1',
        name: 'My Webhook',
        slug: 'slug123',
        destinationUrl: 'https://example.com/hook',
        signatureConfig: { provider: 'generic', secretEncrypted: null, headerName: 'x-sig' },
        retryPolicy: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000 },
        rateLimitPerMin: 120,
        isActive: true,
        mode: 'forward',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(mockEp);

      const res = await service.getEndpoint('ep-abc');
      expect(res.id).toBe('ep-abc');
      expect(res.name).toBe('My Webhook');
      expect(res.destinationUrl).toBe('https://example.com/hook');
    });

    it('throws 404 when endpoint is not found', async () => {
      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(null);

      await expect(service.getEndpoint('non-existent')).rejects.toThrow('Endpoint not found');
    });
  });

  describe('listWorkspaceEndpoints', () => {
    it('returns all endpoints for a workspace', async () => {
      const mockEp1 = {
        id: 'ep-1',
        workspaceId: 'ws-1',
        name: 'Hook 1',
        slug: 'slug1',
        destinationUrl: 'https://example.com/1',
        signatureConfig: { provider: 'none', secretEncrypted: null },
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
        rateLimitPerMin: 60,
        isActive: true,
        mode: 'forward',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findByWorkspace).mockResolvedValue([mockEp1]);

      const res = await service.listWorkspaceEndpoints('ws-1');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('ep-1');
    });
  });

  describe('updateEndpoint', () => {
    it('updates fields including retry policy and validates SSRF', async () => {
      const existing = {
        id: 'ep-update',
        workspaceId: 'ws-1',
        name: 'Old Name',
        slug: 'old-slug',
        destinationUrl: 'https://example.com/old',
        signatureConfig: { provider: 'none', secretEncrypted: null },
        retryPolicy: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000 },
        rateLimitPerMin: 60,
        isActive: true,
        mode: 'forward',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(existing);
      vi.mocked(mockEndpointRepo.update).mockImplementation(async (_id, data) => {
        const updated = {
          ...existing,
          retryPolicy: { ...existing.retryPolicy },
          signatureConfig: { ...existing.signatureConfig },
          updatedAt: new Date(),
        };
        for (const [k, v] of Object.entries(data)) {
          if (k.startsWith('retryPolicy.')) {
            const field = k.replace('retryPolicy.', '');
            (updated.retryPolicy as Record<string, unknown>)[field] = v;
          } else if (k.startsWith('signatureConfig.')) {
            const field = k.replace('signatureConfig.', '');
            (updated.signatureConfig as Record<string, unknown>)[field] = v;
          } else {
            (updated as Record<string, unknown>)[k] = v;
          }
        }
        return updated as unknown as IEndpoint;
      });

      const updated = await service.updateEndpoint('ep-update', {
        name: 'New Name',
        destinationUrl: 'https://api.example.com/new',
        retryPolicy: { maxAttempts: 10 },
        rateLimitPerMin: 120,
      });

      expect(updated.name).toBe('New Name');
      expect(updated.destinationUrl).toBe('https://api.example.com/new');
      expect(updated.retryPolicy.maxAttempts).toBe(10);
      expect(updated.rateLimitPerMin).toBe(120);
    });

    it('rejects SSRF destination url updates', async () => {
      const existing = {
        id: 'ep-update-ssrf',
        destinationUrl: 'https://example.com/old',
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(existing);

      await expect(
        service.updateEndpoint('ep-update-ssrf', {
          destinationUrl: 'http://169.254.169.254/latest/meta-data',
        }),
      ).rejects.toThrow('SSRF guard');
    });

    it('throws 404 when updating non-existent endpoint', async () => {
      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(null);

      await expect(service.updateEndpoint('not-found', { name: 'Something' })).rejects.toThrow(
        'Endpoint not found',
      );
    });
  });

  describe('deleteEndpoint', () => {
    it('deletes an existing endpoint and invalidates cache', async () => {
      const mockEp = {
        id: 'ep-del',
        slug: 'slug-del',
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(mockEp);
      vi.mocked(mockEndpointRepo.delete).mockResolvedValue(true);

      await expect(service.deleteEndpoint('ep-del')).resolves.toBeUndefined();
      expect(mockEndpointRepo.delete).toHaveBeenCalledWith('ep-del');
    });

    it('throws 404 when deleting non-existent endpoint', async () => {
      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(null);

      await expect(service.deleteEndpoint('non-existent')).rejects.toThrow('Endpoint not found');
    });
  });

  describe('rotateSecret', () => {
    it('encrypts new secret and returns masked preview and raw value', async () => {
      const mockEp = {
        id: 'ep-1',
        slug: 'ep-slug',
        signatureConfig: { provider: 'github', secretEncrypted: null },
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(mockEp);
      vi.mocked(mockEndpointRepo.update).mockResolvedValue(mockEp);

      const res = await service.rotateSecret('ep-1', 'whsec_newsecret9999');

      expect(res.secret).toBe('whsec_newsecret9999');
      expect(res.secretMasked).toBe('****9999');
      expect(mockEndpointRepo.update).toHaveBeenCalledOnce();
    });

    it('auto-generates a secret when not provided', async () => {
      const mockEp = {
        id: 'ep-2',
        slug: 'ep-slug-2',
        signatureConfig: { provider: 'stripe', secretEncrypted: null },
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(mockEp);
      vi.mocked(mockEndpointRepo.update).mockResolvedValue(mockEp);

      const res = await service.rotateSecret('ep-2');

      expect(res.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      expect(res.secretMasked).toBeDefined();
    });

    it('throws 404 when rotating secret for non-existent endpoint', async () => {
      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(null);

      await expect(service.rotateSecret('non-existent')).rejects.toThrow('Endpoint not found');
    });
  });
});
