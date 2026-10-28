import { Types } from 'mongoose';
import { ApiKeyModel, type IApiKey } from '../models/ApiKey.js';

export interface CreateApiKeyDto {
  workspaceId: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdBy: string;
  expiresAt?: Date | null;
}

export interface ApiKeyRepository {
  create(data: CreateApiKeyDto): Promise<IApiKey>;
  findById(id: string): Promise<IApiKey | null>;
  findByHash(keyHash: string): Promise<IApiKey | null>;
  findByWorkspace(workspaceId: string): Promise<IApiKey[]>;
  revoke(id: string, workspaceId: string): Promise<IApiKey | null>;
  updateLastUsed(id: string): Promise<void>;
}

export class MongoApiKeyRepository implements ApiKeyRepository {
  async create(data: CreateApiKeyDto): Promise<IApiKey> {
    const key = new ApiKeyModel({
      workspaceId: new Types.ObjectId(data.workspaceId),
      name: data.name.trim(),
      prefix: data.prefix,
      keyHash: data.keyHash,
      createdBy: new Types.ObjectId(data.createdBy),
      expiresAt: data.expiresAt ?? null,
    });
    return key.save();
  }

  async findById(id: string): Promise<IApiKey | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return ApiKeyModel.findById(id);
  }

  async findByHash(keyHash: string): Promise<IApiKey | null> {
    return ApiKeyModel.findOne({ keyHash, revokedAt: null });
  }

  async findByWorkspace(workspaceId: string): Promise<IApiKey[]> {
    if (!Types.ObjectId.isValid(workspaceId)) return [];
    return ApiKeyModel.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async revoke(id: string, workspaceId: string): Promise<IApiKey | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(workspaceId)) return null;
    return ApiKeyModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        revokedAt: null,
      },
      {
        $set: { revokedAt: new Date() },
      },
      { new: true },
    );
  }

  async updateLastUsed(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await ApiKeyModel.findByIdAndUpdate(id, { $set: { lastUsedAt: new Date() } });
  }
}

export const apiKeyRepository = new MongoApiKeyRepository();
