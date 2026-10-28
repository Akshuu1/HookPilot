import { randomBytes } from 'node:crypto';
import {
  type CreateEndpointInput,
  type UpdateEndpointInput,
  type EndpointResponse,
  validateDestinationUrl,
  generateSlug,
} from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto.js';
import type { IEndpoint } from '../models/Endpoint.js';

export class EndpointService {
  constructor(private readonly endpointRepo: EndpointRepository = defaultEndpointRepo) {}

  async createEndpoint(workspaceId: string, input: CreateEndpointInput): Promise<EndpointResponse> {
    const isUrlSafe = await validateDestinationUrl(input.destinationUrl);
    if (!isUrlSafe) {
      throw new AppError(
        'Invalid destination URL: loopback, private, and cloud metadata addresses are forbidden (SSRF guard).',
        400,
        'SSRF_DESTINATION_REJECTED',
      );
    }

    // Generate unique slug
    let slug = generateSlug();
    let collisionCheck = await this.endpointRepo.findBySlug(slug);
    let attempts = 0;
    while (collisionCheck && attempts < 5) {
      slug = generateSlug();
      collisionCheck = await this.endpointRepo.findBySlug(slug);
      attempts++;
    }

    if (collisionCheck) {
      throw new AppError(
        'Failed to generate unique slug, please try again.',
        500,
        'SLUG_GENERATION_FAILED',
      );
    }

    let secretEncrypted: string | null = null;
    if (input.signatureConfig?.secret) {
      secretEncrypted = encryptSecret(input.signatureConfig.secret);
    }

    const endpoint = await this.endpointRepo.create({
      workspaceId,
      name: input.name,
      slug,
      destinationUrl: input.destinationUrl,
      signatureConfig: {
        provider: input.signatureConfig?.provider || 'none',
        secretEncrypted,
        headerName: input.signatureConfig?.headerName || null,
      },
      retryPolicy: {
        maxAttempts: input.retryPolicy?.maxAttempts ?? 8,
        baseDelayMs: input.retryPolicy?.baseDelayMs ?? 1000,
        maxDelayMs: input.retryPolicy?.maxDelayMs ?? 3600000,
      },
      rateLimitPerMin: input.rateLimitPerMin ?? 60,
      mode: input.mode ?? 'forward',
      isActive: true,
    });

    return this.toResponse(endpoint);
  }

  async getEndpoint(id: string): Promise<EndpointResponse> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }
    return this.toResponse(endpoint);
  }

  async listWorkspaceEndpoints(workspaceId: string): Promise<EndpointResponse[]> {
    const endpoints = await this.endpointRepo.findByWorkspace(workspaceId);
    return endpoints.map((ep) => this.toResponse(ep));
  }

  async updateEndpoint(id: string, input: UpdateEndpointInput): Promise<EndpointResponse> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }

    if (input.destinationUrl && input.destinationUrl !== endpoint.destinationUrl) {
      const isUrlSafe = await validateDestinationUrl(input.destinationUrl);
      if (!isUrlSafe) {
        throw new AppError(
          'Invalid destination URL: loopback, private, and cloud metadata addresses are forbidden (SSRF guard).',
          400,
          'SSRF_DESTINATION_REJECTED',
        );
      }
    }

    let secretEncrypted = endpoint.signatureConfig.secretEncrypted;
    if (input.signatureConfig?.secret) {
      secretEncrypted = encryptSecret(input.signatureConfig.secret);
    }

    const updated = await this.endpointRepo.update(id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.destinationUrl ? { destinationUrl: input.destinationUrl } : {}),
      ...(input.rateLimitPerMin !== undefined ? { rateLimitPerMin: input.rateLimitPerMin } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.retryPolicy
        ? {
            retryPolicy: {
              maxAttempts: input.retryPolicy.maxAttempts ?? endpoint.retryPolicy.maxAttempts,
              baseDelayMs: input.retryPolicy.baseDelayMs ?? endpoint.retryPolicy.baseDelayMs,
              maxDelayMs: input.retryPolicy.maxDelayMs ?? endpoint.retryPolicy.maxDelayMs,
            },
          }
        : {}),
      signatureConfig: {
        provider: input.signatureConfig?.provider ?? endpoint.signatureConfig.provider,
        secretEncrypted: secretEncrypted ?? null,
        headerName:
          input.signatureConfig?.headerName ?? endpoint.signatureConfig.headerName ?? null,
      },
    });

    if (!updated) {
      throw new AppError('Failed to update endpoint', 500, 'UPDATE_FAILED');
    }

    return this.toResponse(updated);
  }

  async deleteEndpoint(id: string): Promise<void> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }
    await this.endpointRepo.delete(id);
  }

  async rotateSecret(
    id: string,
    providedSecret?: string,
  ): Promise<{ secret: string; secretMasked: string }> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }

    const rawSecret = providedSecret?.trim() || `whsec_${randomBytes(24).toString('hex')}`;
    const secretEncrypted = encryptSecret(rawSecret);

    await this.endpointRepo.update(id, {
      signatureConfig: {
        ...endpoint.signatureConfig,
        secretEncrypted,
      },
    });

    return {
      secret: rawSecret,
      secretMasked: maskSecret(rawSecret)!,
    };
  }

  private toResponse(endpoint: IEndpoint): EndpointResponse {
    let rawSecret: string | null = null;
    if (endpoint.signatureConfig.secretEncrypted) {
      try {
        rawSecret = decryptSecret(endpoint.signatureConfig.secretEncrypted);
      } catch {
        rawSecret = null;
      }
    }

    return {
      id: endpoint.id,
      workspaceId: endpoint.workspaceId.toString(),
      name: endpoint.name,
      slug: endpoint.slug,
      destinationUrl: endpoint.destinationUrl,
      signatureConfig: {
        provider: endpoint.signatureConfig.provider,
        secretMasked: maskSecret(rawSecret),
        headerName: endpoint.signatureConfig.headerName ?? null,
      },
      retryPolicy: {
        maxAttempts: endpoint.retryPolicy.maxAttempts,
        baseDelayMs: endpoint.retryPolicy.baseDelayMs,
        maxDelayMs: endpoint.retryPolicy.maxDelayMs,
      },
      rateLimitPerMin: endpoint.rateLimitPerMin,
      isActive: endpoint.isActive,
      mode: endpoint.mode,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
    };
  }
}

export const endpointService = new EndpointService();
