/* eslint-disable no-undef, no-console */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_URL || 'http://localhost:4000';
const SECRET = __ENV.WEBHOOK_SECRET || 'whsec_k6_loadtest_secret_key_99999';

export const options = {
  scenarios: {
    ramping_webhooks: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 25 }, // Warm-up ramp
        { duration: '10s', target: 50 }, // Sustained moderate load
        { duration: '10s', target: 100 }, // Peak stress load
        { duration: '5s', target: 0 }, // Cooldown ramp
      ],
      gracefulRampDown: '3s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // Error rate must stay below 1%
    http_req_duration: ['p(95)<300'], // p95 latency must stay below 300ms
  },
};

export function setup() {
  const timestamp = Date.now();
  const email = `loadtest-${timestamp}@test.com`;
  const password = 'Password123!';

  // 1. Register test user
  const regRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({
      name: 'Load Tester',
      email,
      password,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (regRes.status !== 201) {
    throw new Error(`Failed to register load test user: ${regRes.status} ${regRes.body}`);
  }

  const { accessToken } = JSON.parse(regRes.body);
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // 2. Create workspace
  const wsRes = http.post(
    `${BASE_URL}/workspaces`,
    JSON.stringify({ name: `LoadTest WS ${timestamp}`, retentionDays: 7 }),
    { headers: authHeaders },
  );

  if (wsRes.status !== 201) {
    throw new Error(`Failed to create workspace: ${wsRes.status} ${wsRes.body}`);
  }

  const { workspace } = JSON.parse(wsRes.body);

  // 3. Create high-throughput endpoint with Stripe signature verification
  const epRes = http.post(
    `${BASE_URL}/workspaces/${workspace.id}/endpoints`,
    JSON.stringify({
      name: `Ramping LoadTest Sink ${timestamp}`,
      destinationUrl: 'http://127.0.0.1:3999/webhook',
      mode: 'capture-only', // Capture & store in MongoDB and Redis without external network latency
      rateLimitPerMin: 500000,
      signatureConfig: {
        provider: 'stripe',
        secret: SECRET,
        enforce: true,
      },
    }),
    { headers: authHeaders },
  );

  if (epRes.status !== 201) {
    throw new Error(`Failed to create endpoint: ${epRes.status} ${epRes.body}`);
  }

  const { endpoint } = JSON.parse(epRes.body);
  console.log(`[k6 setup] Created load test endpoint: slug=${endpoint.slug}, id=${endpoint.id}`);

  return {
    slug: endpoint.slug,
    secret: SECRET,
  };
}

export default function (data) {
  const unixNow = Math.floor(Date.now() / 1000);
  const payloadObj = {
    event: 'charge.succeeded',
    id: `ch_k6_${__VU}_${__ITER}`,
    amount: Math.floor(Math.random() * 10000) + 100,
    currency: 'usd',
    customer: `cus_${__VU}`,
    timestamp: unixNow,
  };

  const rawBody = JSON.stringify(payloadObj);
  const signedPayload = `${unixNow}.${rawBody}`;
  const signatureHex = crypto.hmac('sha256', data.secret, signedPayload, 'hex');

  const headers = {
    'Content-Type': 'application/json',
    'Stripe-Signature': `t=${unixNow},v1=${signatureHex}`,
    'X-Idempotency-Key': `k6-idem-${__VU}-${__ITER}`,
  };

  const res = http.post(`${BASE_URL}/in/${data.slug}`, rawBody, { headers });

  check(res, {
    'is status 202': (r) => r.status === 202,
    'has eventId': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Boolean(body.eventId);
      } catch {
        return false;
      }
    },
  });

  // Small sleep to maintain steady pacing per virtual user
  sleep(0.05);
}

export function teardown(data) {
  console.log(`[k6 teardown] Completed load test run on slug=${data.slug}`);
}
