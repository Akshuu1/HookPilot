/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { EndpointModel } from '../apps/api/src/models/Endpoint.js';
import { EventModel } from '../apps/api/src/models/Event.js';

dotenv.config();

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface DuplicateWindowMigrationResult {
  endpointsUpdated: number;
  eventsUpdatedDuplicateCount: number;
  bodyHashKeysRemoved: number;
  explicitKeysPreserved: number;
  indexesUpdated: number;
}

export async function runMigration(
  options: MigrationOptions = {},
): Promise<DuplicateWindowMigrationResult> {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');

  console.log(`\n======================================================`);
  console.log(`🔄 Running Duplicate Window & Idempotency Key Migration`);
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (no writes)' : 'LIVE EXECUTION'}`);
  console.log(`======================================================\n`);

  const result: DuplicateWindowMigrationResult = {
    endpointsUpdated: 0,
    eventsUpdatedDuplicateCount: 0,
    bodyHashKeysRemoved: 0,
    explicitKeysPreserved: 0,
    indexesUpdated: 0,
  };

  // 1. Set duplicateWindowSeconds = 10 on existing endpoints
  const endpointsToUpdate = await EndpointModel.find({
    $or: [{ duplicateWindowSeconds: { $exists: false } }, { duplicateWindowSeconds: null }],
  });
  result.endpointsUpdated = endpointsToUpdate.length;
  console.log(`Endpoints needing duplicateWindowSeconds backfill: ${result.endpointsUpdated}`);

  if (!isDryRun && result.endpointsUpdated > 0) {
    await EndpointModel.updateMany(
      {
        $or: [{ duplicateWindowSeconds: { $exists: false } }, { duplicateWindowSeconds: null }],
      },
      { $set: { duplicateWindowSeconds: 10 } },
    );
  }

  // 2. Set duplicateCount = 0 on old events where duplicateCount is not set
  const eventsNeedingDuplicateCount = await EventModel.countDocuments({
    $or: [{ duplicateCount: { $exists: false } }, { duplicateCount: null }],
  });
  result.eventsUpdatedDuplicateCount = eventsNeedingDuplicateCount;
  console.log(`Events needing duplicateCount backfill: ${result.eventsUpdatedDuplicateCount}`);

  if (!isDryRun && eventsNeedingDuplicateCount > 0) {
    await EventModel.updateMany(
      {
        $or: [{ duplicateCount: { $exists: false } }, { duplicateCount: null }],
      },
      {
        $set: {
          duplicateCount: 0,
          lastDuplicateAt: null,
          duplicateLog: [],
        },
      },
    );
  }

  // 3. Scan events with idempotencyKey and remove legacy body-hash derived keys
  const eventsWithKey = await EventModel.find({
    idempotencyKey: { $exists: true, $nin: [null, ''] },
  }).lean();

  const idsToUnsetKey: mongoose.Types.ObjectId[] = [];

  for (const evt of eventsWithKey) {
    const key = evt.idempotencyKey as string;
    let isExplicit = false;

    // Check headers
    if (evt.headers) {
      const headersMap =
        evt.headers instanceof Map
          ? Object.fromEntries(evt.headers)
          : (evt.headers as Record<string, unknown>);

      for (const [hKey, hVal] of Object.entries(headersMap)) {
        const lowerHKey = hKey.toLowerCase();
        if (
          [
            'idempotency-key',
            'x-idempotency-key',
            'x-github-delivery',
            'x-shopify-webhook-id',
            'webhook-id',
          ].includes(lowerHKey)
        ) {
          const strVal = Array.isArray(hVal) ? String(hVal[0] || '') : String(hVal || '');
          if (strVal.trim() === key.trim()) {
            isExplicit = true;
            break;
          }
        }
      }
    }

    // Check body if JSON has id or event_id matching key
    if (!isExplicit && evt.rawBody && typeof evt.rawBody === 'string') {
      try {
        const parsed = JSON.parse(evt.rawBody);
        if (parsed && typeof parsed === 'object') {
          if (String(parsed.id || '').trim() === key.trim()) {
            isExplicit = true;
          } else if (String(parsed.event_id || '').trim() === key.trim()) {
            isExplicit = true;
          }
        }
      } catch {
        // Not JSON
      }
    }

    // Check if key is a 64-char sha256 hex digest
    const isSha256 = /^[0-9a-f]{64}$/i.test(key);
    const expectedLegacyHash = evt.rawBody
      ? createHash('sha256').update(`${evt.endpointId}:${evt.rawBody}`).digest('hex')
      : null;

    if (!isExplicit && (isSha256 || key === expectedLegacyHash)) {
      idsToUnsetKey.push(evt._id as mongoose.Types.ObjectId);
      result.bodyHashKeysRemoved++;
    } else {
      result.explicitKeysPreserved++;
    }
  }

  console.log(`Legacy body-hash keys detected to remove: ${idsToUnsetKey.length}`);
  console.log(`Explicit idempotency keys preserved: ${result.explicitKeysPreserved}`);

  if (!isDryRun && idsToUnsetKey.length > 0) {
    // Process in batches
    const batchSize = 1000;
    for (let i = 0; i < idsToUnsetKey.length; i += batchSize) {
      const chunk = idsToUnsetKey.slice(i, i + batchSize);
      await EventModel.updateMany({ _id: { $in: chunk } }, { $unset: { idempotencyKey: 1 } });
    }
  }

  // 4. Update index: drop old index and recreate with partialFilterExpression
  if (!isDryRun) {
    try {
      const collection = mongoose.connection.collection('events');
      const existingIndexes = await collection.indexes();
      const oldIndex = existingIndexes.find(
        (idx) => idx.key && idx.key.endpointId === 1 && idx.key.idempotencyKey === 1,
      );

      if (oldIndex && oldIndex.name) {
        console.log(`Dropping old index '${oldIndex.name}'...`);
        await collection.dropIndex(oldIndex.name);
      }

      console.log(
        'Creating partialFilterExpression index for { endpointId: 1, idempotencyKey: 1 }...',
      );
      await collection.createIndex(
        { endpointId: 1, idempotencyKey: 1 },
        {
          unique: true,
          partialFilterExpression: { idempotencyKey: { $type: 'string' } },
          name: 'endpointId_1_idempotencyKey_1_partial',
        },
      );
      result.indexesUpdated++;
    } catch (idxErr) {
      console.warn('Index sync note:', idxErr instanceof Error ? idxErr.message : String(idxErr));
    }
  }

  console.log(`\n✅ Duplicate Window migration completed.`);
  console.log(`Summary:`);
  console.log(`- Endpoints backfilled: ${result.endpointsUpdated}`);
  console.log(`- Events duplicateCount backfilled: ${result.eventsUpdatedDuplicateCount}`);
  console.log(`- Body-hash keys removed: ${result.bodyHashKeysRemoved}`);
  console.log(`- Explicit keys preserved: ${result.explicitKeysPreserved}`);
  console.log(`- Indexes updated: ${result.indexesUpdated}\n`);

  return result;
}

// Standalone execution
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-duplicate-window.ts')
) {
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';
  console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);
  mongoose
    .connect(MONGODB_URI)
    .then(() => runMigration())
    .then(() => {
      console.log('Migration finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration error:', err);
      process.exit(1);
    });
}
