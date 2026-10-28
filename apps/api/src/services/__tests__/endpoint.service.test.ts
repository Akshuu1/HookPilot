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
      // Never returns raw decrypted secret
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
  });

  describe('rotateSecret', () => {
    it('encrypts new secret and returns masked preview and raw value', async () => {
      const mockEp = {
        id: 'ep-1',
        signatureConfig: { provider: 'github', secretEncrypted: null },
      } as unknown as IEndpoint;

      vi.mocked(mockEndpointRepo.findById).mockResolvedValue(mockEp);
      vi.mocked(mockEndpointRepo.update).mockResolvedValue(mockEp);

      const res = await service.rotateSecret('ep-1', 'whsec_newsecret9999');

      expect(res.secret).toBe('whsec_newsecret9999');
      expect(res.secretMasked).toBe('****9999');
      expect(mockEndpointRepo.update).toHaveBeenCalledOnce();
    });
  });
});
