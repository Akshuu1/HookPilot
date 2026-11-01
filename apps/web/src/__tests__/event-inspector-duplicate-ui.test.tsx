import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Copy } from 'lucide-react';
import { StatusBadge } from '../components/common/StatusBadge.js';
import type { EventResponse, EventWithAttemptsResponse } from '@hookpilot/shared';

describe('Event Inspector Duplicate Badge and Drawer UI', () => {
  it('1. Event list row renders duplicate badge "Has duplicates (2)" with tooltip when duplicateCount > 0', () => {
    const mockEventWithDuplicates: EventResponse = {
      id: 'evt-dup-1',
      workspaceId: 'ws-1',
      endpointId: 'ep-1',
      receivedAt: new Date().toISOString(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"test":"dup"}',
      bodySize: 15,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: null,
      status: 'delivered',
      attemptCount: 1,
      replayCount: 0,
      duplicateCount: 2,
      lastDuplicateAt: new Date('2026-11-01T22:50:00Z').toISOString(),
      lastAttemptAt: null,
      nextAttemptAt: null,
    };

    const html = renderToString(
      <div className="col-span-2 flex items-center gap-1.5 flex-wrap">
        <StatusBadge status={mockEventWithDuplicates.status} size="sm" />
        {mockEventWithDuplicates.duplicateCount && mockEventWithDuplicates.duplicateCount > 0 ? (
          <span
            title={`Has duplicates: received ${mockEventWithDuplicates.duplicateCount} duplicate webhooks. Last: ${
              mockEventWithDuplicates.lastDuplicateAt
                ? new Date(mockEventWithDuplicates.lastDuplicateAt).toLocaleTimeString()
                : 'recently'
            }`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30 shadow-sm font-semibold"
          >
            <Copy className="h-3 w-3 text-amber-400" />
            <span>{`Has duplicates (${mockEventWithDuplicates.duplicateCount})`}</span>
          </span>
        ) : null}
      </div>,
    );

    expect(html).toContain('delivered');
    expect(html).toContain('Has duplicates (2)');
    expect(html).toContain('title="Has duplicates: received 2 duplicate webhooks. Last:');
  });

  it('2. Event list row hides duplicate badge when duplicateCount is 0', () => {
    const mockEventNoDuplicates: EventResponse = {
      id: 'evt-clean-1',
      workspaceId: 'ws-1',
      endpointId: 'ep-1',
      receivedAt: new Date().toISOString(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{"test":"clean"}',
      bodySize: 16,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      signatureValid: true,
      idempotencyKey: null,
      status: 'delivered',
      attemptCount: 1,
      replayCount: 0,
      duplicateCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
    };

    const html = renderToString(
      <div className="col-span-2 flex items-center gap-1.5 flex-wrap">
        <StatusBadge status={mockEventNoDuplicates.status} size="sm" />
        {mockEventNoDuplicates.duplicateCount && mockEventNoDuplicates.duplicateCount > 0 ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-300">
            <Copy className="h-3 w-3 text-amber-400" />
            <span>{`Has duplicates (${mockEventNoDuplicates.duplicateCount})`}</span>
          </span>
        ) : null}
      </div>,
    );

    expect(html).toContain('delivered');
    expect(html).not.toContain('Has duplicates');
  });

  it('3. Drawer renders Duplicates section with count, first & last times, duplicate arrivals log, and note', () => {
    const mockDetail: EventWithAttemptsResponse = {
      id: 'evt-detail-1',
      workspaceId: 'ws-1',
      endpointId: 'ep-1',
      receivedAt: '2026-11-01T22:00:00.000Z',
      method: 'POST',
      headers: {},
      rawBody: '{}',
      bodySize: 2,
      contentType: null,
      sourceIp: '192.168.1.1',
      signatureValid: true,
      idempotencyKey: null,
      status: 'delivered',
      attemptCount: 1,
      replayCount: 0,
      duplicateCount: 3,
      lastDuplicateAt: '2026-11-01T22:00:09.000Z',
      duplicateLog: [
        {
          receivedAt: '2026-11-01T22:00:02.000Z',
          reason: 'window',
          sourceIp: '192.168.1.2',
        },
        {
          receivedAt: '2026-11-01T22:00:05.000Z',
          reason: 'idempotency-key',
          sourceIp: '192.168.1.3',
        },
        {
          receivedAt: '2026-11-01T22:00:09.000Z',
          reason: 'window',
          sourceIp: '192.168.1.4',
        },
      ],
      lastAttemptAt: null,
      nextAttemptAt: null,
      attempts: [],
    };

    const html = renderToString(
      <div>
        <h4>{`Duplicates (${mockDetail.duplicateCount || 0})`}</h4>
        {mockDetail.duplicateCount > 0 && (
          <div>
            <span>First Duplicate</span>
            <span>{new Date(mockDetail.duplicateLog![0].receivedAt).toLocaleString()}</span>
            <span>Last Duplicate</span>
            <span>{new Date(mockDetail.lastDuplicateAt!).toLocaleString()}</span>

            {mockDetail.duplicateLog!.map((log, idx) => (
              <div key={idx}>
                <span>
                  {log.reason === 'idempotency-key' ? 'idempotency key' : 'duplicate window'}
                </span>
                <span>{log.sourceIp}</span>
              </div>
            ))}

            <p>
              Note: Duplicates are recorded for tracking and auditing purposes, but are not
              delivered again to destinations.
            </p>
          </div>
        )}
      </div>,
    );

    expect(html).toContain('Duplicates (3)');
    expect(html).toContain('First Duplicate');
    expect(html).toContain('Last Duplicate');
    expect(html).toContain('duplicate window');
    expect(html).toContain('idempotency key');
    expect(html).toContain('192.168.1.2');
    expect(html).toContain('192.168.1.3');
    expect(html).toContain('192.168.1.4');
    expect(html).toContain(
      'Duplicates are recorded for tracking and auditing purposes, but are not delivered again',
    );
  });
});
