import type { RegisterInput, LoginInput, UserResponse } from '@hookpilot/shared';
import { AppError } from '../middlewares/error-handler.js';
import {
  type UserRepository,
  userRepository as defaultUserRepo,
} from '../repositories/user.repository.js';
import {
  type RefreshTokenRepository,
  refreshTokenRepository as defaultRefreshTokenRepo,
} from '../repositories/refresh-token.repository.js';
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateRandomToken,
  signAccessToken,
} from '../utils/security.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: UserResponse;
}

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository = defaultUserRepo,
    private readonly tokenRepo: RefreshTokenRepository = defaultRefreshTokenRepo,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) {
      throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.userRepo.create({
      email: input.email,
      name: input.name,
      passwordHash,
    });

    const tokens = await this.createTokens(user.id, user.email, user.name);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
      ...tokens,
    };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.userRepo.findByEmail(input.email);
    if (!user) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const isValid = await verifyPassword(input.password, user.passwordHash);
    if (!isValid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const tokens = await this.createTokens(user.id, user.email, user.name);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
      ...tokens,
    };
  }

  async refresh(rawToken?: string): Promise<AuthTokens & { user: UserResponse }> {
    if (!rawToken) {
      throw new AppError('Refresh token required', 401, 'UNAUTHORIZED');
    }

    const tokenHash = hashToken(rawToken);
    const storedToken = await this.tokenRepo.findByTokenHash(tokenHash);

    if (!storedToken) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }

    // Reuse detection: if a revoked token is re-used, revoke all tokens for this user
    if (storedToken.isRevoked) {
      await this.tokenRepo.revokeAllForUser(storedToken.userId.toString());
      throw new AppError(
        'Refresh token reuse detected. All sessions revoked.',
        401,
        'TOKEN_REUSE_DETECTED',
      );
    }

    if (new Date() > storedToken.expiresAt) {
      await this.tokenRepo.revokeToken(tokenHash);
      throw new AppError('Refresh token expired', 401, 'TOKEN_EXPIRED');
    }

    const user = await this.userRepo.findById(storedToken.userId.toString());
    if (!user) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }

    // Generate new rotated refresh token
    const newRawToken = generateRandomToken();
    const newTokenHash = hashToken(newRawToken);
    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);

    // Save new token and mark old token as rotated/revoked
    await this.tokenRepo.create({
      userId: user.id,
      tokenHash: newTokenHash,
      expiresAt,
    });

    await this.tokenRepo.revokeToken(tokenHash, newTokenHash);

    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    return {
      accessToken,
      refreshToken: newRawToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  async logout(rawToken?: string): Promise<void> {
    if (rawToken) {
      const tokenHash = hashToken(rawToken);
      await this.tokenRepo.revokeToken(tokenHash);
    }
  }

  async getMe(userId: string): Promise<UserResponse> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async createTokens(userId: string, email: string, name: string): Promise<AuthTokens> {
    const accessToken = signAccessToken({ userId, email, name });
    const rawRefreshToken = generateRandomToken();
    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);

    await this.tokenRepo.create({
      userId,
      tokenHash,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }
}

export const authService = new AuthService();
