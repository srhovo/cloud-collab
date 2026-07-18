import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
await import('../src/cloud_collab_submission_client.js');
const {
  SubmissionApiClient, SubmissionDispatcher, SubmissionClientError,
  buildExactPriceSubmission, classifyRemoteError, planInitialExactPriceSubmissions,
} = globalThis.CloudCollabSubmission;

function response(status, payload, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get(name) { return headers[String(name).toLowerCase()] || null; } }, async json() { return payload; } };
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');
const snapshotSync = {
  canonicalize,
  async computeExactPriceHashes(groupId, libraryId, raw) {
    const payload = { serviceName: String(raw.serviceName).normalize('NFKC').replace(/\s+/g, ' ').trim(), settleType: raw.settleType, unitPrice: Number(raw.unitPrice) };
    const identity = { groupId, libraryId, normalizedServiceName: payload.serviceName.toLowerCase(), ruleType: 'exact', settleType: payload.settleType, variant: 'standard' };
    const content = { schemaVersion: 1, payloadSchemaVersion: 1, groupId, libraryId, bossId: null, dataType: 'exact_price', operation: 'upsert', payload };
    return { payload, businessKey: `bk_v1_${hash(canonicalize(identity))}`, contentHash: `ch_v1_${hash(canonicalize(content))}` };
  },
};

const DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD';
const SUB_ID = 'sub_01JABCDEF0123456789XYZABCD';

test('registration uses current 4B.2 route, session-only preview header and no Authorization', async () => {
  const calls = [];
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', previewAccessKeyProvider: () => 'session-secret', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(201, { ok: true, data: { deviceId: DEVICE_ID, deviceToken: `dt_v1_${'A'.repeat(43)}`, issuedAt: 1, expiresAt: 2, tokenVersion: 1, publicMutationAllowed: false, autoApprovalEnabled: false } });
  } });
  await client.registerDevice({ deviceId: DEVICE_ID, nickname: null });
  assert.equal(calls[0].url, 'https://api.test/api/device/register');
  assert.equal(calls[0].options.headers['X-Cloud-Collab-Preview-Key'], 'session-secret');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.body.includes('session-secret'), false);
});

test('submission token is only in Authorization and current create route is used', async () => {
  let call;
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', previewAccessKeyProvider: () => 'preview', fetchImpl: async (url, options) => {
    call = { url, options };
    return response(202, { ok: true, data: { status: 'waiting_confirmation', publicMutationAllowed: false, autoApprovalEnabled: false } });
  } });
  await client.submit('top-secret-token', { submissionId: SUB_ID });
  assert.equal(call.url, 'https://api.test/api/submissions/create');
  assert.equal(call.options.headers.Authorization, 'Bearer top-secret-token');
  assert.equal(call.options.body.includes('top-secret-token'), false);
});

test('missing preview access fails before any network request', async () => {
  let called = false;
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => { called = true; } });
  await assert.rejects(() => client.registerDevice({ deviceId: DEVICE_ID }), error => error.code === 'PREVIEW_ACCESS_REQUIRED' && error.category === 'preview_access');
  assert.equal(called, false);
});

test('error classification separates credential, permission, conflict, rate and server failures', () => {
  assert.deepEqual(classifyRemoteError('DEVICE_TOKEN_EXPIRED', 401), { category: 'credential', retryable: false });
  assert.deepEqual(classifyRemoteError('PREVIEW_ACCESS_DENIED', 403), { category: 'preview_access', retryable: false });
  assert.deepEqual(classifyRemoteError('IDEMPOTENCY_CONFLICT', 409), { category: 'conflict', retryable: false });
  assert.deepEqual(classifyRemoteError('RATE_LIMITED', 429), { category: 'rate_limit', retryable: true });
  assert.deepEqual(classifyRemoteError('INTERNAL', 503), { category: 'transient', retryable: true });
});

test('exact price submission hashes match the frozen server canonical form', async () => {
  const submission = await buildExactPriceSubmission({ snapshotSync, deviceId: DEVICE_ID, submissionId: SUB_ID, groupId: 'group_fixture', libraryId: 'lib_receive_fixture', serviceName: '  测试服务 A ', settleType: 'round', unitPrice: 12.5, origin: 'initialBinding', clientCreatedAt: 123 });
  assert.equal(submission.payload.serviceName, '测试服务 A');
  assert.match(submission.businessKey, /^bk_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(submission.contentHash, /^ch_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(submission.idempotencyKey, /^ik_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(submission.bossId, null);
  assert.deepEqual(submission.clientContext, { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 });
});

test('initial binding splits shareable exact prices and skips already-public/gift entries', async () => {
  const existing = await snapshotSync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '已有', settleType: 'round', unitPrice: 8 });
  let seq = 0;
  const result = await planInitialExactPriceSubmissions({
    snapshotSync, deviceId: DEVICE_ID, groupId: 'group_fixture', libraryId: 'lib_receive_fixture',
    localItems: [
      { serviceType: '已有', settleType: 'round', unitPrice: 8, usageCount: 99, lastUsed: 999 },
      { serviceType: '新增', settleType: 'hour', unitPrice: 20 },
      { serviceType: '礼物', settleType: 'gift', unitPrice: 1 },
    ],
    baseHashes: { [existing.businessKey]: existing.contentHash },
    submissionIdFactory: () => `sub_01JABCDEF0123456789XYZA${String(++seq).padStart(3, '0')}`,
    now: () => 123,
  });
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].payload.serviceName, '新增');
  assert.equal(result.submissions[0].origin, 'initialBinding');
  assert.equal(result.skipped.alreadyPublic, 1);
  assert.equal(result.skipped.unsupported, 1);
  assert.equal(JSON.stringify(result.submissions).includes('usageCount'), false);
  assert.equal(JSON.stringify(result.submissions).includes('lastUsed'), false);
});

function queueFixture(records) {
  const items = records.map(record => structuredClone(record));
  return {
    getDue() { return items.filter(item => ['queued', 'retry_wait'].includes(item.deliveryState)); },
    list() { return items; },
    markSending(id) { items.find(x => x.submission.submissionId === id).deliveryState = 'sending'; },
    markAcknowledged(id) { items.find(x => x.submission.submissionId === id).deliveryState = 'acknowledged'; },
    markRetry(id, code) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'retry_wait'; item.lastErrorCode = code; },
    markBlocked(id, code) { const item = items.find(x => x.submission.submissionId === id); item.deliveryState = 'blocked'; item.lastErrorCode = code; },
    pruneAcknowledged() {}, items,
  };
}
function stores(queue) {
  return {
    metaStore: { loadResult() { return { ok: true, exists: true, value: { deviceId: DEVICE_ID, nickname: null } }; } },
    credentialStore: {
      value: null,
      getValid() { return this.value; },
      loadResult() { return { ok: true, exists: Boolean(this.value), value: this.value }; },
      save(value) { this.value = value; return value; },
      clear() { this.value = null; },
    }, queueStore: queue,
  };
}

test('dispatcher registers lazily, persists device credential locally and acknowledges idempotent success', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: { submissionId: SUB_ID } }]);
  const s = stores(queue), calls = [];
  const apiClient = {
    isConfigured() { return true; },
    async registerDevice(args) { calls.push(['register', args]); return { deviceId: DEVICE_ID, deviceToken: 'token', issuedAt: 1, expiresAt: 9999999999999, tokenVersion: 1 }; },
    async submit(token, submission) { calls.push(['submit', token, submission.submissionId]); return { duplicate: true }; },
  };
  const result = await new SubmissionDispatcher({ apiClient, ...s, now: () => 2, isOnline: () => true }).flush();
  assert.equal(result.acknowledged, 1);
  assert.equal(queue.items[0].deliveryState, 'acknowledged');
  assert.equal(s.credentialStore.value.deviceToken, 'token');
  assert.deepEqual(calls.map(x => x[0]), ['register', 'submit']);
});

test('dispatcher leaves queue untouched while offline', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: { submissionId: SUB_ID } }]);
  const s = stores(queue);
  const result = await new SubmissionDispatcher({ apiClient: { isConfigured: () => true }, ...s, isOnline: () => false }).flush();
  assert.equal(result.status, 'offline');
  assert.equal(queue.items[0].deliveryState, 'queued');
});

test('dispatcher retries 429/5xx and blocks 401/409 with status writeback', async () => {
  const ids = ['sub_01JABCDEF0123456789XYZAAA', 'sub_01JABCDEF0123456789XYZBBB', 'sub_01JABCDEF0123456789XYZCCC'];
  const queue = queueFixture(ids.map(id => ({ deliveryState: 'queued', submission: { submissionId: id } })));
  const s = stores(queue); s.credentialStore.value = { deviceToken: 'token', expiresAt: 9999999999999 };
  const apiClient = { isConfigured: () => true, async submit(token, submission) {
    if (submission.submissionId.endsWith('AAA')) throw new SubmissionClientError('RATE_LIMITED', 'slow', { status: 429, retryable: true, category: 'rate_limit' });
    if (submission.submissionId.endsWith('BBB')) throw new SubmissionClientError('DEVICE_TOKEN_EXPIRED', 'expired', { status: 401, category: 'credential' });
    throw new SubmissionClientError('IDEMPOTENCY_CONFLICT', 'conflict', { status: 409, category: 'conflict' });
  } };
  const result = await new SubmissionDispatcher({ apiClient, ...s, isOnline: () => true }).flush();
  assert.equal(result.retryWait, 1);
  assert.equal(result.blocked, 2);
  assert.deepEqual(queue.items.map(item => item.deliveryState), ['retry_wait', 'blocked', 'blocked']);
  assert.equal(s.credentialStore.value, null);
});
