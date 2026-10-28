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
  retentionDays: z.number().int().min(1).max(365).optional(),
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

export const AuthResponseSchema = z.object({
  user: UserResponseSchema,
  accessToken: z.string(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export const LoginResponseSchema = AuthResponseSchema;
export type LoginResponse = AuthResponse;

export const WorkspaceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  role: z.enum(WorkspaceRoles),
  retentionDays: z.number().int().min(1).max(365).optional(),
  createdAt: z.string().datetime(),
});

export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

// ==========================================
// Phase 3: Endpoint Module
// ==========================================

export const SignatureProviders = ['none', 'stripe', 'github', 'generic'] as const;
export type SignatureProvider = (typeof SignatureProviders)[number];

export const EndpointModes = ['forward', 'capture-only'] as const;
export type EndpointMode = (typeof EndpointModes)[number];

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(8),
  baseDelayMs: z.number().int().min(100).max(60000).default(1000),
  maxDelayMs: z.number().int().min(1000).max(86400000).default(3600000),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const SignatureConfigInputSchema = z.object({
  provider: z.enum(SignatureProviders).default('none'),
  secret: z.string().optional(),
  headerName: z.string().optional(),
  enforce: z.boolean().default(false),
});

export type SignatureConfigInput = z.infer<typeof SignatureConfigInputSchema>;

export const CreateEndpointInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(64).trim(),
  destinationUrl: z.string().url('Invalid destination URL').trim(),
  signatureConfig: SignatureConfigInputSchema.optional(),
  retryPolicy: RetryPolicySchema.optional(),
  rateLimitPerMin: z.number().int().min(1).max(10000).default(60),
  mode: z.enum(EndpointModes).default('forward'),
});

export type CreateEndpointInput = z.infer<typeof CreateEndpointInputSchema>;

export const UpdateEndpointInputSchema = z.object({
  name: z.string().min(1).max(64).trim().optional(),
  destinationUrl: z.string().url().trim().optional(),
  signatureConfig: SignatureConfigInputSchema.optional(),
  retryPolicy: RetryPolicySchema.optional(),
  rateLimitPerMin: z.number().int().min(1).max(10000).optional(),
  isActive: z.boolean().optional(),
  mode: z.enum(EndpointModes).optional(),
});

export type UpdateEndpointInput = z.infer<typeof UpdateEndpointInputSchema>;

export const RotateSecretInputSchema = z.object({
  secret: z.string().min(8, 'Secret must be at least 8 characters').optional(),
});

export type RotateSecretInput = z.infer<typeof RotateSecretInputSchema>;

export const EndpointResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  destinationUrl: z.string(),
  signatureConfig: z.object({
    provider: z.enum(SignatureProviders),
    secretMasked: z.string().nullable(),
    headerName: z.string().optional().nullable(),
    enforce: z.boolean().default(false),
  }),
  retryPolicy: RetryPolicySchema,
  rateLimitPerMin: z.number(),
  isActive: z.boolean(),
  mode: z.enum(EndpointModes),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type EndpointResponse = z.infer<typeof EndpointResponseSchema>;

// ==========================================
// Phase 4: Ingest & Event Module
// ==========================================

export const EventStatuses = ['pending', 'delivering', 'delivered', 'failed', 'dead'] as const;
export type EventStatus = (typeof EventStatuses)[number];

export const IngestResponseSchema = z.object({
  eventId: z.string(),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export const EventResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  endpointId: z.string(),
  receivedAt: z.string().datetime(),
  method: z.string(),
  headers: z.record(z.string()),
  rawBody: z.string(),
  bodySize: z.number(),
  contentType: z.string().nullable(),
  sourceIp: z.string(),
  signatureValid: z.boolean(),
  idempotencyKey: z.string(),
  status: z.enum(EventStatuses),
  attemptCount: z.number(),
  replayCount: z.number().default(0),
  lastAttemptAt: z.string().datetime().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
});

export type EventResponse = z.infer<typeof EventResponseSchema>;

// ==========================================
// Phase 5: Delivery & Worker Module
// ==========================================

export const DeliveryAttemptResponseSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  attemptNumber: z.number(),
  startedAt: z.string().datetime(),
  durationMs: z.number(),
  requestHeaders: z.record(z.string()),
  responseStatus: z.number(),
  responseBodySnippet: z.string(),
  error: z.string().nullable().optional(),
  success: z.boolean(),
  createdAt: z.string().datetime().optional(),
});

export type DeliveryAttemptResponse = z.infer<typeof DeliveryAttemptResponseSchema>;

export const EventPubSubMessageSchema = z.object({
  type: z.enum(['event.created', 'event.status_changed', 'event.dead']),
  eventId: z.string(),
  endpointId: z.string(),
  workspaceId: z.string(),
  status: z.enum(EventStatuses),
  attemptCount: z.number(),
  timestamp: z.string().datetime(),
  error: z.string().nullable().optional(),
});

export type EventPubSubMessage = z.infer<typeof EventPubSubMessageSchema>;

// ==========================================
// Phase 6: Events API, Search & Replay
// ==========================================

export const EventFilterQuerySchema = z.object({
  status: z.enum(EventStatuses).optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  signatureValid: z.union([z.boolean(), z.string().transform((val) => val === 'true')]).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type EventFilterQuery = z.infer<typeof EventFilterQuerySchema>;

export const PaginatedEventsResponseSchema = z.object({
  events: z.array(EventResponseSchema),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

export type PaginatedEventsResponse = z.infer<typeof PaginatedEventsResponseSchema>;

export const EventWithAttemptsResponseSchema = EventResponseSchema.extend({
  attempts: z.array(DeliveryAttemptResponseSchema),
});

export type EventWithAttemptsResponse = z.infer<typeof EventWithAttemptsResponseSchema>;

export const BulkReplayInputSchema = z.object({
  workspaceId: z.string(),
  endpointId: z.string().optional(),
  status: z.enum(['failed', 'dead']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type BulkReplayInput = z.infer<typeof BulkReplayInputSchema>;

export const BulkReplayResponseSchema = z.object({
  replayedCount: z.number(),
  eventIds: z.array(z.string()),
});

export type BulkReplayResponse = z.infer<typeof BulkReplayResponseSchema>;

export const ReplayEventResponseSchema = z.object({
  success: z.boolean(),
  eventId: z.string(),
  replayCount: z.number(),
  jobId: z.string(),
});

export type ReplayEventResponse = z.infer<typeof ReplayEventResponseSchema>;

export const AuditLogResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;

// ==========================================
// Phase 9: API Keys & CLI Tunnel
// ==========================================

export const CreateApiKeyInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(64).trim(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

export const ApiKeyResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdBy: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

export const CreateApiKeyResponseSchema = z.object({
  apiKey: ApiKeyResponseSchema,
  secretKey: z.string(),
});

export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;

export const TunnelEventMessageSchema = z.object({
  eventId: z.string(),
  endpointId: z.string(),
  endpointSlug: z.string(),
  method: z.string(),
  path: z.string().default('/'),
  headers: z.record(z.string()),
  rawBody: z.string(),
  timeoutMs: z.number().default(15000),
});

export type TunnelEventMessage = z.infer<typeof TunnelEventMessageSchema>;

export const TunnelResponseMessageSchema = z.object({
  eventId: z.string(),
  responseStatus: z.number(),
  responseHeaders: z.record(z.string()).optional(),
  responseBodySnippet: z.string().default(''),
  durationMs: z.number(),
  error: z.string().nullable().optional(),
});

export type TunnelResponseMessage = z.infer<typeof TunnelResponseMessageSchema>;

// ==========================================
// Phase 10: Analytics & Observability
// ==========================================

export const AnalyticsRangeSchema = z.enum(['1h', '24h', '7d']).default('24h');
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

export const AnalyticsQuerySchema = z.object({
  range: AnalyticsRangeSchema,
  endpointId: z.string().optional(),
});

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export const AnalyticsSummarySchema = z.object({
  total: z.number(),
  delivered: z.number(),
  failed: z.number(),
  pending: z.number(),
  successRate: z.number(),
});

export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;

export const AnalyticsTimeseriesPointSchema = z.object({
  timestamp: z.string(),
  total: z.number(),
  delivered: z.number(),
  failed: z.number(),
});

export type AnalyticsTimeseriesPoint = z.infer<typeof AnalyticsTimeseriesPointSchema>;

export const AnalyticsLatencyPercentilesSchema = z.object({
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
});

export type AnalyticsLatencyPercentiles = z.infer<typeof AnalyticsLatencyPercentilesSchema>;

export const AnalyticsFailureReasonSchema = z.object({
  reason: z.string(),
  count: z.number(),
});

export type AnalyticsFailureReason = z.infer<typeof AnalyticsFailureReasonSchema>;

export const AnalyticsResponseSchema = z.object({
  range: AnalyticsRangeSchema,
  summary: AnalyticsSummarySchema,
  timeseries: z.array(AnalyticsTimeseriesPointSchema),
  latency: AnalyticsLatencyPercentilesSchema,
  topFailures: z.array(AnalyticsFailureReasonSchema),
  cached: z.boolean().default(false),
});

export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
