import test from 'node:test';
import assert from 'node:assert/strict';
import deviceRegisterHandler from '../cloud-functions/api/device/register.js';
import submissionCreateHandler from '../cloud-functions/api/submissions/create.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
  MAX_SUBMISSION_BYTES,
} from '../src/server/submission_policy_v1.js';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.writes = [];
    this.deletes = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, value: this.clone(value), options: this.clone(options) });
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.deletes.push(key);
    this.values.delete(key);
  }
}

const PREVIEW_KEY = 'preview_test_key_0123456789_ABCDEFGH';
const DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD';
const SUBMISSION_ID = 'sub_01JABCDEF0123456789XYZABCD';
const FIXTURE_GROUP = 'group_fixture';
const FIXTURE_LIBRARY = 'lib_receive_fixture';

function registrationBody() {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    nickname: '预览设备',
    clientContext: { appVersion: '8.2.28' },
  };
}

function submissionBody(overrides = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: SUBMISSION_ID,
    deviceId: DEVICE_ID,
    groupId: FIXTURE_GROUP,
    libraryId: FIXTURE_LIBRARY,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: 1784376000000,
    businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
    contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
    idempotencyKey: buildIdempotencyKey(DEVICE_ID, SUBMISSION_ID),
    payload: { serviceName: '测试服务C', settleType: 'round', unitPrice: 66 },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
    ...overrides,
  };
  if (overrides.payload) value.payload = { serviceName: '测试服务C', settleType: 'round', unitPrice: 66, ...overrides.payload };
  const hashes = computeSubmissionHashes(value);
  value.businessKey = hashes.businessKey;
  value.contentHash = hashes.contentHash;
  value.idempotencyKey = hashes.idempotencyKey;
  return value;
}

function env(store, overrides = {}) {
  return {
    CLOUD_COLLAB_WRITE_PREVIEW_ENABLED: 'true',
    CLOUD_COLLAB_WRITE_PREVIEW_KEY: PREVIEW_KEY,
    CLOUD_COLLAB_TEST_STORE: store,
    ...overrides,
  };
}

function context(url, {
  method = 'POST',
  body = null,
  headers = {},
  environment = {},
} = {}) {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('content-type') && body !== null && method !== 'GET' && method !== 'HEAD') {
    requestHeaders.set('content-type', 'application/json');
  }
  const init = { method, headers: requestHeaders };
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return {
    request: new Request(url, init),
    env: environment,
  };
}

function authorizedHeaders(extra = {}) {
  return {
    'x-cloud-collab-preview-key': PREVIEW_KEY,
    ...extra,
  };
}

async function payload(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function registerThroughRoute(store) {
  const response = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  const data = await payload(response);
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.data.credential.deviceToken;
}

test('write routes are disabled by default and do not touch storage', async () => {
  const store = new MemoryBlobStore();
  const response = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: authorizedHeaders(),
    environment: { CLOUD_COLLAB_TEST_STORE: store },
  }));
  const data = await payload(response);
  assert.equal(response.status, 503);
  assert.equal(data.error.code, 'WRITE_PREVIEW_DISABLED');
  assert.equal(store.reads.length, 0);
  assert.equal(store.writes.length, 0);
});

test('preview key must be securely configured and match in constant-time gate', async () => {
  const store = new MemoryBlobStore();
  const shortConfig = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: { 'x-cloud-collab-preview-key': 'short' },
    environment: env(store, { CLOUD_COLLAB_WRITE_PREVIEW_KEY: 'short' }),
  }));
  assert.equal(shortConfig.status, 503);
  assert.equal((await payload(shortConfig)).error.code, 'WRITE_PREVIEW_KEY_NOT_CONFIGURED');

  const missing = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    environment: env(store),
  }));
  assert.equal(missing.status, 403);
  assert.equal((await payload(missing)).error.code, 'WRITE_PREVIEW_ACCESS_DENIED');

  const wrong = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: { 'x-cloud-collab-preview-key': `${PREVIEW_KEY}x` },
    environment: env(store),
  }));
  assert.equal(wrong.status, 403);
  assert.equal((await payload(wrong)).error.code, 'WRITE_PREVIEW_ACCESS_DENIED');
  assert.equal(store.writes.length, 0);
});

test('OPTIONS is allowed without secrets while other unsupported methods return 405', async () => {
  const options = await deviceRegisterHandler(context('https://example.test/api/device/register', { method: 'OPTIONS' }));
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers') || '', /Authorization/);
  assert.match(options.headers.get('access-control-allow-headers') || '', /X-Cloud-Collab-Preview-Key/);

  const get = await deviceRegisterHandler(context('https://example.test/api/device/register', { method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal((await payload(get)).error.code, 'METHOD_NOT_ALLOWED');
});

test('registration route validates media type, JSON and 8KB body limit', async () => {
  const store = new MemoryBlobStore();
  const wrongMedia = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: JSON.stringify(registrationBody()),
    headers: authorizedHeaders({ 'content-type': 'text/plain' }),
    environment: env(store),
  }));
  assert.equal(wrongMedia.status, 415);
  assert.equal((await payload(wrongMedia)).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const invalidJson = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: '{bad',
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payload(invalidJson)).error.code, 'INVALID_JSON');

  const tooLarge = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: JSON.stringify({ padding: 'x'.repeat(8 * 1024) }),
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await payload(tooLarge)).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(store.writes.length, 0);
});

test('registration returns plaintext token once while Blob stores only its hash', async () => {
  const store = new MemoryBlobStore();
  const response = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  const data = await payload(response);
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.data.environment, 'isolated_preview');
  assert.match(data.data.credential.deviceToken, /^dt_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(data.data.submissionEnabled, false);
  assert.equal(data.data.publicMutationAllowed, false);
  assert.equal(data.data.autoApprovalEnabled, false);

  const persisted = JSON.stringify([...store.values.values()]);
  assert.equal(persisted.includes(data.data.credential.deviceToken), false);
  assert.equal(persisted.includes(PREVIEW_KEY), false);
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes.every(item => item.options.onlyIfNew === true), true);
  assert.equal(store.reads.every(item => item.options.consistency === 'strong'), true);
});

test('anonymous repeat registration cannot rotate an existing device token', async () => {
  const store = new MemoryBlobStore();
  await registerThroughRoute(store);
  const before = JSON.stringify([...store.values.entries()]);
  const repeated = await deviceRegisterHandler(context('https://example.test/api/device/register', {
    body: registrationBody(),
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  const data = await payload(repeated);
  assert.equal(repeated.status, 409);
  assert.equal(data.error.code, 'DEVICE_ALREADY_REGISTERED');
  assert.equal(JSON.stringify([...store.values.entries()]), before);
});

test('submission route accepts one authenticated fixture candidate and never mutates public data', async () => {
  const store = new MemoryBlobStore();
  const deviceToken = await registerThroughRoute(store);
  const response = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
    body: submissionBody(),
    headers: authorizedHeaders({ authorization: `Bearer ${deviceToken}` }),
    environment: env(store),
  }));
  const data = await payload(response);
  assert.equal(response.status, 202, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.data.status, 'waiting_confirmation');
  assert.equal(data.data.decision, 'waiting_confirmation');
  assert.equal(data.data.duplicate, false);
  assert.equal(data.data.environment, 'isolated_preview');
  assert.equal(data.data.fixtureScopeOnly, true);
  assert.equal(data.data.publicMutationAllowed, false);
  assert.equal(data.data.autoApprovalEnabled, false);

  const keys = [...store.values.keys()];
  assert.equal(keys.filter(key => key.startsWith('submissions/')).length, 1);
  assert.equal(keys.some(key => key.startsWith('libraries/')), false);
  assert.equal(keys.some(key => key.startsWith('approved-events/')), false);
  assert.equal(JSON.stringify([...store.values.values()]).includes(PREVIEW_KEY), false);
});

test('submission route requires Bearer device authentication', async () => {
  const store = new MemoryBlobStore();
  const response = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
    body: submissionBody(),
    headers: authorizedHeaders(),
    environment: env(store),
  }));
  const data = await payload(response);
  assert.equal(response.status, 401);
  assert.equal(data.error.code, 'DEVICE_AUTH_REQUIRED');
  assert.equal([...store.values.keys()].some(key => key.startsWith('submissions/')), false);
});

test('submission route rejects every non-fixture group or library before writing', async () => {
  const store = new MemoryBlobStore();
  const deviceToken = await registerThroughRoute(store);
  for (const candidate of [
    submissionBody({ groupId: 'group_xiacijian', libraryId: FIXTURE_LIBRARY }),
    submissionBody({ groupId: FIXTURE_GROUP, libraryId: 'lib_xiacijian_regular' }),
  ]) {
    const response = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
      body: candidate,
      headers: authorizedHeaders({ authorization: `Bearer ${deviceToken}` }),
      environment: env(store),
    }));
    const data = await payload(response);
    assert.equal(response.status, 403);
    assert.equal(data.error.code, 'PREVIEW_SCOPE_REQUIRED');
  }
  assert.equal([...store.values.keys()].some(key => key.startsWith('submissions/')), false);
});

test('submission body uses the frozen 16KB maximum', async () => {
  const store = new MemoryBlobStore();
  assert.equal(MAX_SUBMISSION_BYTES, 16 * 1024);
  const response = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
    body: JSON.stringify({ padding: 'x'.repeat(MAX_SUBMISSION_BYTES) }),
    headers: authorizedHeaders({ authorization: 'Bearer invalid' }),
    environment: env(store),
  }));
  assert.equal(response.status, 413);
  assert.equal((await payload(response)).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(store.writes.length, 0);
});

test('same idempotency key and same body returns the original candidate', async () => {
  const store = new MemoryBlobStore();
  const deviceToken = await registerThroughRoute(store);
  const requestBody = submissionBody();
  const args = {
    body: requestBody,
    headers: authorizedHeaders({ authorization: `Bearer ${deviceToken}` }),
    environment: env(store),
  };

  const first = await submissionCreateHandler(context('https://example.test/api/submissions/create', args));
  const firstData = await payload(first);
  assert.equal(first.status, 202);

  const second = await submissionCreateHandler(context('https://example.test/api/submissions/create', args));
  const secondData = await payload(second);
  assert.equal(second.status, 200);
  assert.equal(secondData.data.duplicate, true);
  assert.equal(secondData.data.receivedAt, firstData.data.receivedAt);
  assert.equal(store.writes.filter(item => item.key.startsWith('submissions/')).length, 1);
});

test('same idempotency key with changed normalized body returns 409', async () => {
  const store = new MemoryBlobStore();
  const deviceToken = await registerThroughRoute(store);
  const headers = authorizedHeaders({ authorization: `Bearer ${deviceToken}` });

  const first = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
    body: submissionBody(), headers, environment: env(store),
  }));
  assert.equal(first.status, 202);

  const conflict = await submissionCreateHandler(context('https://example.test/api/submissions/create', {
    body: submissionBody({ payload: { unitPrice: 77 } }), headers, environment: env(store),
  }));
  const data = await payload(conflict);
  assert.equal(conflict.status, 409);
  assert.equal(data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.writes.filter(item => item.key.startsWith('submissions/')).length, 1);
});
