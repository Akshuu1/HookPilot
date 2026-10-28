import { Types } from 'mongoose';
import type { SignatureProvider, EndpointMode } from '@hookpilot/shared';
import { EndpointModel, type IEndpoint } from '../models/Endpoint.js';

export interface CreateEndpointData {
  workspaceId: string;
  name: string;
  slug: string;
  destinationUrl: string;
  signatureConfig?: {
    provider: SignatureProvider;
    secretEncrypted?: string | null;
    headerName?: string | null;
  };
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  rateLimitPerMin?: number;
  mode?: EndpointMode;
  isActive?: boolean;
}

export interface EndpointRepository {
  create(data: CreateEndpointData): Promise<IEndpoint>;
  findById(id: string): Promise<IEndpoint | null>;
  findBySlug(slug: string): Promise<IEndpoint | null>;
  findByWorkspace(workspaceId: string): Promise<IEndpoint[]>;
  update(id: string, data: Partial<IEndpoint>): Promise<IEndpoint | null>;
  delete(id: string): Promise<boolean>;
}

export class MongoEndpointRepository implements EndpointRepository {
  async create(data: CreateEndpointData): Promise<IEndpoint> {
    const endpoint = new EndpointModel({
      ...data,
      workspaceId: new Types.ObjectId(data.workspaceId),
    });
    return endpoint.save();
  }

  async findById(id: string): Promise<IEndpoint | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return EndpointModel.findById(id);
  }

  async findBySlug(slug: string): Promise<IEndpoint | null> {
    return EndpointModel.findOne({ slug });
  }

  async findByWorkspace(workspaceId: string): Promise<IEndpoint[]> {
    if (!Types.ObjectId.isValid(workspaceId)) return [];
    return EndpointModel.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({
      createdAt: -1,
    });
  }

  async update(id: string, data: Partial<IEndpoint>): Promise<IEndpoint | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return EndpointModel.findByIdAndUpdate(id, { $set: data }, { new: true });
  }

  async delete(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await EndpointModel.deleteOne({ _id: new Types.ObjectId(id) });
    return res.deletedCount > 0;
  }
}

export const endpointRepository = new MongoEndpointRepository();
