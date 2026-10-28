/* eslint-disable no-console */
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { UserModel } from '../apps/api/src/models/User.js';
import { WorkspaceModel } from '../apps/api/src/models/Workspace.js';
import { MembershipModel } from '../apps/api/src/models/Membership.js';
import { EndpointModel } from '../apps/api/src/models/Endpoint.js';
import { EventModel } from '../apps/api/src/models/Event.js';
import { DeliveryAttemptModel } from '../apps/api/src/models/DeliveryAttempt.js';
import { ApiKeyModel } from '../apps/api/src/models/ApiKey.js';
import { encryptSecret } from '../apps/api/src/utils/crypto.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hookpilot';

export async function seed(): Promise<void> {
  console.log(`\n🌱 Connecting to MongoDB at ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  console.log('🧹 Preparing demo user and workspace...');

  // 1. Upsert Demo User
  const demoEmail = 'demo@hookpilot.dev';
  const passwordHash = await bcrypt.hash('Password123!', 10);

  let demoUser = await UserModel.findOne({ email: demoEmail });
  if (!demoUser) {
    demoUser = await UserModel.create({
      email: demoEmail,
      name: 'Demo Explorer',
      passwordHash,
    });
  } else {
    demoUser.passwordHash = passwordHash;
    demoUser.name = 'Demo Explorer';
    await demoUser.save();
  }

  // 2. Upsert Demo Workspace
  let demoWorkspace = await WorkspaceModel.findOne({ slug: 'demo' });
  if (!demoWorkspace) {
    demoWorkspace = await WorkspaceModel.create({
      name: 'HookPilot Demo',
      slug: 'demo',
      ownerId: demoUser._id,
      retentionDays: 30,
    });
  }

  // 3. Upsert Membership
  await MembershipModel.findOneAndUpdate(
    { userId: demoUser._id, workspaceId: demoWorkspace._id },
    { role: 'owner' },
    { upsert: true, new: true },
  );

  // 4. Upsert Sample Endpoints
  const endpointsData = [
    {
      name: 'Stripe Payments',
      slug: 'stripe-payments',
      destinationUrl: 'https://httpbin.org/post',
      signatureConfig: {
        provider: 'stripe' as const,
        secretEncrypted: encryptSecret('whsec_demo_stripe_secret_12345'),
        headerName: 'Stripe-Signature',
        enforce: false,
      },
      retryPolicy: {
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
      },
      rateLimitPerMin: 60000,
      isActive: true,
      mode: 'forward' as const,
    },
    {
      name: 'Shopify Orders',
      slug: 'shopify-orders',
      destinationUrl: 'https://httpbin.org/post',
      signatureConfig: {
        provider: 'generic' as const,
        secretEncrypted: encryptSecret('shpss_demo_shopify_secret_67890'),
        headerName: 'X-Shopify-Hmac-SHA256',
        enforce: false,
      },
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 30000,
      },
      rateLimitPerMin: 30000,
      isActive: true,
      mode: 'forward' as const,
    },
    {
      name: 'GitHub CI/CD',
      slug: 'github-actions',
      destinationUrl: 'https://httpbin.org/post',
      signatureConfig: {
        provider: 'github' as const,
        secretEncrypted: encryptSecret('gh_demo_secret_token_abcdef'),
        headerName: 'X-Hub-Signature-256',
        enforce: false,
      },
      retryPolicy: {
        maxAttempts: 4,
        baseDelayMs: 1500,
        maxDelayMs: 45000,
      },
      rateLimitPerMin: 10000,
      isActive: true,
      mode: 'forward' as const,
    },
  ];

  const seededEndpoints: InstanceType<typeof EndpointModel>[] = [];
  for (const ep of endpointsData) {
    let endpoint = await EndpointModel.findOne({ slug: ep.slug });
    if (!endpoint) {
      endpoint = await EndpointModel.create({
        ...ep,
        workspaceId: demoWorkspace._id,
      });
    } else {
      Object.assign(endpoint, ep, { workspaceId: demoWorkspace._id });
      await endpoint.save();
    }
    seededEndpoints.push(endpoint);
  }

  // 5. Clean existing demo events to avoid duplicates
  await EventModel.deleteMany({ workspaceId: demoWorkspace._id });

  const stripeEndpoint = seededEndpoints.find((e) => e.slug === 'stripe-payments')!;
  const shopifyEndpoint = seededEndpoints.find((e) => e.slug === 'shopify-orders')!;
  const githubEndpoint = seededEndpoints.find((e) => e.slug === 'github-actions')!;

  const now = Date.now();

  // Helper to generate events + attempts
  const seedEvent = async (params: {
    endpoint: InstanceType<typeof EndpointModel>;
    receivedAt: Date;
    method: string;
    headers: Record<string, string>;
    rawBody: string;
    status: 'pending' | 'queued' | 'delivering' | 'delivered' | 'failed' | 'dead';
    attempts: Array<{
      status: number;
      durationMs: number;
      body: string;
      error?: string;
      success: boolean;
    }>;
  }) => {
    const searchIndex = `${JSON.stringify(params.headers)} ${params.rawBody}`;
    const event = await EventModel.create({
      workspaceId: demoWorkspace._id,
      endpointId: params.endpoint._id,
      receivedAt: params.receivedAt,
      method: params.method,
      headers: params.headers,
      rawBody: params.rawBody,
      bodySize: Buffer.byteLength(params.rawBody),
      contentType: params.headers['content-type'] || 'application/json',
      sourceIp: '198.51.100.42',
      signatureValid: true,
      idempotencyKey: crypto.randomUUID(),
      status: params.status,
      attemptCount: params.attempts.length,
      replayCount: 0,
      searchIndex,
      lastAttemptAt: params.attempts.length > 0 ? params.receivedAt : null,
      createdAt: params.receivedAt,
      updatedAt: params.receivedAt,
    });

    for (let i = 0; i < params.attempts.length; i++) {
      const att = params.attempts[i]!;
      await DeliveryAttemptModel.create({
        eventId: event._id,
        attemptNumber: i + 1,
        startedAt: new Date(params.receivedAt.getTime() + i * 2000),
        durationMs: att.durationMs,
        requestHeaders: params.headers,
        responseStatus: att.status,
        responseBodySnippet: att.body,
        error: att.error || null,
        success: att.success,
      });
    }

    return event;
  };

  console.log('📦 Seeding sample webhook events & delivery attempts...');

  // Stripe Event 1: Delivered checkout session
  await seedEvent({
    endpoint: stripeEndpoint,
    receivedAt: new Date(now - 120000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      'stripe-signature': 't=1700000000,v1=9876543210abcdef',
    },
    rawBody: JSON.stringify(
      {
        id: 'evt_3Mvw92LkdIwHu7ix0GqR4demo',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_a1b2c3d4',
            amount_total: 14900,
            currency: 'usd',
            customer_email: 'sarah.connor@example.com',
            payment_status: 'paid',
          },
        },
      },
      null,
      2,
    ),
    status: 'delivered',
    attempts: [
      {
        status: 200,
        durationMs: 46,
        body: '{"status":"received","orderId":"ord_99482"}',
        success: true,
      },
    ],
  });

  // Stripe Event 2: Delivered customer subscription
  await seedEvent({
    endpoint: stripeEndpoint,
    receivedAt: new Date(now - 90000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      'stripe-signature': 't=1700000030,v1=abcdef1234567890',
    },
    rawBody: JSON.stringify(
      {
        id: 'evt_3Mvw92LkdIwHu7ix0Subscription',
        object: 'event',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_1OaBcd2eZvKYlo2C',
            customer: 'cus_P9qLk1vdemo',
            plan: {
              id: 'price_enterprise_monthly',
              amount: 29900,
              currency: 'usd',
            },
            status: 'active',
          },
        },
      },
      null,
      2,
    ),
    status: 'delivered',
    attempts: [
      {
        status: 200,
        durationMs: 62,
        body: '{"ok":true,"accountUpdated":true}',
        success: true,
      },
    ],
  });

  // Shopify Event 1: Delivered Order Creation
  await seedEvent({
    endpoint: shopifyEndpoint,
    receivedAt: new Date(now - 60000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': 'acme-store.myshopify.com',
      'x-shopify-hmac-sha256': 'dGVzdC1zaWduYXR1cmUtZGVtbw==',
    },
    rawBody: JSON.stringify(
      {
        id: 8209829119461546,
        email: 'jon.snow@winterfell.org',
        total_price: '54.00',
        currency: 'USD',
        line_items: [
          {
            title: 'Valyrian Steel Sword Polish',
            quantity: 2,
            price: '27.00',
          },
        ],
      },
      null,
      2,
    ),
    status: 'delivered',
    attempts: [
      {
        status: 200,
        durationMs: 82,
        body: '{"status":"enqueued_for_fulfillment"}',
        success: true,
      },
    ],
  });

  // Shopify Event 2: Failed Fulfillment Update
  await seedEvent({
    endpoint: shopifyEndpoint,
    receivedAt: new Date(now - 30000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'fulfillments/update',
      'x-shopify-shop-domain': 'acme-store.myshopify.com',
    },
    rawBody: JSON.stringify(
      {
        id: 25519028,
        order_id: 8209829119461546,
        status: 'in_transit',
        tracking_number: '1Z9999999999999999',
      },
      null,
      2,
    ),
    status: 'failed',
    attempts: [
      {
        status: 502,
        durationMs: 310,
        body: '<html><body>502 Bad Gateway: Upstream warehouse service unavailable</body></html>',
        error: 'HTTP 502 Bad Gateway',
        success: false,
      },
      {
        status: 502,
        durationMs: 295,
        body: '<html><body>502 Bad Gateway: Upstream warehouse service unavailable</body></html>',
        error: 'HTTP 502 Bad Gateway',
        success: false,
      },
    ],
  });

  // GitHub Event 1: Dead deployment event (exhausted retries)
  await seedEvent({
    endpoint: githubEndpoint,
    receivedAt: new Date(now - 15000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'deployment_status',
      'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    },
    rawBody: JSON.stringify(
      {
        deployment: {
          id: 712049,
          ref: 'refs/heads/production',
          environment: 'production',
        },
        deployment_status: {
          state: 'failure',
          description: 'Deploy timed out after health probe failure.',
        },
        repository: {
          full_name: 'acme/infra-core',
        },
      },
      null,
      2,
    ),
    status: 'dead',
    attempts: [
      {
        status: 504,
        durationMs: 5000,
        body: '504 Gateway Timeout',
        error: 'Gateway Timeout',
        success: false,
      },
      {
        status: 504,
        durationMs: 5000,
        body: '504 Gateway Timeout',
        error: 'Gateway Timeout',
        success: false,
      },
      {
        status: 504,
        durationMs: 5000,
        body: '504 Gateway Timeout',
        error: 'Gateway Timeout',
        success: false,
      },
      {
        status: 504,
        durationMs: 5000,
        body: '504 Gateway Timeout',
        error: 'Gateway Timeout',
        success: false,
      },
    ],
  });

  // Stripe Event 3: Pending event waiting in queue
  await seedEvent({
    endpoint: stripeEndpoint,
    receivedAt: new Date(now - 5000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 't=1700000090,v1=1122334455667788',
    },
    rawBody: JSON.stringify(
      {
        id: 'evt_3Mvw92LkdIwHu7ix0Pending',
        object: 'event',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_3N87L02eZvKYlo2C',
            amount_refunded: 4900,
            currency: 'usd',
          },
        },
      },
      null,
      2,
    ),
    status: 'pending',
    attempts: [],
  });

  // 6. Demo API Key for CLI
  const demoApiKey = 'hp_live_demokey_9876543210abcdef0123456789';
  const demoKeyHash = crypto.createHash('sha256').update(demoApiKey).digest('hex');

  await ApiKeyModel.findOneAndUpdate(
    { keyHash: demoKeyHash },
    {
      workspaceId: demoWorkspace._id,
      name: 'Demo CLI Access Key',
      prefix: 'hp_live_demokey',
      keyHash: demoKeyHash,
      createdBy: demoUser._id,
      lastUsedAt: new Date(),
      revokedAt: null,
    },
    { upsert: true, new: true },
  );

  console.log('\n======================================================');
  console.log('🎉 HookPilot Demo Workspace Provisioned Successfully!');
  console.log('======================================================');
  console.log('🔑 Demo User Login:');
  console.log(`   Email:    demo@hookpilot.dev`);
  console.log(`   Password: Password123!`);
  console.log('\n🏢 Demo Workspace:');
  console.log(`   Name:     HookPilot Demo`);
  console.log(`   Slug:     demo`);
  console.log('\n📡 Sample Endpoints Ready for Testing:');
  console.log(`   1. Stripe Payments:   /in/stripe-payments`);
  console.log(`   2. Shopify Orders:    /in/shopify-orders`);
  console.log(`   3. GitHub CI/CD:      /in/github-actions`);
  console.log('\n💻 Sample CLI Key for Local Tunneling:');
  console.log(`   Key:      ${demoApiKey}`);
  console.log(`   Command:  hookpilot login --key ${demoApiKey}`);
  console.log(`             hookpilot listen 3000 --endpoint stripe-payments`);
  console.log('======================================================\n');

  await mongoose.disconnect();
}

// Allow direct CLI execution
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Seeding failed:', err);
      process.exit(1);
    });
}
