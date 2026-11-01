/* eslint-disable no-console */
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { EventStatuses } from '../packages/shared/src/index.js';
import { EndpointModel } from '../apps/api/src/models/Endpoint.js';
import { DestinationModel } from '../apps/api/src/models/Destination.js';
import { EventModel } from '../apps/api/src/models/Event.js';

dotenv.config();

interface DiagnosticItem {
  category: string;
  check: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  details: string;
}

const results: DiagnosticItem[] = [];

async function runDoctor(): Promise<void> {
  console.log('\n======================================================');
  console.log('🩺 HookPilot System Diagnostic Tool (doctor)');
  console.log('======================================================\n');

  // 1. Environment Variable Checks (Names only, NEVER secret values)
  const coreVars = [
    { name: 'MONGODB_URI', val: process.env.MONGODB_URI },
    { name: 'REDIS_URL', val: process.env.REDIS_URL },
    { name: 'JWT_ACCESS_SECRET', val: process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET },
    { name: 'ENCRYPTION_KEY', val: process.env.ENCRYPTION_KEY },
  ];

  for (const { name, val } of coreVars) {
    if (val && val.trim().length > 0) {
      results.push({
        category: 'Environment (Core)',
        check: name,
        status: 'PASS',
        details: 'Configured',
      });
    } else {
      results.push({
        category: 'Environment (Core)',
        check: name,
        status: 'FAIL',
        details: 'Missing (Required for production)',
      });
    }
  }

  const optionalVars = [
    { name: 'API_PUBLIC_URL', val: process.env.API_PUBLIC_URL },
    { name: 'FRONTEND_URL', val: process.env.FRONTEND_URL },
    { name: 'GITHUB_CLIENT_ID', val: process.env.GITHUB_CLIENT_ID },
    { name: 'GITHUB_CLIENT_SECRET', val: process.env.GITHUB_CLIENT_SECRET },
    { name: 'GOOGLE_CLIENT_ID', val: process.env.GOOGLE_CLIENT_ID },
    { name: 'GOOGLE_CLIENT_SECRET', val: process.env.GOOGLE_CLIENT_SECRET },
    { name: 'SMTP_HOST', val: process.env.SMTP_HOST },
    { name: 'SLACK_WEBHOOK_URL', val: process.env.SLACK_WEBHOOK_URL },
  ];

  for (const { name, val } of optionalVars) {
    if (val && val.trim().length > 0) {
      results.push({
        category: 'Environment (Feature)',
        check: name,
        status: 'PASS',
        details: 'Configured',
      });
    } else {
      results.push({
        category: 'Environment (Feature)',
        check: name,
        status: 'WARN',
        details: 'Not configured (feature disabled)',
      });
    }
  }

  // 2. MongoDB Connectivity Check
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';
  let mongoConnected = false;
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    const adminDb = mongoose.connection.db?.admin();
    if (adminDb) {
      await adminDb.ping();
      results.push({
        category: 'Database',
        check: 'MongoDB Connectivity',
        status: 'PASS',
        details: 'Successfully connected and pinged admin db',
      });
      mongoConnected = true;
    } else {
      results.push({
        category: 'Database',
        check: 'MongoDB Connectivity',
        status: 'FAIL',
        details: 'Admin DB unreachable',
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({
      category: 'Database',
      check: 'MongoDB Connectivity',
      status: 'FAIL',
      details: `Connection failed: ${errorMsg}`,
    });
  }

  // 3. Redis Connectivity Check
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  let redisClient: Redis | null = null;
  let redisConnected = false;
  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    redisClient.on('error', () => {
      // Suppress unhandled event error
    });
    await redisClient.connect();
    const pong = await redisClient.ping();
    if (pong === 'PONG') {
      results.push({
        category: 'Redis',
        check: 'Redis Connectivity',
        status: 'PASS',
        details: 'PONG received',
      });
      redisConnected = true;
    } else {
      results.push({
        category: 'Redis',
        check: 'Redis Connectivity',
        status: 'FAIL',
        details: `Unexpected response: ${pong}`,
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({
      category: 'Redis',
      check: 'Redis Connectivity',
      status: 'FAIL',
      details: `Connection failed: ${errorMsg}`,
    });
  }

  // 4. BullMQ Queue Check
  if (redisConnected && redisClient) {
    let queue: Queue | null = null;
    try {
      queue = new Queue('webhook-delivery', {
        connection: redisClient as any,
        prefix: 'hp',
      });
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
      results.push({
        category: 'Queue (BullMQ)',
        check: 'Delivery Queue',
        status: 'PASS',
        details: `Connected (waiting: ${counts.waiting}, active: ${counts.active}, completed: ${counts.completed}, failed: ${counts.failed})`,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        category: 'Queue (BullMQ)',
        check: 'Delivery Queue',
        status: 'FAIL',
        details: `Queue connection failed: ${errorMsg}`,
      });
    } finally {
      if (queue) {
        await queue.close();
      }
    }
  } else {
    results.push({
      category: 'Queue (BullMQ)',
      check: 'Delivery Queue',
      status: 'FAIL',
      details: 'Skipped due to Redis connection failure',
    });
  }

  // 5. Endpoint Destinations Check
  if (mongoConnected) {
    try {
      const totalEndpoints = await EndpointModel.countDocuments();
      const endpoints = await EndpointModel.find().lean();
      let unmigratedCount = 0;
      for (const ep of endpoints) {
        const count = await DestinationModel.countDocuments({ endpointId: ep._id });
        if (count === 0) unmigratedCount++;
      }

      if (unmigratedCount === 0) {
        results.push({
          category: 'Data Integrity',
          check: 'Endpoint Destinations',
          status: 'PASS',
          details: `All ${totalEndpoints} endpoints have at least one Destination configured`,
        });
      } else {
        results.push({
          category: 'Data Integrity',
          check: 'Endpoint Destinations',
          status: 'WARN',
          details: `${unmigratedCount} of ${totalEndpoints} endpoints have 0 destinations. Run 'npm run migrate'`,
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        category: 'Data Integrity',
        check: 'Endpoint Destinations',
        status: 'FAIL',
        details: `Check error: ${errorMsg}`,
      });
    }

    // 6. Event Status Integrity Check
    try {
      const totalEvents = await EventModel.countDocuments();
      const validStatuses = new Set(EventStatuses);
      const invalidStatusCount = await EventModel.countDocuments({
        status: { $nin: Array.from(validStatuses) },
      });

      if (invalidStatusCount === 0) {
        results.push({
          category: 'Data Integrity',
          check: 'Event Status Validity',
          status: 'PASS',
          details: `All ${totalEvents} events have valid status in [${Array.from(validStatuses).join(', ')}]`,
        });
      } else {
        results.push({
          category: 'Data Integrity',
          check: 'Event Status Validity',
          status: 'WARN',
          details: `${invalidStatusCount} events have null or unexpected status`,
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        category: 'Data Integrity',
        check: 'Event Status Validity',
        status: 'FAIL',
        details: `Check error: ${errorMsg}`,
      });
    }
  }

  // Cleanup connections
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      // ignore
    }
  }
  if (mongoConnected) {
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
  }

  // Print results table
  console.log('\n--- DIAGNOSTIC RESULTS TABLE ---');
  console.log(
    '--------------------------------------------------------------------------------------------------',
  );
  console.log(
    `| ${'STATUS'.padEnd(6)} | ${'CATEGORY'.padEnd(23)} | ${'CHECK'.padEnd(25)} | ${'DETAILS'.padEnd(34)} |`,
  );
  console.log(
    '--------------------------------------------------------------------------------------------------',
  );
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅ PASS' : r.status === 'WARN' ? '⚠️ WARN' : '❌ FAIL';
    console.log(
      `| ${icon.padEnd(6)} | ${r.category.padEnd(23)} | ${r.check.padEnd(25)} | ${r.details.slice(0, 34).padEnd(34)} |`,
    );
  }
  console.log(
    '--------------------------------------------------------------------------------------------------\n',
  );

  const hasFailures = results.some((r) => r.status === 'FAIL');
  if (hasFailures) {
    console.log('❌ Diagnostic failed. Please fix the FAIL items above.\n');
    process.exit(1);
  } else {
    console.log('✅ All core diagnostics passed!\n');
    process.exit(0);
  }
}

runDoctor().catch((err) => {
  console.error('Fatal doctor execution error:', err);
  process.exit(1);
});
