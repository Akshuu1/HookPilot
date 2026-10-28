import { UserModel, type IUser } from '../models/User.js';

export interface UserRepository {
  findByEmail(email: string): Promise<IUser | null>;
  findById(id: string): Promise<IUser | null>;
  create(data: { email: string; passwordHash: string; name: string }): Promise<IUser>;
}

export class MongoUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase().trim() });
  }

  async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  async create(data: { email: string; passwordHash: string; name: string }): Promise<IUser> {
    const user = new UserModel({
      email: data.email.toLowerCase().trim(),
      passwordHash: data.passwordHash,
      name: data.name.trim(),
    });
    return user.save();
  }
}

export const userRepository = new MongoUserRepository();
