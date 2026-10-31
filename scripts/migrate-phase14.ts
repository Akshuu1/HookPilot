/**
 * Phase 14 Data Model Migration: Fan-Out Backend
 *
 * ROLLBACK NOTE:
 * ============================================================================
 * In case of rollback:
 * 1. Endpoint.destinationUrl was preserved as a deprecated read-only field and
 *    was NOT deleted or altered. All legacy endpoints retain their destinationUrl.
 * 2. To rollback database changes:
 *    a. Delete backfilled 'Default' destinations:
 *       await DestinationModel.deleteMany({ name: 'Default' });
 *    b. Delete migrated deliveries:
 *       await DeliveryModel.deleteMany({});
 *    c. Unset backfilled deliveryId & destinationId on delivery attempts:
 *       await DeliveryAttemptModel.updateMany({}, { $unset: { deliveryId: 1, destinationId: 1 } });
 * 3. Re-deploy pre-Phase 14 backend service.
 * ============================================================================
 */

/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose';
import dotenv from 'dotenv';
import { EndpointModel } from '../apps/api/src/models/Endpoint.js';
import { DestinationModel } from '../apps/api/src/models/Destination.js';
import { EventModel } from '../apps/api/src/models/Event.js';
import { DeliveryModel } from '../apps/api/src/models/Delivery.js';
import { DeliveryAttemptModel } from '../apps/api/src/models/DeliveryAttempt.js';
import type { DeliveryStatus } from '@hookpilot/shared';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  endpointsChecked: number;
  destinationsCreated: number;
  eventsChecked: number;
  deliveriesCreated: number;
  attemptsBackfilled: number;
}

export async function runMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');

  console.log(`\n🚀 Starting Phase 14 Fan-out Migration [DryRun: ${isDryRun}]`);
  console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);

  const result: MigrationResult = {
    endpointsChecked: 0,
    destinationsCreated: 0,
    eventsChecked: 0,
    deliveriesCreated: 0,
    attemptsBackfilled: 0,
  };

  // 1. Backfill 'Default' Destination for endpoints with destinationUrl and 0 destinations
  const endpoints = await EndpointModel.find();
  result.endpointsChecked = endpoints.length;

  for (const endpoint of endpoints) {
    if (!endpoint.destinationUrl) continue;

    const existingDestinations = await DestinationModel.countDocuments({
      endpointId: endpoint._id,
    });

    if (existingDestinations === 0) {
      if (!isDryRun) {
        await DestinationModel.create({
          workspaceId: endpoint.workspaceId,
          endpointId: endpoint._id,
          name: 'Default',
          url: endpoint.destinationUrl,
          customHeaders: [],
          isActive: endpoint.isActive ?? true,
          retryPolicy: endpoint.retryPolicy,
          rateLimitPerMin: endpoint.rateLimitPerMin ?? null,
        });
      }
      result.destinationsCreated++;
    }
  }

  // 2. Backfill Delivery rows for existing events mirroring their status
  const events = await EventModel.find();
  result.eventsChecked = events.length;

  for (const event of events) {
    // Find active destination(s) for the event's endpoint
    const destination = await DestinationModel.findOne({
      endpointId: event.endpointId,
    });

    if (!destination) continue;

    const existingDelivery = await DeliveryModel.findOne({
      eventId: event._id,
      destinationId: destination._id,
    });

    if (!existingDelivery) {
      let deliveryStatus: DeliveryStatus = 'pending';
      if (['delivered', 'failed', 'dead', 'filtered', 'cancelled'].includes(event.status)) {
        deliveryStatus = event.status as DeliveryStatus;
      } else if (event.status === 'captured') {
        deliveryStatus = 'pending';
      }

      let deliveryId: Types.ObjectId = new Types.ObjectId();

      if (!isDryRun) {
        const createdDelivery = await DeliveryModel.create({
          workspaceId: event.workspaceId,
          eventId: event._id,
          destinationId: destination._id,
          status: deliveryStatus,
          attemptCount: event.attemptCount ?? 0,
          nextAttemptAt: event.nextAttemptAt ?? null,
          lastError: null,
          filterReason: null,
        });
        deliveryId = createdDelivery._id as Types.ObjectId;
      }

      result.deliveriesCreated++;

      // Backfill deliveryId and destinationId on existing DeliveryAttempt rows for this event
      if (!isDryRun) {
        const updateRes = await DeliveryAttemptModel.updateMany(
          {
            eventId: event._id,
            $or: [{ deliveryId: null }, { deliveryId: { $exists: false } }],
          },
          {
            $set: {
              deliveryId,
              destinationId: destination._id,
            },
          },
        );
        result.attemptsBackfilled += updateRes.modifiedCount;
      } else {
        const count = await DeliveryAttemptModel.countDocuments({
          eventId: event._id,
          $or: [{ deliveryId: null }, { deliveryId: { $exists: false } }],
        });
        result.attemptsBackfilled += count;
      }
    }
  }

  console.log('\n📊 Migration Summary:');
  console.log(`  Endpoints checked:       ${result.endpointsChecked}`);
  console.log(`  Destinations created:    ${result.destinationsCreated}`);
  console.log(`  Events checked:          ${result.eventsChecked}`);
  console.log(`  Deliveries created:      ${result.deliveriesCreated}`);
  console.log(`  Attempts backfilled:     ${result.attemptsBackfilled}`);
  console.log(`  Dry run mode:            ${isDryRun}\n`);

  return result;
}

if (process.argv[1]?.endsWith('migrate-phase14.ts')) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => runMigration())
    .then(() => {
      console.log('✅ Migration completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}
