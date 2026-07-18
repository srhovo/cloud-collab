import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SubmissionApiClient, SubmissionDispatcher, SubmissionClientError, shouldRetry } = require('../src/cloud_collab_submission_client.js');

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test('registration request uses canonical body and sends no Authorization header', async () => {
  const calls = [];
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(201, { ok: true, data: { deviceId: 'dev_x', deviceToken: 'secret-token', issuedAt: 1, expiresAt: 2, tokenVersion: 1 } });
  } });
  await client.registerDevice({ deviceId: 'dev_x', nickname: null, appVersion: '8.2.28' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schemaVersion: 1,
    deviceId: 'dev_x',
    nickname: null,
    clientContext: { appVersion: '8.2.28' },
  });
});

test('submission token is only in Authorization and never copied into body', async () => {
  let call;
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', fetchImpl: async (url, options) => {
    call = { url, options };
    return response(202, { ok: true, data: { status: 'waiting_confirmation' } });
  } });
  await client.submit('top-secret-token', { submissionId: 'sub_x', payload: { unitPrice: 1 } });
  assert.equal(call.options.headers.Authorization, 'Bearer top-secret-token');
  assert.equal(call.options.body.includes('top-secret-token'), false);
});

test('client classifies transient storage, 429 and 5xx errors as retryable', async () => {
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => response(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'slow', retryable: true } }) });
  await assert.rejects(() => client.submit('x', {}), error => error instanceof SubmissionClientError && error.retryable === true && error.status === 429);
  assert.equal(shouldRetry({ status: 503 }), true);
  assert.equal(shouldRetry({ code: 'RATE_LIMIT_STORAGE_FAILED' }), true);
  assert.equal(shouldRetry({ status: 400, code: 'INVALID_SUBMISSION' }), false);
  assert.equal(shouldRetry({ status: 409, code: 'IDEMPOTENCY_CONFLICT' }), false);
});

function queueFixture(records) {
  const items = records.map(record => structuredClone(record));
  return {
    getDue() { return items.filter(item => ['queued', 'retry_wait'].includes(item.deliveryState)); },
    markSending(id) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'sending'; },
    markAcknowledged(id) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'acknowledged'; },
    markRetry(id, code) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'retry_wait'; item.lastErrorCode = code; },
    markBlocked(id, code) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'blocked'; item.lastErrorCode = code; },
    items,
  };
}

function stores(queue) {
  return {
    metaStore: { loadResult() { return { ok: true, exists: true, value: { deviceId: 'dev_x', nickname: null } }; } },
    credentialStore: {
      value: null,
      getValid() { return this.value; },
      save(value) { this.value = value; return value; },
    },
    queueStore: queue,
  };
}

test('dispatcher registers lazily and acknowledges successful queue records', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: { submissionId: 'sub_1' } }]);
  const s = stores(queue);
  const calls = [];
  const apiClient = {
    isConfigured() { return true; },
    async registerDevice(args) { calls.push(['register', args]); return { deviceId: 'dev_x', deviceToken: 'token', issuedAt: 1, expiresAt: 9999999999999, tokenVersion: 1 }; },
    async submit(token, submission) { calls.push(['submit', token, submission.submissionId]); return { status: 'waiting_confirmation' }; },
  };
  const dispatcher = new SubmissionDispatcher({ apiClient, ...s, now: () => 2 });
  const result = await dispatcher.flush();
  assert.deepEqual(calls, [
    ['register', { deviceId: 'dev_x', nickname: null, appVersion: '8.2.28' }],
    ['submit', 'token', 'sub_1'],
  ]);
  assert.equal(result.acknowledged, 1);
  assert.equal(queue.items[0].deliveryState, 'acknowledged');
});

test('dispatcher retries transient errors and blocks permanent validation errors', async () => {
  const queue = queueFixture([
    { deliveryState: 'queued', submission: { submissionId: 'sub_retry' } },
    { deliveryState: 'queued', submission: { submissionId: 'sub_block' } },
  ]);
  const s = stores(queue);
  s.credentialStore.value = { deviceToken: 'token', expiresAt: 9999999999999 };
  const apiClient = {
    isConfigured() { return true; },
    async submit(token, submission) {
      if (submission.submissionId === 'sub_retry') throw new SubmissionClientError('RATE_LIMITED', 'slow', { status: 429, retryable: true });
      throw new SubmissionClientError('IDEMPOTENCY_CONFLICT', 'bad', { status: 409, retryable: false });
    },
  };
  const dispatcher = new SubmissionDispatcher({ apiClient, ...s, now: () => 2 });
  const result = await dispatcher.flush();
  assert.equal(result.retryWait, 1);
  assert.equal(result.blocked, 1);
  assert.equal(queue.items[0].deliveryState, 'retry_wait');
  assert.equal(queue.items[1].deliveryState, 'blocked');
});
