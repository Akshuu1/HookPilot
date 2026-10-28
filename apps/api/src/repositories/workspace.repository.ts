import { Types } from 'mongoose';
import { WorkspaceModel, type IWorkspace } from '../models/Workspace.js';

export interface WorkspaceRepository {
  create(data: { name: string; ownerId: string }): Promise<IWorkspace>;
  findById(id: string): Promise<IWorkspace | null>;
}

export class MongoWorkspaceRepository implements WorkspaceRepository {
  async create(data: { name: string; ownerId: string }): Promise<IWorkspace> {
    const workspace = new WorkspaceModel({
      name: data.name.trim(),
      ownerId: new Types.ObjectId(data.ownerId),
    });
    return workspace.save();
  }

  async findById(id: string): Promise<IWorkspace | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return WorkspaceModel.findById(id);
  }
}

export const workspaceRepository = new MongoWorkspaceRepository();
