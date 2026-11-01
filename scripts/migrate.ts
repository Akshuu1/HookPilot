/* eslint-disable no-console */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { runMigration as runPhase14 } from './migrate-phase14.js';
import { runMigration as runPhase17 } from './migrate-phase17-alerts.js';
import { runMigration as runPhase19 } from './migrate-phase19-oauth.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

export async function runAllMigrations(options: { dryRun?: boolean } = {}) {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');

  console.log(`\n======================================================`);
  console.log(`🔄 Running HookPilot Unified Database Migrations`);
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (no writes)' : 'LIVE EXECUTION'}`);
  console.log(`======================================================\n`);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Connected to MongoDB successfully.\n');

  try {
    // 1. Phase 14 Fan-out
    console.log('--- Step 1: Phase 14 Fan-out Backend Migration ---');
    const res14 = await runPhase14({ dryRun: isDryRun });

    // 2. Phase 17 Failure Alerts & Notification Engine
    console.log('\n--- Step 2: Phase 17 Failure Alerts & Indexes Migration ---');
    const res17 = await runPhase17({ dryRun: isDryRun });

    // 3. Phase 19 OAuth Login & Identities
    console.log('\n--- Step 3: Phase 19 OAuth Login & Identities Migration ---');
    const res19 = await runPhase19({ dryRun: isDryRun });

    console.log(`\n======================================================`);
    console.log(`✅ All Migrations Completed Successfully!`);
    console.log(`Summary:`);
    console.log(
      `- Phase 14: ${res14.destinationsCreated} destinations created, ${res14.deliveriesCreated} deliveries created, ${res14.attemptsBackfilled} attempts backfilled`,
    );
    console.log(
      `- Phase 17: ${res17.indexesCreated} indexes synchronized, ${res17.statesCreated} alert states created`,
    );
    console.log(
      `- Phase 19: ${res19.usersUpdated} users updated, ${res19.indexesCreated} indexes synchronized`,
    );
    console.log(`======================================================\n`);

    return { res14, res17, res19 };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Migration failed: ${errorMsg}`);
    throw err;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  runAllMigrations()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration execution failed:', err);
      process.exit(1);
    });
}
