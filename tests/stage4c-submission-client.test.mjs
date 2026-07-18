import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
await import('../src/cloud_collab_submission_client.js');
const {
  SubmissionApiClient, SubmissionDispatcher, SubmissionClientError,
  buildExactPriceSubmission, classifyRemoteError, isPreviewSubmissionScope,
  planInitialExactPriceSubmissions,
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
const previewSubmission = (submissionId = SUB_ID, patch = {}) => ({ submissionId, deviceId: DEVICE_ID, groupId: 'group_fixture', libraryId: 'lib_receive_fixture', dataType: 'exact_price', operation: 'upsert', ...patch });

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
function stores(queue, mode = 'collaborate') {
  return {
    metaStore: { loadResult() { return { ok: true, exists: true, value: { deviceId: DEVICE_ID, nickname: null } }; } },
    credentialStore: {
      value: null,
      getValid() { return this.value; },
      loadResult() { return { ok: true, exists: Boolean(this.value), value: this.value }; },
      save(value) { this.value = value; return value; },
      clear() { this.value = null; },
    },
    bindingStore: { list() { return [{ groupId: 'group_fixture', libraryId: 'lib_receive_fixture', mode }]; } },
    queueStore: queue,
  };
}
const configuredApi = (overrides = {}) => ({ isConfigured: () => true, hasWriteAccess: () => true, ...overrides });

test('device registration uses isolated route and runtime header without Authorization', async () => {
  const calls = [];
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', writeAccessProvider: () => 'runtime-value', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(201, { ok: true, data: { deviceId: DEVICE_ID, deviceToken: `dt_v1_${'A'.repeat(43)}`, issuedAt: 1, expiresAt: 2, tokenVersion: 1, publicMutationAllowed: false, autoApprovalEnabled: false } });
  } });
  await client.registerDevice({ deviceId: DEVICE_ID });
  assert.equal(calls[0].url, 'https://api.test/api/device/register');
  assert.equal(calls[0].options.headers['X-Cloud-Collab-Preview-Key'], 'runtime-value');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.equal(calls[0].options.body.includes('runtime-value'), false);
  assert.equal(calls[0].options.credentials, 'omit');
});

test('closed runtime write gate fails before network and queue mutation', async () => {
  let called = false;
  const client = new SubmissionApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => { called = true; } });
  await assert.rejects(() => client.registerDevice({ deviceId: DEVICE_ID }), error => error.code === 'WRITE_GATE_CLOSED' && error.category === 'write_gate');
  assert.equal(called, false);
  const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission() }]);
  const result = await new SubmissionDispatcher({ apiClient: configuredApi({ hasWriteAccess: () => false }), ...stores(queue), isOnline: () => true }).flush();
  assert.equal(result.status, 'write_gate_closed');
  assert.equal(queue.items[0].deliveryState, 'queued');
});

test('server-disabled preview write is non-retryable to prevent loops', () => {
  assert.deepEqual(classifyRemoteError('PREVIEW_WRITE_DISABLED', 503), { category: 'service_disabled', retryable: false });
  assert.deepEqual(classifyRemoteError('DEVICE_TOKEN_EXPIRED', 401), { category: 'credential', retryable: false });
  assert.deepEqual(classifyRemoteError('PREVIEW_ACCESS_DENIED', 403), { category: 'write_gate', retryable: false });
  assert.deepEqual(classifyRemoteError('IDEMPOTENCY_CONFLICT', 409), { category: 'conflict', retryable: false });
  assert.deepEqual(classifyRemoteError('PREVIEW_RATE_LIMITED', 429), { category: 'rate_limit', retryable: true });
});

test('exact-price envelope and idempotency hash follow frozen protocol', async () => {
  const submission = await buildExactPriceSubmission({ snapshotSync, deviceId: DEVICE_ID, submissionId: SUB_ID, groupId: 'group_fixture', libraryId: 'lib_receive_fixture', serviceName: '  测试 A ', settleType: 'round', unitPrice: 12.5, origin: 'initialBinding', clientCreatedAt: 123 });
  assert.equal(submission.payload.serviceName, '测试 A');
  assert.match(submission.businessKey, /^bk_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(submission.contentHash, /^ch_v1_[A-Za-z0-9_-]{43}$/);
  assert.match(submission.idempotencyKey, /^ik_v1_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(submission.clientContext, { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 });
});

test('initial binding shares only supported non-public exact prices and strips private fields', async () => {
  const existing = await snapshotSync.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: '已有', settleType: 'round', unitPrice: 8 });
  let seq = 0;
  const result = await planInitialExactPriceSubmissions({
    snapshotSync, deviceId: DEVICE_ID, groupId: 'group_fixture', libraryId: 'lib_receive_fixture',
    localItems: [
      { serviceType: '已有', settleType: 'round', unitPrice: 8, usageCount: 99, lastUsed: 999 },
      { serviceType: '新增', settleType: 'hour', unitPrice: 20, original: 'private' },
      { serviceType: '礼物', settleType: 'gift', unitPrice: 1 },
    ],
    baseHashes: { [existing.businessKey]: existing.contentHash },
    submissionIdFactory: () => `sub_01JABCDEF0123456789XYZA${String(++seq).padStart(3, '0')}`,
    now: () => 123,
  });
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].payload.serviceName, '新增');
  assert.equal(result.skipped.alreadyPublic, 1);
  assert.equal(result.skipped.unsupported, 1);
  assert.equal(/usageCount|lastUsed|original/.test(JSON.stringify(result.submissions)), false);
});

test('client scope gate permits only synthetic exact-price upserts', () => {
  assert.equal(isPreviewSubmissionScope(previewSubmission()), true);
  assert.equal(isPreviewSubmissionScope(previewSubmission(SUB_ID, { groupId: 'group_xiacijian' })), false);
  assert.equal(isPreviewSubmissionScope(previewSubmission(SUB_ID, { libraryId: 'lib_xiacijian_regular' })), false);
  assert.equal(isPreviewSubmissionScope(previewSubmission(SUB_ID, { dataType: 'boss_profile' })), false);
  assert.equal(isPreviewSubmissionScope(previewSubmission(SUB_ID, { operation: 'delete' })), false);
});

test('dispatcher registers lazily, stores credential locally, and acknowledges duplicate success', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission() }]);
  const s = stores(queue), calls = [];
  const apiClient = configuredApi({
    async registerDevice(args) { calls.push(['register', args]); return { deviceId: DEVICE_ID, deviceToken: 'token', issuedAt: 1, expiresAt: 9999999999999, tokenVersion: 1 }; },
    async submit(token, submission) { calls.push(['submit', token, submission.submissionId]); return { duplicate: true }; },
  });
  const result = await new SubmissionDispatcher({ apiClient, ...s, now: () => 2, isOnline: () => true }).flush();
  assert.equal(result.acknowledged, 1);
  assert.equal(queue.items[0].deliveryState, 'acknowledged');
  assert.equal(s.credentialStore.value.deviceToken, 'token');
  assert.deepEqual(calls.map(x => x[0]), ['register', 'submit']);
});

test('offline mode leaves the queue untouched', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission() }]);
  const result = await new SubmissionDispatcher({ apiClient: configuredApi(), ...stores(queue), isOnline: () => false }).flush();
  assert.equal(result.status, 'offline');
  assert.equal(queue.items[0].deliveryState, 'queued');
});

test('non-preview objects are blocked locally without network access', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission(SUB_ID, { groupId: 'group_xiacijian', libraryId: 'lib_xiacijian_regular' }) }]);
  let called = false;
  const result = await new SubmissionDispatcher({ apiClient: configuredApi({ async registerDevice() { called = true; }, async submit() { called = true; } }), ...stores(queue), isOnline: () => true }).flush();
  assert.equal(result.status, 'completed_with_blocked');
  assert.equal(queue.items[0].lastErrorCode, 'PREVIEW_SCOPE_CLIENT_BLOCKED');
  assert.equal(called, false);
});

test('receive and local bindings never dispatch stale queue items', async () => {
  for (const mode of ['receive', 'local']) {
    const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission() }]);
    let called = false;
    const result = await new SubmissionDispatcher({ apiClient: configuredApi({ async registerDevice() { called = true; }, async submit() { called = true; } }), ...stores(queue, mode), isOnline: () => true }).flush();
    assert.equal(result.status, 'no_collaborative_due');
    assert.equal(queue.items[0].deliveryState, 'queued');
    assert.equal(called, false);
  }
});

test('429 writes retry state and stops the batch', async () => {
  const ids = ['sub_01JABCDEF0123456789XYZAAA', 'sub_01JABCDEF0123456789XYZBBB'];
  const queue = queueFixture(ids.map(id => ({ deliveryState: 'queued', submission: previewSubmission(id) })));
  const s = stores(queue); s.credentialStore.value = { deviceToken: 'token', expiresAt: 9999999999999 };
  let calls = 0;
  const apiClient = configuredApi({ async submit() { calls += 1; throw new SubmissionClientError('PREVIEW_RATE_LIMITED', 'slow', { status: 429, retryable: true, category: 'rate_limit' }); } });
  const result = await new SubmissionDispatcher({ apiClient, ...s, isOnline: () => true }).flush();
  assert.equal(result.retryWait, 1);
  assert.equal(calls, 1);
  assert.deepEqual(queue.items.map(item => item.deliveryState), ['retry_wait', 'queued']);
});

test('credential rejection clears local token, blocks current item, and stops batch', async () => {
  const ids = ['sub_01JABCDEF0123456789XYZAAA', 'sub_01JABCDEF0123456789XYZBBB'];
  const queue = queueFixture(ids.map(id => ({ deliveryState: 'queued', submission: previewSubmission(id) })));
  const s = stores(queue); s.credentialStore.value = { deviceToken: 'token', expiresAt: 9999999999999 };
  let calls = 0;
  const apiClient = configuredApi({ async submit() { calls += 1; throw new SubmissionClientError('DEVICE_TOKEN_EXPIRED', 'expired', { status: 401, category: 'credential' }); } });
  const result = await new SubmissionDispatcher({ apiClient, ...s, isOnline: () => true }).flush();
  assert.equal(result.blocked, 1);
  assert.equal(calls, 1);
  assert.deepEqual(queue.items.map(item => item.deliveryState), ['blocked', 'queued']);
  assert.equal(s.credentialStore.value, null);
});

test('lost credential with already-registered device blocks eligible items instead of looping', async () => {
  const queue = queueFixture([{ deliveryState: 'queued', submission: previewSubmission() }]);
  const s = stores(queue);
  const apiClient = configuredApi({ async registerDevice() { throw new SubmissionClientError('DEVICE_ALREADY_REGISTERED', 'recover', { status: 409, category: 'credential_recovery' }); } });
  const result = await new SubmissionDispatcher({ apiClient, ...s, isOnline: () => true }).flush();
  assert.equal(result.status, 'credential_blocked');
  assert.equal(queue.items[0].lastErrorCode, 'DEVICE_ALREADY_REGISTERED');
});
