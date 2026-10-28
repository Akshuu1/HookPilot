import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import { EventService } from '../event.service.js';
import type { EventRepository } from '../../repositories/event.repository.js';
import type { AuditLogRepository } from '../../repositories/audit-log.repository.js';
import type { IEvent } from '../../models/Event.js';
import type { IAuditLog } from '../../models/AuditLog.js';
import * as queueConfig from '../../config/queue.js';

describe('EventService Unit Tests', () => {
  let mockEventRepo: Partial<EventRepository>;
  let mockAuditLogRepo: Partial<AuditLogRepository>;
  let service: EventService;
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

  beforeEach(() => {
    vi.clearAllMocks();

    mockEventRepo = {
      findById: vi.fn(),
      findEndpointEvents: vi.fn(),
      findByIdWithAttempts: vi.fn(),
      replay: vi.fn(),
      findEventsForBulkReplay: vi.fn(),
      delete: vi.fn(),
    };

    mockAuditLogRepo = {
      create: vi.fn().mockResolvedValue({} as unknown as IAuditLog),
    };

    vi.spyOn(queueConfig, 'getDeliveryQueue').mockReturnValue({
      add: mockQueueAdd,
    } as unknown as Queue);

    service = new EventService(
      mockEventRepo as EventRepository,
      mockAuditLogRepo as AuditLogRepository,
    );
  });

  it('replays an event, enqueues BullMQ job with eventId-replayCount, and writes audit log', async () => {
    const eventId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439022';
    const workspaceId = '507f1f77bcf86cd799439033';

    mockEventRepo.findById = vi.fn().mockResolvedValue({
      id: eventId,
      _id: eventId,
      status: 'failed',
      workspaceId,
    } as unknown as IEvent);

    mockEventRepo.replay = vi.fn().mockResolvedValue({
      id: eventId,
      _id: eventId,
      status: 'pending',
      replayCount: 1,
      workspaceId,
    } as unknown as IEvent);

    const result = await service.replayEvent(eventId, userId);

    expect(result.success).toBe(true);
    expect(result.eventId).toBe(eventId);
    expect(result.replayCount).toBe(1);
    expect(result.jobId).toBe(`${eventId}-1`);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'deliver',
      { eventId, attemptNumber: 1 },
      { jobId: `${eventId}-1`, attempts: 1, removeOnComplete: true },
    );

    expect(mockAuditLogRepo.create).toHaveBeenCalledWith({
      workspaceId,
      userId,
      action: 'event.replay',
      resourceType: 'event',
      resourceId: eventId,
      metadata: {
        replayCount: 1,
        previousStatus: 'failed',
      },
    });
  });

  it('enqueues bulk replay in batches of 50 and records audit log', async () => {
    const workspaceId = '507f1f77bcf86cd799439033';
    const userId = '507f1f77bcf86cd799439022';

    // Mock 120 matching events
    const mockEvents = Array.from({ length: 120 }, (_, idx) => ({
      id: `evt-${idx}`,
      _id: `evt-${idx}`,
      workspaceId,
      replayCount: 0,
    }));

    mockEventRepo.findEventsForBulkReplay = vi
      .fn()
      .mockResolvedValue(mockEvents as unknown as IEvent[]);
    mockEventRepo.replay = vi.fn().mockImplementation((id: string) => {
      return Promise.resolve({
        id,
        _id: id,
        workspaceId,
        replayCount: 1,
      } as unknown as IEvent);
    });

    const result = await service.bulkReplay({ workspaceId }, userId);

    expect(result.replayedCount).toBe(120);
    expect(result.eventIds).toHaveLength(120);
    expect(mockQueueAdd).toHaveBeenCalledTimes(120);

    expect(mockAuditLogRepo.create).toHaveBeenCalledWith({
      workspaceId,
      userId,
      action: 'event.bulk_replay',
      resourceType: 'event',
      resourceId: workspaceId,
      metadata: expect.objectContaining({
        replayedCount: 120,
      }),
    });
  });

  it('deletes an event and writes audit log', async () => {
    const eventId = '507f1f77bcf86cd799439011';
    const userId = '507f1f77bcf86cd799439022';
    const workspaceId = '507f1f77bcf86cd799439033';

    mockEventRepo.findById = vi.fn().mockResolvedValue({
      id: eventId,
      _id: eventId,
      status: 'dead',
      workspaceId,
    } as unknown as IEvent);

    mockEventRepo.delete = vi.fn().mockResolvedValue(true);

    await service.deleteEvent(eventId, userId);

    expect(mockEventRepo.delete).toHaveBeenCalledWith(eventId);
    expect(mockAuditLogRepo.create).toHaveBeenCalledWith({
      workspaceId,
      userId,
      action: 'event.delete',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { deletedStatus: 'dead' },
    });
  });
});
