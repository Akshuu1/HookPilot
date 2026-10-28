import { describe, it, expect } from 'vitest';
import {
  hasRequiredRole,
  RegisterInputSchema,
  LoginInputSchema,
  AddMemberInputSchema,
} from '../schemas.js';

describe('hasRequiredRole', () => {
  it('correctly evaluates owner permissions', () => {
    expect(hasRequiredRole('owner', 'owner')).toBe(true);
    expect(hasRequiredRole('owner', 'admin')).toBe(true);
    expect(hasRequiredRole('owner', 'member')).toBe(true);
    expect(hasRequiredRole('owner', 'viewer')).toBe(true);
  });

  it('correctly evaluates admin permissions', () => {
    expect(hasRequiredRole('admin', 'owner')).toBe(false);
    expect(hasRequiredRole('admin', 'admin')).toBe(true);
    expect(hasRequiredRole('admin', 'member')).toBe(true);
    expect(hasRequiredRole('admin', 'viewer')).toBe(true);
  });

  it('correctly evaluates member permissions', () => {
    expect(hasRequiredRole('member', 'owner')).toBe(false);
    expect(hasRequiredRole('member', 'admin')).toBe(false);
    expect(hasRequiredRole('member', 'member')).toBe(true);
    expect(hasRequiredRole('member', 'viewer')).toBe(true);
  });

  it('correctly evaluates viewer permissions', () => {
    expect(hasRequiredRole('viewer', 'owner')).toBe(false);
    expect(hasRequiredRole('viewer', 'admin')).toBe(false);
    expect(hasRequiredRole('viewer', 'member')).toBe(false);
    expect(hasRequiredRole('viewer', 'viewer')).toBe(true);
  });
});

describe('Auth & Workspace Schemas', () => {
  it('validates register input', () => {
    const valid = RegisterInputSchema.safeParse({
      email: 'TEST@example.com',
      password: 'password123',
      name: 'Test User',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.email).toBe('test@example.com');
    }

    const invalidPassword = RegisterInputSchema.safeParse({
      email: 'test@example.com',
      password: 'short',
      name: 'Test',
    });
    expect(invalidPassword.success).toBe(false);
  });

  it('validates login input', () => {
    const valid = LoginInputSchema.safeParse({
      email: 'User@Domain.com',
      password: 'mypassword',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.email).toBe('user@domain.com');
    }
  });

  it('validates add member input', () => {
    const valid = AddMemberInputSchema.safeParse({
      email: 'colleague@domain.com',
      role: 'member',
    });
    expect(valid.success).toBe(true);

    const invalidRole = AddMemberInputSchema.safeParse({
      email: 'colleague@domain.com',
      role: 'owner', // Cannot add directly as owner
    });
    expect(invalidRole.success).toBe(false);
  });
});
