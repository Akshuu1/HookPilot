import { z } from 'zod';

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().datetime(),
  uptime: z.number().nonnegative(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ComponentHealthSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const ReadyStatusSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  timestamp: z.string().datetime(),
  components: z.object({
    mongodb: ComponentHealthSchema,
    redis: ComponentHealthSchema,
  }),
});

export type ReadyStatus = z.infer<typeof ReadyStatusSchema>;

export const SampleEventPayloadSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  rawBody: z.string(),
  headers: z.record(z.string()),
  receivedAt: z.string().datetime(),
});

export type SampleEventPayload = z.infer<typeof SampleEventPayloadSchema>;

// ==========================================
// Phase 2: Roles, Workspaces, and Auth
// ==========================================

export const WorkspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WorkspaceRoles)[number];

export const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
};

/**
 * Checks whether userRole satisfies the minimum required role level.
 */
export function hasRequiredRole(userRole: WorkspaceRole, minRole: WorkspaceRole): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

export const RegisterInputSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').trim(),
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

export const CreateWorkspaceInputSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(64).trim(),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export const AddMemberInputSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  role: z.enum(['admin', 'member', 'viewer']),
});

export type AddMemberInput = z.infer<typeof AddMemberInputSchema>;

export const ChangeRoleInputSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

export type ChangeRoleInput = z.infer<typeof ChangeRoleInputSchema>;

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string().datetime(),
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

export const WorkspaceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  role: z.enum(WorkspaceRoles),
  createdAt: z.string().datetime(),
});

export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;
