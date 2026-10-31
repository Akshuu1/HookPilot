/**
 * Phase 17 Data Model Migration: Failure Alerts & Notification Engine
 *
 * ROLLBACK NOTE:
 * ============================================================================
 * In case of rollback:
 * 1. The AlertChannel, AlertRule, AlertState, and AlertHistory collections are new
 *    and additive. No existing business data in Endpoints, Events, or Deliveries
 *    has been modified or deleted.
 * 2. To rollback database changes:
 *    a. Drop new alert collections:
 *       await mongoose.connection.collection('alertchannels').drop();
 *       await mongoose.connection.collection('alertrules').drop();
 *       await mongoose.connection.collection('alertstates').drop();
 *       await mongoose.connection.collection('alerthistories').drop();
 *    b. Revert newly added indexes if desired:
 *       await DeliveryModel.collection.dropIndex('workspaceId_1_status_1_updatedAt_1');
 *       await DeliveryAttemptModel.collection.dropIndex('workspaceId_1_status_1_updatedAt_1');
 *       await DeliveryAttemptModel.collection.dropIndex('workspaceId_1_createdAt_1');
 *       await EventModel.collection.dropIndex('endpointId_1_receivedAt_1');
 * 3. Re-deploy pre-Phase 17 backend service.
 * ============================================================================
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { AlertChannelModel } from '../apps/api/src/models/AlertChannel.js';
import { AlertRuleModel } from '../apps/api/src/models/AlertRule.js';
import { AlertStateModel } from '../apps/api/src/models/AlertState.js';
import { AlertHistoryModel } from '../apps/api/src/models/AlertHistory.js';
import { DeliveryModel } from '../apps/api/src/models/Delivery.js';
import { DeliveryAttemptModel } from '../apps/api/src/models/DeliveryAttempt.js';
import { EventModel } from '../apps/api/src/models/Event.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  indexesCreated: number;
  rulesChecked: number;
  statesCreated: number;
  dryRun: boolean;
}

export async function runMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');

  console.log(`\n🚀 Starting Phase 17 Alerts Migration [DryRun: ${isDryRun}]`);
  console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);

  const result: MigrationResult = {
    indexesCreated: 0,
    rulesChecked: 0,
    statesCreated: 0,
    dryRun: isDryRun,
  };

  // 1. Sync indexes on new and existing models
  if (!isDryRun) {
    await AlertChannelModel.syncIndexes();
    await AlertRuleModel.syncIndexes();
    await AlertStateModel.syncIndexes();
    await AlertHistoryModel.syncIndexes();
    await DeliveryModel.syncIndexes();
    await DeliveryAttemptModel.syncIndexes();
    await EventModel.syncIndexes();
    result.indexesCreated = 7;
  } else {
    result.indexesCreated = 7;
  }

  // 2. Ensure every existing AlertRule has an associated AlertState
  const rules = await AlertRuleModel.find({});
  result.rulesChecked = rules.length;

  for (const rule of rules) {
    const existingState = await AlertStateModel.findOne({ ruleId: rule._id });
    if (!existingState) {
      result.statesCreated += 1;
      if (!isDryRun) {
        await AlertStateModel.create({
          ruleId: rule._id,
          status: 'ok',
          consecutiveClear: 0,
        });
      }
    }
  }

  console.log('\n📊 Phase 17 Migration Summary:');
  console.log(`  Indexes synchronized:  ${result.indexesCreated}`);
  console.log(`  Rules checked:         ${result.rulesChecked}`);
  console.log(`  Alert states created:  ${result.statesCreated}`);
  console.log(`  Dry run mode:          ${result.dryRun}\n`);

  return result;
}

// Direct CLI execution
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-phase17-alerts.ts')
) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => runMigration())
    .then(() => {
      console.log('✅ Phase 17 migration completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Phase 17 migration failed:', err);
      process.exit(1);
    });
}
