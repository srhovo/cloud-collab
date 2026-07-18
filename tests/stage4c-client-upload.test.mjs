import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubmission } from '../src/server/submission_policy_v1.js';

await import('../src/cloud_collab_snapshot_sync.js');
await import('../src/cloud_collab_write_client.js');
await import('../src/cloud_collab_submission_builder.js');
await import('../src/cloud_collab_queue_dispatcher.js');

const WriteApi = globalThis.CloudCollabWriteClient;
const Builder = globalThis.CloudCollabSubmissionBuilder;
const DispatcherApi = globalThis.CloudCollabQueueDispatcher;
const SnapshotApi = globalThis.CloudCollabSnapshotSync;

const DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_TOKEN = `dt_v1_${'A'.repeat(43)}`;
const NOW = 1_784_380_000_000;

class CredentialStore {
  constructor(value = null) { this.value = value ? structuredClone(value) : null; this.cleared = false; }
  save(value) { this.value = structuredClone(value); return this.value; }
  getValid(now = NOW) { return this.value && (this.value.expiresAt === null || this.value.expiresAt > now) ? structuredClone(this.value) : null; }
  getRedacted() { return this.value ? { deviceId: this.value.deviceId, tokenPresent: true, issuedAt: this.value.issuedAt, expiresAt: this.value.expiresAt, tokenVersion: this.value.tokenVersion } : null; }
  clear() { this.value = null; this.cleared = true; return true; }
}

function credential() {
  return { schemaVersion: 1, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, issuedAt: NOW, expiresAt: NOW + 60_000, tokenVersion: 1 };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function makeQueueRecord(overrides = {}) {
  const submission = {
    submissionId: 'sub_01JABCDEF0123456789XYZABCD',
    deviceId: DEVICE_ID,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    ...overrides.submission,
  };
  return {
    submission,
    deliveryState: overrides.deliveryState || 'queued',
    attemptCount: overrides.attemptCount || 0,
    nextRetryAt: overrides.nextRetryAt ?? NOW,
    lastErrorCode: overrides.lastErrorCode || null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class QueueStore {
  constructor(records) { this.records = records.map(item => structuredClone(item)); }
  list() { return structuredClone(this.records); }
  getDue(now, limit) { return this.list().filter(item => ['queued', 'retry_wait'].includes(item.deliveryState) && (item.nextRetryAt === null || item.nextRetryAt <= now)).slice(0, limit); }
  find(id) { return this.records.find(item => item.submission.submissionId === id); }
  markSending(id) { const item = this.find(id); item.deliveryState = 'sending'; item.attemptCount += 1; item.nextRetryAt = null; item.lastErrorCode = null; return { record: structuredClone(item), queue: this.list() }; }
  transition(id, state, patch = {}) { const item = this.find(id); Object.assign(item, patch, { deliveryState: state, updatedAt: NOW }); return { record: structuredClone(item), queue: this.list() }; }
  markAcknowledged(id) { return this.transition(id, 'acknowledged', { nextRetryAt: null, lastErrorCode: null }); }
  markBlocked(id, code) { return this.transition(id, 'blocked', { nextRetryAt: null, lastErrorCode: code }); }
  pruneAcknowledged() { return this.list(); }
}

function makeDispatcher({ record = makeQueueRecord(), mode = 'collaborate', online = true, client } = {}) {
  const queueStore = new QueueStore([record]);
  const credentialStore = new CredentialStore(credential());
  const bindingStore = { getByScope: () => ({ groupId: 'group_fixture', libraryId: 'lib_receive_fixture', mode }) };
  const metaStore = { loadResult: () => ({ ok: true, exists: true, value: { deviceId: DEVICE_ID, nickname: null } }) };
  const states = [];
  const dispatcher = new DispatcherApi.PendingCloudDispatcher({
    client,
    metaStore,
    credentialStore,
    bindingStore,
    queueStore,
    navigatorRef: { onLine: online },
    documentRef: { visibilityState: 'visible' },
    windowRef: { addEventListener() {}, removeEventListener() {} },
    now: () => NOW,
    onState: state => states.push(state),
  });
  return { dispatcher, queueStore, credentialStore, states };
}

test('write client is fail-closed and sends no request while disabled', async () => {
  let calls = 0;
  const client = new WriteApi.CloudWriteApiClient({ apiBase: 'https://example.test', writeEnabled: false, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(() => client.registerDevice({ meta: { deviceId: DEVICE_ID }, credentialStore: new CredentialStore() }), error => error.code === 'WRITE_CLIENT_DISABLED' && error.category === 'disabled');
  assert.equal(calls, 0);
});

test('device registration persists plaintext token only through cloudDeviceCredential store', async () => {
  let requestOptions = null;
  const store = new CredentialStore();
  const client = new WriteApi.CloudWriteApiClient({
    apiBase: 'https://example.test',
    writeEnabled: true,
    now: () => NOW,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return jsonResponse({ ok: true, data: { schemaVersion: 1, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, issuedAt: NOW, expiresAt: NOW + 60_000, tokenVersion: 1, nicknameTag: 'ABCD' } }, 201);
    },
  });
  const redacted = await client.registerDevice({ meta: { deviceId: DEVICE_ID, nickname: '测试设备' }, credentialStore: store });
  assert.equal(redacted.tokenPresent, true);
  assert.equal('deviceToken' in redacted, false);
  assert.equal(store.value.deviceToken, DEVICE_TOKEN);
  const sent = JSON.parse(requestOptions.body);
  assert.deepEqual(Object.keys(sent).sort(), ['clientContext', 'deviceId', 'nickname', 'schemaVersion']);
  assert.equal(requestOptions.credentials, 'omit');
  assert.equal('Authorization' in requestOptions.headers, false);
  assert.equal(Object.keys(requestOptions.headers).some(key => /preview/i.test(key)), false);
});

test('submission uses Bearer device token and classifies 429 Retry-After', async () => {
  let options = null;
  const client = new WriteApi.CloudWriteApiClient({
    apiBase: 'https://example.test', writeEnabled: true, now: () => NOW,
    fetchImpl: async (_url, value) => { options = value; return jsonResponse({ ok: false, error: { code: 'PREVIEW_RATE_LIMITED', message: 'slow down' } }, 429, { 'Retry-After': '7' }); },
  });
  await assert.rejects(
    () => client.submit({ submission: { deviceId: DEVICE_ID }, credential: credential() }),
    error => error.category === 'rate_limited' && error.retryable === true && error.retryAfterMs === 7000,
  );
  assert.equal(options.headers.Authorization, `Bearer ${DEVICE_TOKEN}`);
  assert.equal(Object.keys(options.headers).some(key => /preview/i.test(key)), false);
});

test('first binding projects only exact-price whitelist and skips public/conflict/queued items', async () => {
  const items = [
    { serviceType: '公开A', settleType: 'round', unitPrice: 100, note: 'private', usageCount: 99 },
    { serviceType: '冲突B', settleType: 'hour', unitPrice: 80, history: ['private'] },
    { serviceType: '已排队C', settleType: 'round', unitPrice: 60, customRatios: { x: 1 } },
    { serviceType: '新增D', settleType: 'hour', unitPrice: 40, rawChat: 'private' },
    { serviceType: '', settleType: 'round', unitPrice: 1, note: 'invalid' },
  ];
  const hashes = [];
  for (const item of items.slice(0, 4)) hashes.push(await SnapshotApi.computeExactPriceHashes('group_fixture', 'lib_receive_fixture', { serviceName: item.serviceType, settleType: item.settleType, unitPrice: item.unitPrice }));
  let sequence = 0;
  const idFactory = { submissionId: () => `sub_01JABCDEF0123456789XYZABC${sequence++}` };
  const result = await Builder.buildInitialBindingCandidates({
    meta: { deviceId: DEVICE_ID },
    binding: { localLibraryId: 'local-1', groupId: 'group_fixture', libraryId: 'lib_receive_fixture', mode: 'collaborate' },
    localItems: items,
    baseHashes: { [hashes[0].businessKey]: hashes[0].contentHash },
    conflicts: [{ businessKey: hashes[1].businessKey, status: 'open' }],
    existingQueueRecords: [{ submission: { businessKey: hashes[2].businessKey, contentHash: hashes[2].contentHash } }],
    idFactory,
    now: () => NOW,
    snapshotApi: SnapshotApi,
    localStoresApi: null,
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].payload, { serviceName: '新增D', settleType: 'hour', unitPrice: 40 });
  assert.equal(result.counts.alreadyPublic, 1);
  assert.equal(result.counts.openConflicts, 1);
  assert.equal(result.counts.alreadyQueued, 1);
  assert.equal(result.counts.invalid, 1);
  assert.doesNotThrow(() => normalizeSubmission(result.candidates[0]));
  assert.equal(JSON.stringify(result.candidates[0]).includes('rawChat'), false);
});

test('receive-only binding blocks stale queue record without any network request', async () => {
  let submits = 0;
  const client = { isWriteEnabled: () => true, submit: async () => { submits += 1; } };
  const { dispatcher, queueStore } = makeDispatcher({ mode: 'receive', client });
  const result = await dispatcher.dispatchDue({ reason: 'manual' });
  assert.equal(submits, 0);
  assert.equal(result.blocked, 1);
  assert.equal(queueStore.records[0].deliveryState, 'blocked');
  assert.equal(queueStore.records[0].lastErrorCode, 'BINDING_NOT_COLLABORATIVE');
});

test('offline dispatcher leaves queue untouched and normal local flow available', async () => {
  let submits = 0;
  const client = { isWriteEnabled: () => true, submit: async () => { submits += 1; } };
  const { dispatcher, queueStore } = makeDispatcher({ online: false, client });
  const result = await dispatcher.dispatchDue({ reason: 'manual' });
  assert.equal(result.status, 'offline');
  assert.equal(submits, 0);
  assert.equal(queueStore.records[0].deliveryState, 'queued');
});

test('successful or duplicate candidate acknowledgement writes queue state back', async () => {
  const client = { isWriteEnabled: () => true, submit: async ({ submission }) => ({ submissionId: submission.submissionId, duplicate: true }) };
  const { dispatcher, queueStore } = makeDispatcher({ client });
  const result = await dispatcher.dispatchDue({ reason: 'manual' });
  assert.equal(result.acknowledged, 1);
  assert.equal(queueStore.records[0].deliveryState, 'acknowledged');
  assert.equal(queueStore.records[0].attemptCount, 1);
});

test('5xx schedules retry while 401 clears credential and blocks the record', async () => {
  const serverError = Object.assign(new Error('down'), { code: 'SUBMISSION_STORAGE_FAILED', category: 'server', retryable: true, retryAfterMs: 20000 });
  const retryClient = { isWriteEnabled: () => true, submit: async () => { throw serverError; } };
  const retry = makeDispatcher({ client: retryClient });
  const retryResult = await retry.dispatcher.dispatchDue({ reason: 'manual' });
  assert.equal(retryResult.retried, 1);
  assert.equal(retry.queueStore.records[0].deliveryState, 'retry_wait');
  assert.equal(retry.queueStore.records[0].nextRetryAt, NOW + 20000);

  const authError = Object.assign(new Error('bad token'), { code: 'DEVICE_TOKEN_NOT_FOUND', category: 'credential_invalid', retryable: false });
  const authClient = { isWriteEnabled: () => true, submit: async () => { throw authError; } };
  const blocked = makeDispatcher({ client: authClient });
  const blockedResult = await blocked.dispatcher.dispatchDue({ reason: 'manual' });
  assert.equal(blockedResult.blocked, 1);
  assert.equal(blocked.queueStore.records[0].deliveryState, 'blocked');
  assert.equal(blocked.credentialStore.cleared, true);
});
