import { randomBytes } from 'node:crypto';
import {
  type CreateEndpointInput,
  type UpdateEndpointInput,
  type EndpointResponse,
  validateDestinationUrl,
  generateSlug,
  isMaskedPlaceholder,
} from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type EndpointRepository,
  endpointRepository as defaultEndpointRepo,
} from '../repositories/endpoint.repository.js';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto.js';
import { getRedisClient } from '../config/redis.js';
import type { IEndpoint } from '../models/Endpoint.js';

export async function invalidateEndpointCache(slug: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await Promise.race([
      redis.del(`ep:slug:${slug}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 250)),
    ]);
  } catch {
    // Non-blocking in environments without active Redis
  }
}

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

    const provider = input.signatureConfig?.provider || 'none';
    const rawSecret = input.signatureConfig?.secret;
    const hasSecret =
      typeof rawSecret === 'string' && rawSecret.length > 0 && !isMaskedPlaceholder(rawSecret);

    if (provider !== 'none' && !hasSecret) {
      throw new AppError(
        `Provider '${provider}' requires a signing secret. Please provide a secret.`,
        400,
        'SECRET_REQUIRED',
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
    if (hasSecret && rawSecret) {
      secretEncrypted = encryptSecret(rawSecret);
    }

    const endpoint = await this.endpointRepo.create({
      workspaceId,
      name: input.name,
      slug,
      destinationUrl: input.destinationUrl,
      signatureConfig: {
        provider,
        secretEncrypted,
        headerName: input.signatureConfig?.headerName || null,
        enforce: input.signatureConfig?.enforce ?? false,
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

    const targetProvider = input.signatureConfig?.provider ?? endpoint.signatureConfig.provider;
    const existingSecretEncrypted = endpoint.signatureConfig.secretEncrypted;

    const rawSecret = input.signatureConfig?.secret;
    const isNewSecret =
      typeof rawSecret === 'string' && rawSecret.length > 0 && !isMaskedPlaceholder(rawSecret);

    let newSecretEncrypted: string | undefined;
    if (isNewSecret) {
      newSecretEncrypted = encryptSecret(rawSecret);
    }

    const effectiveSecretEncrypted = isNewSecret ? newSecretEncrypted : existingSecretEncrypted;

    // Changing provider keeps the stored secret. If the new provider needs a secret and none exists, return a 400 validation error instead of silently saving.
    if (targetProvider !== 'none' && !effectiveSecretEncrypted) {
      throw new AppError(
        `Provider '${targetProvider}' requires a signing secret. Please provide a secret.`,
        400,
        'SECRET_REQUIRED',
      );
    }

    // Partial update using field-level dot paths so secretEncrypted is never clobbered
    const updateDoc: Record<string, unknown> = {};

    if (input.name !== undefined) updateDoc['name'] = input.name;
    if (input.destinationUrl !== undefined) updateDoc['destinationUrl'] = input.destinationUrl;
    if (input.rateLimitPerMin !== undefined) updateDoc['rateLimitPerMin'] = input.rateLimitPerMin;
    if (input.isActive !== undefined) updateDoc['isActive'] = input.isActive;
    if (input.mode !== undefined) updateDoc['mode'] = input.mode;

    if (input.retryPolicy) {
      if (input.retryPolicy.maxAttempts !== undefined) {
        updateDoc['retryPolicy.maxAttempts'] = input.retryPolicy.maxAttempts;
      }
      if (input.retryPolicy.baseDelayMs !== undefined) {
        updateDoc['retryPolicy.baseDelayMs'] = input.retryPolicy.baseDelayMs;
      }
      if (input.retryPolicy.maxDelayMs !== undefined) {
        updateDoc['retryPolicy.maxDelayMs'] = input.retryPolicy.maxDelayMs;
      }
    }

    if (input.signatureConfig) {
      if (input.signatureConfig.provider !== undefined) {
        updateDoc['signatureConfig.provider'] = input.signatureConfig.provider;
      }
      if (input.signatureConfig.headerName !== undefined) {
        updateDoc['signatureConfig.headerName'] = input.signatureConfig.headerName;
      }
      if (input.signatureConfig.enforce !== undefined) {
        updateDoc['signatureConfig.enforce'] = input.signatureConfig.enforce;
      }
    }

    if (isNewSecret && newSecretEncrypted) {
      updateDoc['signatureConfig.secretEncrypted'] = newSecretEncrypted;
    }

    const updated = await this.endpointRepo.update(id, updateDoc);
    if (!updated) {
      throw new AppError('Failed to update endpoint', 500, 'UPDATE_FAILED');
    }

    await invalidateEndpointCache(endpoint.slug);
    if (updated.slug !== endpoint.slug) {
      await invalidateEndpointCache(updated.slug);
    }

    return this.toResponse(updated);
  }

  async deleteEndpoint(id: string): Promise<void> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }
    await this.endpointRepo.delete(id);
    await invalidateEndpointCache(endpoint.slug);
  }

  async rotateSecret(
    id: string,
    providedSecret?: string,
  ): Promise<{ secret: string; secretMasked: string }> {
    const endpoint = await this.endpointRepo.findById(id);
    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'NOT_FOUND');
    }

    const rawSecret = providedSecret || `whsec_${randomBytes(24).toString('hex')}`;
    const secretEncrypted = encryptSecret(rawSecret);

    await this.endpointRepo.update(id, {
      'signatureConfig.secretEncrypted': secretEncrypted,
    });

    await invalidateEndpointCache(endpoint.slug);

    return {
      secret: rawSecret,
      secretMasked: maskSecret(rawSecret)!,
    };
  }

  private toResponse(endpoint: IEndpoint): EndpointResponse {
    let rawSecret: string | null = null;
    if (endpoint.signatureConfig?.secretEncrypted) {
      try {
        rawSecret = decryptSecret(endpoint.signatureConfig.secretEncrypted);
      } catch {
        rawSecret = null;
      }
    }

    const secretConfigured = !!endpoint.signatureConfig?.secretEncrypted;
    const secretLast4 =
      rawSecret && rawSecret.length >= 4 ? rawSecret.slice(-4) : rawSecret || null;

    return {
      id: endpoint.id,
      workspaceId: endpoint.workspaceId.toString(),
      name: endpoint.name,
      slug: endpoint.slug,
      destinationUrl: endpoint.destinationUrl,
      signatureConfig: {
        provider: endpoint.signatureConfig.provider,
        secretConfigured,
        secretLast4,
        secretMasked: maskSecret(rawSecret),
        headerName: endpoint.signatureConfig.headerName ?? null,
        enforce: endpoint.signatureConfig.enforce ?? false,
      },
      retryPolicy: {
        maxAttempts: endpoint.retryPolicy.maxAttempts,
        baseDelayMs: endpoint.retryPolicy.baseDelayMs,
        maxDelayMs: endpoint.retryPolicy.maxDelayMs,
      },
      rateLimitPerMin: endpoint.rateLimitPerMin,
      isActive: endpoint.isActive,
      mode: endpoint.mode,
      createdAt: new Date(endpoint.createdAt).toISOString(),
      updatedAt: new Date(endpoint.updatedAt).toISOString(),
    };
  }
}

export const endpointService = new EndpointService();
