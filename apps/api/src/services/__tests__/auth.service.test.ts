import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../auth.service.js';
import type { UserRepository } from '../../repositories/user.repository.js';
import type { RefreshTokenRepository } from '../../repositories/refresh-token.repository.js';
import type { IUser } from '../../models/User.js';
import type { IRefreshToken } from '../../models/RefreshToken.js';
import * as security from '../../utils/security.js';

describe('AuthService Unit Tests', () => {
  let mockUserRepo: UserRepository;
  let mockTokenRepo: RefreshTokenRepository;
  let service: AuthService;

  beforeEach(() => {
    mockUserRepo = {
      findByEmail: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    };

    mockTokenRepo = {
      create: vi.fn().mockResolvedValue({} as unknown as IRefreshToken),
      findByTokenHash: vi.fn(),
      revokeToken: vi.fn().mockResolvedValue(undefined),
      revokeAllForUser: vi.fn().mockResolvedValue(1),
    };

    service = new AuthService(mockUserRepo, mockTokenRepo);
  });

  describe('register', () => {
    it('creates a user and returns tokens', async () => {
      vi.mocked(mockUserRepo.findByEmail).mockResolvedValue(null);
      vi.mocked(mockUserRepo.create).mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test',
        passwordHash: 'hashed',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IUser);

      const res = await service.register({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test',
      });

      expect(res.user.email).toBe('test@example.com');
      expect(res.accessToken).toBeDefined();
      expect(res.refreshToken).toBeDefined();
      expect(mockTokenRepo.create).toHaveBeenCalledOnce();
    });

    it('throws 409 if email already exists', async () => {
      vi.mocked(mockUserRepo.findByEmail).mockResolvedValue({ id: 'existing' } as unknown as IUser);

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test',
        }),
      ).rejects.toThrow('Email is already registered');
    });
  });

  describe('login', () => {
    it('throws 401 if user not found', async () => {
      vi.mocked(mockUserRepo.findByEmail).mockResolvedValue(null);

      await expect(
        service.login({ email: 'unknown@example.com', password: 'password' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('throws 401 if password check fails', async () => {
      vi.mocked(mockUserRepo.findByEmail).mockResolvedValue({
        id: 'u1',
        passwordHash: 'hash',
      } as unknown as IUser);
      vi.spyOn(security, 'verifyPassword').mockResolvedValue(false);

      await expect(service.login({ email: 'u1@example.com', password: 'bad' })).rejects.toThrow(
        'Invalid email or password',
      );
    });
  });

  describe('refresh', () => {
    it('triggers reuse detection when token is already revoked', async () => {
      vi.mocked(mockTokenRepo.findByTokenHash).mockResolvedValue({
        userId: 'u1',
        isRevoked: true,
        expiresAt: new Date(Date.now() + 100000),
      } as unknown as IRefreshToken);

      await expect(service.refresh('revoked-token')).rejects.toThrow(
        'Refresh token reuse detected. All sessions revoked.',
      );
      expect(mockTokenRepo.revokeAllForUser).toHaveBeenCalledWith('u1');
    });
  });
});
