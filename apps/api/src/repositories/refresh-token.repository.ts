import { Types } from 'mongoose';
import { RefreshTokenModel, type IRefreshToken } from '../models/RefreshToken.js';

export interface RefreshTokenRepository {
  create(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<IRefreshToken>;
  findByTokenHash(tokenHash: string): Promise<IRefreshToken | null>;
  revokeToken(tokenHash: string, replacedByTokenHash?: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
}

export class MongoRefreshTokenRepository implements RefreshTokenRepository {
  async create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<IRefreshToken> {
    const token = new RefreshTokenModel({
      userId: new Types.ObjectId(data.userId),
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      isRevoked: false,
    });
    return token.save();
  }

  async findByTokenHash(tokenHash: string): Promise<IRefreshToken | null> {
    return RefreshTokenModel.findOne({ tokenHash });
  }

  async revokeToken(tokenHash: string, replacedByTokenHash?: string): Promise<void> {
    await RefreshTokenModel.updateOne(
      { tokenHash },
      {
        $set: {
          isRevoked: true,
          ...(replacedByTokenHash ? { replacedByTokenHash } : {}),
        },
      },
    );
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await RefreshTokenModel.updateMany(
      { userId: new Types.ObjectId(userId), isRevoked: false },
      { $set: { isRevoked: true } },
    );
    return result.modifiedCount;
  }
}

export const refreshTokenRepository = new MongoRefreshTokenRepository();
