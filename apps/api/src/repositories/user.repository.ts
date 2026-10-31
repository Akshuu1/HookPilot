import { UserModel, type IUser } from '../models/User.js';

export interface CreateUserData {
  email: string;
  name: string;
  passwordHash?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface UserRepository {
  findByEmail(email: string): Promise<IUser | null>;
  findById(id: string): Promise<IUser | null>;
  create(data: CreateUserData): Promise<IUser>;
}

export class MongoUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase().trim() });
  }

  async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  async create(data: CreateUserData): Promise<IUser> {
    const user = new UserModel({
      email: data.email.toLowerCase().trim(),
      passwordHash: data.passwordHash || null,
      name: data.name.trim(),
      displayName: data.displayName?.trim() || null,
      avatarUrl: data.avatarUrl || null,
    });
    return user.save();
  }
}

export const userRepository = new MongoUserRepository();
