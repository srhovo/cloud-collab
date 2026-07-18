import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdempotencyKey, computeSubmissionHashes } from '../src/server/submission_policy_v1.js';
import { createDeviceRegisterHandler } from '../cloud-functions/api/v1/device-register.js';
import { createSubmissionHandler } from '../cloud-functions/api/v1/submissions.js';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.writes = [];
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      error.status = 412;
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = '', consistency = 'eventual' } = {}) {
    this.lists.push({ prefix, consistency });
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key, etag: 'memory' })),
    };
  }
}

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';
const NOW = 1784376000000;

function registration(deviceId = DEVICE_A) {
  return {
    schemaVersion: 1,
    deviceId,
    nickname: '小雪',
    clientContext: { appVersion: '8.2.28' },
  };
}

function submission({ deviceId = DEVICE_A, submissionId = SUBMISSION_A, unitPrice = 110 } = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
    contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload: { serviceName: '测试服务A', settleType: 'round', unitPrice },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const computed = computeSubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  return value;
}

function jsonRequest(path, body, { authorization = null, method = 'POST' } = {}) {
  const headers = new Headers();
  if (method !== 'OPTIONS') headers.set('Content-Type', 'application/json');
  if (authorization) headers.set('Authorization', authorization);
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    ...(method === 'OPTIONS' ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response) {
  return response.status === 204 ? null : response.json();
}

function handlers(store, now = NOW) {
  const getStore = async () => store;
  return {
    register: createDeviceRegisterHandler({ getStore, now: () => now }),
    submit: createSubmissionHandler({ getStore, now: () => now + 10 }),
  };
}

async function registerFixture({ store = new MemoryBlobStore(), now = NOW } = {}) {
  const route = createDeviceRegisterHandler({ getStore: async () => store, now: () => now });
  const response = await route({
    request: jsonRequest('/api/v1/device-register', registration()),
    env: {
      CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED: 'true',
      CLOUD_COLLAB_BLOB_STORE: 'cloud-collab-v1',
    },
  });
  const payload = await json(response);
  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  return { store, credential: payload.data };
}

test('write routes fail closed before storage access when flags are disabled', async () => {
  let storeCalls = 0;
  const getStore = async () => { storeCalls += 1; return new MemoryBlobStore(); };
  const register = createDeviceRegisterHandler({ getStore, now: () => NOW });
  const submit = createSubmissionHandler({ getStore, now: () => NOW });

  const registerResponse = await register({
    request: jsonRequest('/api/v1/device-register', registration()),
    env: {},
  });
  assert.equal(registerResponse.status, 503);
  assert.equal((await json(registerResponse)).error.code, 'DEVICE_REGISTRATION_DISABLED');

  const submitResponse = await submit({
    request: jsonRequest('/api/v1/submissions', submission(), { authorization: 'Bearer invalid' }),
    env: {},
  });
  assert.equal(submitResponse.status, 503);
  assert.equal((await json(submitResponse)).error.code, 'SUBMISSION_INTAKE_DISABLED');
  assert.equal(storeCalls, 0);
});

test('write routes answer OPTIONS without enabling storage or writes', async () => {
  let storeCalls = 0;
  const submit = createSubmissionHandler({ getStore: async () => { storeCalls += 1; return new MemoryBlobStore(); } });
  const response = await submit({
    request: jsonRequest('/api/v1/submissions', null, { method: 'OPTIONS' }),
    env: {},
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal(storeCalls, 0);
});

test('enabled registration returns an opaque token while Blob stores only its hash', async () => {
  const { store, credential } = await registerFixture();
  assert.match(credential.deviceToken, /^dt_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.deviceId, DEVICE_A);
  assert.equal(credential.nicknameTag, 'ABCD');
  const persisted = JSON.stringify([...store.values.values()]);
  assert.equal(persisted.includes(credential.deviceToken), false);
  assert.match(persisted, /dth_v1_[A-Za-z0-9_-]{43}/);
  assert.equal(store.writes.filter(item => item.options.onlyIfNew === true).length, 2);
});

test('the registration route refuses to silently issue a second token', async () => {
  const store = new MemoryBlobStore();
  const { register } = handlers(store);
  const context = {
    request: jsonRequest('/api/v1/device-register', registration()),
    env: { CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED: 'true' },
  };
  assert.equal((await register(context)).status, 201);
  const second = await register({ ...context, request: jsonRequest('/api/v1/device-register', registration()) });
  assert.equal(second.status, 409);
  assert.equal((await json(second)).error.code, 'DEVICE_ALREADY_REGISTERED');
});

test('an authenticated submission becomes one immutable waiting candidate', async () => {
  const { store, credential } = await registerFixture();
  const route = createSubmissionHandler({ getStore: async () => store, now: () => NOW + 10 });
  const response = await route({
    request: jsonRequest('/api/v1/submissions', submission(), { authorization: `Bearer ${credential.deviceToken}` }),
    env: {
      CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED: 'true',
      CLOUD_COLLAB_SUBMISSION_MINUTE_LIMIT: '20',
      CLOUD_COLLAB_SUBMISSION_HOUR_LIMIT: '200',
    },
  });
  const payload = await json(response);
  assert.equal(response.status, 202);
  assert.equal(payload.data.status, 'waiting_confirmation');
  assert.equal(payload.data.publicMutationAllowed, false);
  assert.equal(payload.data.autoApprovalEnabled, false);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('submissions/')).length, 1);
  assert.equal([...store.values.keys()].some(key => key.startsWith('libraries/')), false);
});

test('same idempotency key and same body replays the first result', async () => {
  const { store, credential } = await registerFixture();
  const route = createSubmissionHandler({ getStore: async () => store, now: () => NOW + 10 });
  const context = body => ({
    request: jsonRequest('/api/v1/submissions', body, { authorization: `Bearer ${credential.deviceToken}` }),
    env: { CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED: 'true' },
  });
  const first = await json(await route(context(submission())));
  const second = await json(await route(context(submission())));
  assert.equal(first.data.receivedAt, second.data.receivedAt);
  assert.equal(second.data.duplicate, true);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('submissions/')).length, 1);
  assert.equal((await store.list({ prefix: 'rate/submission/minute/' })).blobs.length, 1);
});

test('same idempotency key with a different normalized body returns 409', async () => {
  const { store, credential } = await registerFixture();
  const route = createSubmissionHandler({ getStore: async () => store, now: () => NOW + 10 });
  const env = { CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED: 'true' };
  const authorization = `Bearer ${credential.deviceToken}`;
  assert.equal((await route({ request: jsonRequest('/api/v1/submissions', submission(), { authorization }), env })).status, 202);
  const conflict = await route({ request: jsonRequest('/api/v1/submissions', submission({ unitPrice: 120 }), { authorization }), env });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('Authorization device must match the submission deviceId', async () => {
  const { store, credential } = await registerFixture();
  const route = createSubmissionHandler({ getStore: async () => store, now: () => NOW + 10 });
  const response = await route({
    request: jsonRequest('/api/v1/submissions', submission({ deviceId: DEVICE_B }), { authorization: `Bearer ${credential.deviceToken}` }),
    env: { CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED: 'true' },
  });
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, 'DEVICE_SCOPE_MISMATCH');
  assert.equal([...store.values.keys()].filter(key => key.startsWith('submissions/')).length, 0);
});

test('persistent minute rate limit rejects the second distinct submission', async () => {
  const { store, credential } = await registerFixture();
  const route = createSubmissionHandler({ getStore: async () => store, now: () => NOW + 10 });
  const env = {
    CLOUD_COLLAB_SUBMISSION_INTAKE_ENABLED: 'true',
    CLOUD_COLLAB_SUBMISSION_MINUTE_LIMIT: '1',
    CLOUD_COLLAB_SUBMISSION_HOUR_LIMIT: '10',
  };
  const authorization = `Bearer ${credential.deviceToken}`;
  const first = await route({ request: jsonRequest('/api/v1/submissions', submission(), { authorization }), env });
  assert.equal(first.status, 202);
  const second = await route({
    request: jsonRequest('/api/v1/submissions', submission({ submissionId: SUBMISSION_B, unitPrice: 120 }), { authorization }),
    env,
  });
  assert.equal(second.status, 429);
  const payload = await json(second);
  assert.equal(payload.error.code, 'RATE_LIMITED');
  assert.equal(payload.error.retryable, true);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('submissions/')).length, 1);
  assert.equal(store.lists.every(item => item.consistency === 'strong'), true);
});
