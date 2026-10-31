import { z } from 'zod';

export const OAuthProviders = ['github', 'google'] as const;
export const OAuthProviderSchema = z.enum(OAuthProviders);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const IdentityResponseSchema = z.object({
  id: z.string(),
  provider: OAuthProviderSchema,
  email: z.string().email(),
  avatarUrl: z.string().nullable().optional(),
  createdAt: z.string(),
  lastLoginAt: z.string(),
});

export type IdentityResponse = z.infer<typeof IdentityResponseSchema>;

export const ProvidersConfigResponseSchema = z.object({
  providers: z.object({
    github: z.boolean(),
    google: z.boolean(),
  }),
});

export type ProvidersConfigResponse = z.infer<typeof ProvidersConfigResponseSchema>;

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  hasPassword: z.boolean(),
  identities: z.array(
    z.object({
      id: z.string(),
      provider: OAuthProviderSchema,
      email: z.string().email(),
      avatarUrl: z.string().nullable().optional(),
    }),
  ),
  createdAt: z.string(),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
