/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import mongoose, { Types } from 'mongoose';
import dotenv from 'dotenv';
import { DeliveryModel } from '../apps/api/src/models/Delivery.js';
import { DeliveryAttemptModel } from '../apps/api/src/models/DeliveryAttempt.js';
import { EventModel } from '../apps/api/src/models/Event.js';
import { AlertRuleModel } from '../apps/api/src/models/AlertRule.js';
import { DestinationModel } from '../apps/api/src/models/Destination.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB. Running index explain analysis...\n');

  const wsId = new Types.ObjectId();
  const epId = new Types.ObjectId();
  const destId = new Types.ObjectId();
  const evtId = new Types.ObjectId();
  const windowStart = new Date(Date.now() - 3600000);

  // 1. Delivery: { workspaceId, status, updatedAt }
  const d1 = await DeliveryModel.find({
    workspaceId: wsId,
    status: 'dead',
    updatedAt: { $gte: windowStart },
  }).explain('executionStats');
  printExplain('Delivery { workspaceId, status, updatedAt }', d1);

  // 2. Delivery: { eventId }
  const d2 = await DeliveryModel.find({
    eventId: evtId,
  }).explain('executionStats');
  printExplain('Delivery { eventId }', d2);

  // 3. Delivery: { destinationId }
  const d3 = await DeliveryModel.find({
    destinationId: destId,
  }).explain('executionStats');
  printExplain('Delivery { destinationId }', d3);

  // 4. DeliveryAttempt: { workspaceId, status, createdAt }
  const da1 = await DeliveryAttemptModel.find({
    workspaceId: wsId,
    status: { $gte: 500 },
    createdAt: { $gte: windowStart },
  }).explain('executionStats');
  printExplain('DeliveryAttempt { workspaceId, status, createdAt }', da1);

  // 5. Event: { endpointId, receivedAt }
  const e1 = await EventModel.find({
    endpointId: epId,
    receivedAt: { $gte: windowStart },
  }).explain('executionStats');
  printExplain('Event { endpointId, receivedAt }', e1);

  // 6. AlertRule: { workspaceId, enabled }
  const ar1 = await AlertRuleModel.find({
    workspaceId: wsId,
    enabled: true,
  }).explain('executionStats');
  printExplain('AlertRule { workspaceId, enabled }', ar1);

  // 7. Destination: { endpointId, isActive }
  const dest1 = await DestinationModel.find({
    endpointId: epId,
    isActive: true,
  }).explain('executionStats');
  printExplain('Destination { endpointId, isActive }', dest1);

  await mongoose.disconnect();
}

function printExplain(label: string, exp: any) {
  const stats = exp.executionStats || exp;
  const stage =
    exp.queryPlanner?.winningPlan?.inputStage?.stage || exp.queryPlanner?.winningPlan?.stage;
  const indexName =
    exp.queryPlanner?.winningPlan?.inputStage?.indexName ||
    exp.queryPlanner?.winningPlan?.indexName ||
    exp.queryPlanner?.winningPlan?.inputStage?.inputStage?.indexName ||
    'COLLSCAN (No index)';

  console.log(`[QUERY] ${label}`);
  console.log(`  Stage:              ${stage}`);
  console.log(`  Index Used:         ${indexName}`);
  console.log(`  Docs Examined:      ${stats?.totalDocsExamined ?? 0}`);
  console.log(`  Keys Examined:      ${stats?.totalKeysExamined ?? 0}`);
  console.log(`  Docs Returned:      ${stats?.nReturned ?? 0}`);
  console.log(`  Execution Time:     ${stats?.executionTimeMillis ?? 0} ms`);
  console.log('');
}

main().catch(console.error);
