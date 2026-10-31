/**
 * Phase 19 Data Model Migration: GitHub & Google OAuth Login & Identities
 *
 * ROLLBACK NOTE:
 * ============================================================================
 * In case of rollback:
 * 1. The Identity collection is new and additive. Existing users, passwords,
 *    workspaces, and endpoints have not been deleted.
 * 2. To rollback database changes:
 *    a. Drop the identities collection:
 *       await mongoose.connection.collection('identities').drop();
 *    b. Drop indexes on identities collection if needed.
 *    c. Re-deploy pre-Phase 19 backend service.
 * ============================================================================
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { IdentityModel } from '../apps/api/src/models/Identity.js';
import { UserModel } from '../apps/api/src/models/User.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  indexesCreated: number;
  usersChecked: number;
  usersUpdated: number;
  identitiesChecked: number;
  dryRun: boolean;
}

export async function runMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');

  console.log(`\n🚀 Starting Phase 19 OAuth Migration [DryRun: ${isDryRun}]`);
  console.log(`Connecting to MongoDB at ${MONGODB_URI}...`);

  const result: MigrationResult = {
    indexesCreated: 0,
    usersChecked: 0,
    usersUpdated: 0,
    identitiesChecked: 0,
    dryRun: isDryRun,
  };

  // 1. Sync indexes on Identity and User models
  if (!isDryRun) {
    await IdentityModel.syncIndexes();
    await UserModel.syncIndexes();
    result.indexesCreated = 2;
  } else {
    result.indexesCreated = 2;
  }

  // 2. Ensure existing users have displayName and avatarUrl default fields
  const users = await UserModel.find({});
  result.usersChecked = users.length;

  for (const user of users) {
    let needsUpdate = false;
    const updates: Record<string, unknown> = {};

    if (user.displayName === undefined || user.displayName === null) {
      updates['displayName'] = user.name;
      needsUpdate = true;
    }

    if (user.avatarUrl === undefined) {
      updates['avatarUrl'] = null;
      needsUpdate = true;
    }

    if (needsUpdate) {
      result.usersUpdated += 1;
      if (!isDryRun) {
        await UserModel.updateOne({ _id: user._id }, { $set: updates });
      }
    }
  }

  const identities = await IdentityModel.find({});
  result.identitiesChecked = identities.length;

  console.log('\n📊 Phase 19 Migration Summary:');
  console.log(`  Indexes synchronized:  ${result.indexesCreated}`);
  console.log(`  Users checked:         ${result.usersChecked}`);
  console.log(`  Users updated:         ${result.usersUpdated}`);
  console.log(`  Identities checked:    ${result.identitiesChecked}`);
  console.log(`  Dry run mode:          ${result.dryRun}\n`);

  return result;
}

// Direct CLI execution
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-phase19-oauth.ts')
) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => runMigration())
    .then(() => {
      console.log('✅ Phase 19 migration completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Phase 19 migration failed:', err);
      process.exit(1);
    });
}
