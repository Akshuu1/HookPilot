import crypto from 'node:crypto';
import type { CreateApiKeyInput, ApiKeyResponse, CreateApiKeyResponse } from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type ApiKeyRepository,
  apiKeyRepository as defaultApiKeyRepo,
} from '../repositories/api-key.repository.js';
import type { IApiKey } from '../models/ApiKey.js';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function generateRawApiKey(): { rawKey: string; prefix: string; hash: string } {
  const randomPart = crypto.randomBytes(24).toString('base64url');
  const rawKey = `hp_${randomPart}`;
  const prefix = `hp_${randomPart.slice(0, 6)}...`;
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}

export class ApiKeyService {
  constructor(private readonly apiKeyRepo: ApiKeyRepository = defaultApiKeyRepo) {}

  async createApiKey(
    workspaceId: string,
    userId: string,
    input: CreateApiKeyInput,
  ): Promise<CreateApiKeyResponse> {
    const { rawKey, prefix, hash } = generateRawApiKey();

    let expiresAt: Date | null = null;
    if (input.expiresInDays) {
      expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    }

    const doc = await this.apiKeyRepo.create({
      workspaceId,
      name: input.name,
      prefix,
      keyHash: hash,
      createdBy: userId,
      expiresAt,
    });

    return {
      apiKey: this.toResponse(doc),
      secretKey: rawKey,
    };
  }

  async listApiKeys(workspaceId: string): Promise<ApiKeyResponse[]> {
    const keys = await this.apiKeyRepo.findByWorkspace(workspaceId);
    return keys.map((k) => this.toResponse(k));
  }

  async revokeApiKey(workspaceId: string, keyId: string): Promise<void> {
    const revoked = await this.apiKeyRepo.revoke(keyId, workspaceId);
    if (!revoked) {
      throw new AppError('API key not found or already revoked', 404, 'KEY_NOT_FOUND');
    }
  }

  async verifyApiKey(rawKey: string): Promise<{ apiKey: IApiKey; workspaceId: string }> {
    if (!rawKey || !rawKey.startsWith('hp_')) {
      throw new AppError('Invalid API key format', 401, 'INVALID_API_KEY');
    }

    const hash = hashApiKey(rawKey);
    const apiKey = await this.apiKeyRepo.findByHash(hash);

    if (!apiKey) {
      throw new AppError('Invalid or revoked API key', 401, 'INVALID_API_KEY');
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      throw new AppError('API key has expired', 401, 'API_KEY_EXPIRED');
    }

    // Update last used asynchronously (non-blocking)
    void this.apiKeyRepo.updateLastUsed(apiKey.id);

    return {
      apiKey,
      workspaceId: apiKey.workspaceId.toString(),
    };
  }

  private toResponse(doc: IApiKey): ApiKeyResponse {
    return {
      id: doc.id,
      workspaceId: doc.workspaceId.toString(),
      name: doc.name,
      prefix: doc.prefix,
      createdBy: doc.createdBy.toString(),
      lastUsedAt: doc.lastUsedAt ? doc.lastUsedAt.toISOString() : null,
      revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
      expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
      createdAt: doc.createdAt.toISOString(),
    };
  }
}

export const apiKeyService = new ApiKeyService();
