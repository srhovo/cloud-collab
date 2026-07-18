import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  PreviewWriteError,
  acceptPreviewSubmission,
  assertPreviewRequestAccess,
  consumePreviewRateSlot,
  previewRateKey,
  readPreviewWriteConfig,
  registerPreviewDevice,
} from '../src/server/preview_write_runtime_v1.js';
import {
  handleDeviceRegisterRequest,
  handleSubmissionCreateRequest,
} from '../src/server/preview_write_http_v1.js';

const NOW = 1_784_380_000_000;
const PREVIEW_KEY = 'stage4b2-preview-access-key-0123456789';
const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_RATE_LIMIT_SALT: 'stage4b2-rate-limit-salt-0123456789',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
});

class MemoryBlobStore {
  constructor() { this.items = new Map(); }
  async get(key) {
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof PreviewWriteError && error.code === code);
}

const RAW = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 1,
  submissionId: 'sub_01JABCDEF0123456789XYZABCD',
  deviceId: 'dev_01JABCDEF0123456789XYZABCD',
  groupId: 'group_fixture',
  libraryId: 'lib_receive_fixture',
  bossId: null,
  dataType: 'exact_price',
  operation: 'upsert',
  origin: 'user',
  clientCreatedAt: NOW,
  businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
  contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
  idempotencyKey: 'ik_v1_0000000000000000000000000000000000000000000',
  payload: { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 },
  clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
});

function makeSubmission(overrides = {}) {
  const value = { ...clone(RAW), ...overrides };
  value.payload = { ...RAW.payload, ...(overrides.payload || {}) };
  value.clientContext = { ...RAW.clientContext, ...(overrides.clientContext || {}) };
  value.idempotencyKey = buildIdempotencyKey(value.deviceId, value.submissionId);
  const computed = computeSubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  return value;
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Preview-Key': PREVIEW_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('preview write config is fail-closed, secret-gated and hard-locked to fixture scope', () => {
  assert.throws(() => readPreviewWriteConfig({}), error => error.code === 'PREVIEW_WRITE_DISABLED');
  assert.throws(
    () => readPreviewWriteConfig({ ...ENV, CLOUD_WRITE_PREVIEW_KEY: '' }),
    error => error.code === 'PREVIEW_ACCESS_KEY_NOT_CONFIGURED',
  );
  assert.throws(
    () => readPreviewWriteConfig({ ...ENV, CLOUD_RATE_LIMIT_SALT: 'too-short' }),
    error => error.code === 'RATE_LIMIT_SALT_NOT_CONFIGURED',
  );
  assert.throws(
    () => readPreviewWriteConfig({ ...ENV, CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_xiacijian' }),
    error => error.code === 'PREVIEW_SCOPE_MISCONFIGURED',
  );
  assert.throws(
    () => readPreviewWriteConfig({ ...ENV, CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_xiacijian_regular' }),
    error => error.code === 'PREVIEW_SCOPE_MISCONFIGURED',
  );

  const config = readPreviewWriteConfig(ENV);
  assert.equal(config.allowedGroupId, 'group_fixture');
  assert.equal(config.allowedLibraryId, 'lib_receive_fixture');
  assert.equal(assertPreviewRequestAccess(jsonRequest('https://example.test/', {}), config), true);
  assert.throws(
    () => assertPreviewRequestAccess(jsonRequest('https://example.test/', {}, { 'X-Cloud-Collab-Preview-Key': 'wrong' }), config),
    error => error.code === 'PREVIEW_ACCESS_DENIED' && error.status === 403,
  );
});

test('rate keys hash the subject and never expose the salt or device id', () => {
  const key = previewRateKey({
    scope: 'submission-create',
    subject: RAW.deviceId,
    salt: ENV.CLOUD_RATE_LIMIT_SALT,
    now: NOW,
    slotMs: 5000,
  });
  assert.match(key, /^preview-rate\/submission-create\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/);
  assert.equal(key.includes(RAW.deviceId), false);
  assert.equal(key.includes(ENV.CLOUD_RATE_LIMIT_SALT), false);
});

test('one immutable rate slot permits the first request and blocks the next', async () => {
  const store = new MemoryBlobStore();
  await consumePreviewRateSlot({ store, scope: 'device-register', subject: RAW.deviceId, salt: ENV.CLOUD_RATE_LIMIT_SALT, now: NOW, slotMs: 60_000 });
  await expectCode('PREVIEW_RATE_LIMITED', () => consumePreviewRateSlot({
    store,
    scope: 'device-register',
    subject: RAW.deviceId,
    salt: ENV.CLOUD_RATE_LIMIT_SALT,
    now: NOW,
    slotMs: 60_000,
  }));
});

test('device registration is gated before the registration service is called twice', async () => {
  const store = new MemoryBlobStore();
  let calls = 0;
  const input = { schemaVersion: 1, deviceId: RAW.deviceId, nickname: null, clientContext: { appVersion: '8.2.28' } };
  const register = async () => { calls += 1; return { deviceId: RAW.deviceId, deviceToken: 'dt_v1_test' }; };
  await registerPreviewDevice({ store, input, env: ENV, now: NOW, register });
  await expectCode('PREVIEW_RATE_LIMITED', () => registerPreviewDevice({ store, input, env: ENV, now: NOW, register }));
  assert.equal(calls, 1);
});

test('submission scope rejects any non-fixture group or library before persistence', async () => {
  const store = new MemoryBlobStore();
  const outside = makeSubmission({ groupId: 'group_other' });
  await expectCode('PREVIEW_SCOPE_FORBIDDEN', () => acceptPreviewSubmission({
    store,
    authorization: 'Bearer dt_v1_0000000000000000000000000000000000000000000',
    rawSubmission: outside,
    env: ENV,
    now: NOW,
    authenticate: async () => ({ deviceId: outside.deviceId, tokenVersion: 1 }),
    accept: async () => assert.fail('outside scope must not reach persistence'),
  }));
});

test('idempotent retry bypasses the rate slot while a new submission is limited', async () => {
  const store = new MemoryBlobStore();
  const first = makeSubmission();
  const identity = { deviceId: first.deviceId, tokenVersion: 1 };
  let accepted = 0;
  const accept = async ({ rawSubmission }) => {
    accepted += 1;
    const key = pendingSubmissionKey(rawSubmission.libraryId, rawSubmission.idempotencyKey);
    const duplicate = Boolean(await store.get(key));
    if (!duplicate) await store.setJSON(key, { schemaVersion: 1, requestHash: 'fixture', submission: rawSubmission }, { onlyIfNew: true });
    return { submissionId: rawSubmission.submissionId, duplicate, publicMutationAllowed: false, autoApprovalEnabled: false };
  };

  const firstResult = await acceptPreviewSubmission({
    store,
    authorization: 'Bearer dt_v1_0000000000000000000000000000000000000000000',
    rawSubmission: first,
    env: ENV,
    now: NOW,
    authenticate: async () => identity,
    accept,
  });
  const retryResult = await acceptPreviewSubmission({
    store,
    authorization: 'Bearer dt_v1_0000000000000000000000000000000000000000000',
    rawSubmission: first,
    env: ENV,
    now: NOW,
    authenticate: async () => identity,
    accept,
  });
  assert.equal(firstResult.duplicate, false);
  assert.equal(retryResult.duplicate, true);
  assert.equal(accepted, 2);

  const second = makeSubmission({ submissionId: 'sub_01JABCDEF0123456789XYZABCE' });
  await expectCode('PREVIEW_RATE_LIMITED', () => acceptPreviewSubmission({
    store,
    authorization: 'Bearer dt_v1_0000000000000000000000000000000000000000000',
    rawSubmission: second,
    env: ENV,
    now: NOW,
    authenticate: async () => identity,
    accept,
  }));
});

test('HTTP routes stay disabled without the feature flag and do not initialize Blob', async () => {
  let storeCalls = 0;
  const response = await handleDeviceRegisterRequest({
    env: {},
    request: jsonRequest('https://example.test/api/device/register', { hello: 'world' }),
  }, {
    createStore: () => { storeCalls += 1; return new MemoryBlobStore(); },
  });
  assert.equal(response.status, 503);
  assert.equal(storeCalls, 0);
  const body = await response.json();
  assert.equal(body.error.code, 'PREVIEW_WRITE_DISABLED');
  assert.equal(body.error.message, '预览写入服务暂时不可用');
});

test('missing or wrong preview key is rejected before body parsing and Blob initialization', async () => {
  for (const suppliedKey of [null, 'wrong-preview-key']) {
    let storeCalls = 0;
    const headers = { 'Content-Type': 'text/plain' };
    if (suppliedKey !== null) headers['X-Cloud-Collab-Preview-Key'] = suppliedKey;
    const response = await handleDeviceRegisterRequest({
      env: ENV,
      request: new Request('https://example.test/api/device/register', {
        method: 'POST',
        headers,
        body: 'not-json',
      }),
    }, {
      createStore: () => { storeCalls += 1; return new MemoryBlobStore(); },
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'PREVIEW_ACCESS_DENIED');
    assert.equal(storeCalls, 0);
    assert.equal(JSON.stringify(body).includes(PREVIEW_KEY), false);
  }
});

test('device registration HTTP route returns one-time token with explicit false mutation flags', async () => {
  const result = { deviceId: RAW.deviceId, deviceToken: 'dt_v1_fixture', issuedAt: NOW, expiresAt: NOW + 1000 };
  const response = await handleDeviceRegisterRequest({
    env: ENV,
    request: jsonRequest('https://example.test/api/device/register', { schemaVersion: 1 }),
  }, {
    createStore: () => new MemoryBlobStore(),
    registerPreview: async () => result,
    now: () => NOW,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.writeScope, 'fixture_only');
  assert.equal(body.data.deviceToken, 'dt_v1_fixture');
  assert.equal(body.data.submissionEnabled, false);
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
});

test('submission HTTP route forwards Authorization and returns 202 for a new candidate', async () => {
  const submission = makeSubmission();
  let authorization = null;
  const response = await handleSubmissionCreateRequest({
    env: ENV,
    request: jsonRequest('https://example.test/api/submissions/create', submission, { Authorization: 'Bearer dt_v1_fixture' }),
  }, {
    createStore: () => new MemoryBlobStore(),
    acceptPreview: async input => {
      authorization = input.authorization;
      return { submissionId: submission.submissionId, duplicate: false, publicMutationAllowed: false, autoApprovalEnabled: false };
    },
    now: () => NOW,
  });
  assert.equal(response.status, 202);
  assert.equal(authorization, 'Bearer dt_v1_fixture');
  const body = await response.json();
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
});

test('write HTTP routes require application/json and support key-aware preflight', async () => {
  const bad = await handleSubmissionCreateRequest({
    env: ENV,
    request: new Request('https://example.test/api/submissions/create', {
      method: 'POST',
      headers: { 'X-Cloud-Collab-Preview-Key': PREVIEW_KEY },
      body: '{}',
    }),
  });
  assert.equal(bad.status, 415);

  const preflight = await handleSubmissionCreateRequest({
    env: {},
    request: new Request('https://example.test/api/submissions/create', { method: 'OPTIONS' }),
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Cloud-Collab-Preview-Key/);
});
