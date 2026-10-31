import { Types } from 'mongoose';
import { DestinationModel, type IDestination } from '../models/Destination.js';

export interface CreateDestinationData {
  workspaceId: string;
  endpointId: string;
  name: string;
  url: string;
  customHeaders?: Array<{ name: string; valueEncrypted: string }>;
  isActive?: boolean;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  rateLimitPerMin?: number;
  filter?: Record<string, unknown> | null;
  outboundSecretEncrypted?: string | null;
}

export interface DestinationRepository {
  create(data: CreateDestinationData): Promise<IDestination>;
  findById(id: string): Promise<IDestination | null>;
  findByEndpoint(endpointId: string): Promise<IDestination[]>;
  findActiveByEndpoint(endpointId: string): Promise<IDestination[]>;
  countByEndpoint(endpointId: string): Promise<number>;
  update(
    id: string,
    data: Partial<IDestination> | Record<string, unknown>,
  ): Promise<IDestination | null>;
  delete(id: string): Promise<boolean>;
}

export class MongoDestinationRepository implements DestinationRepository {
  async create(data: CreateDestinationData): Promise<IDestination> {
    const destination = new DestinationModel({
      ...data,
      workspaceId: new Types.ObjectId(data.workspaceId),
      endpointId: new Types.ObjectId(data.endpointId),
      isActive: data.isActive !== undefined ? data.isActive : true,
    });
    return destination.save();
  }

  async findById(id: string): Promise<IDestination | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return DestinationModel.findById(id);
  }

  async findByEndpoint(endpointId: string): Promise<IDestination[]> {
    if (!Types.ObjectId.isValid(endpointId)) return [];
    return DestinationModel.find({ endpointId: new Types.ObjectId(endpointId) }).sort({
      createdAt: 1,
    });
  }

  async findActiveByEndpoint(endpointId: string): Promise<IDestination[]> {
    if (!Types.ObjectId.isValid(endpointId)) return [];
    return DestinationModel.find({
      endpointId: new Types.ObjectId(endpointId),
      isActive: true,
    }).sort({ createdAt: 1 });
  }

  async countByEndpoint(endpointId: string): Promise<number> {
    if (!Types.ObjectId.isValid(endpointId)) return 0;
    return DestinationModel.countDocuments({ endpointId: new Types.ObjectId(endpointId) });
  }

  async update(
    id: string,
    data: Partial<IDestination> | Record<string, unknown>,
  ): Promise<IDestination | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return DestinationModel.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true, runValidators: true },
    );
  }

  async delete(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const result = await DestinationModel.findByIdAndDelete(id);
    return !!result;
  }
}

export const destinationRepository = new MongoDestinationRepository();
