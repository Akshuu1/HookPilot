import { Types } from 'mongoose';
import { AuditLogModel, type IAuditLog } from '../models/AuditLog.js';

export interface CreateAuditLogData {
  workspaceId: string;
  userId: string;
  action: string;
  resourceType?: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogRepository {
  create(data: CreateAuditLogData): Promise<IAuditLog>;
  findByWorkspace(workspaceId: string, limit?: number): Promise<IAuditLog[]>;
  findByResource(resourceId: string): Promise<IAuditLog[]>;
}

export class MongoAuditLogRepository implements AuditLogRepository {
  async create(data: CreateAuditLogData): Promise<IAuditLog> {
    const log = new AuditLogModel({
      workspaceId: new Types.ObjectId(data.workspaceId),
      userId: new Types.ObjectId(data.userId),
      action: data.action,
      resourceType: data.resourceType || 'event',
      resourceId: data.resourceId,
      metadata: data.metadata || {},
    });
    return log.save();
  }

  async findByWorkspace(workspaceId: string, limit = 50): Promise<IAuditLog[]> {
    if (!Types.ObjectId.isValid(workspaceId)) return [];
    return AuditLogModel.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  async findByResource(resourceId: string): Promise<IAuditLog[]> {
    return AuditLogModel.find({ resourceId }).sort({ createdAt: -1 });
  }
}

export const auditLogRepository = new MongoAuditLogRepository();
