import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateDevice,
  DeviceRegistrationError,
  hashDeviceToken,
  MAX_DEVICE_TOKEN_TTL_MS,
  registerDevice,
} from '../src/server/device_registration_v1.js';
import {
  acceptSubmission,
  SubmissionAcceptanceError,
} from '../src/server/submission_acceptance_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.writes = [];
  }

  clone(value) { return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)); }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) { this.values.delete(key); }
}

const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_ID = 'sub_01JABCDEF0123456789XYZABCD';
const NOW = 1784376000000;

function registration(deviceId = DEVICE_A) {
  return {
    schemaVersion: 1,
    deviceId,
    nickname: ' 小雪 ',
    clientContext: { appVersion: '8.2.28' },
  };
}

function rawSubmission(deviceId = DEVICE_A, overrides = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: SUBMISSION_ID,
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
    idempotencyKey: buildIdempotencyKey(deviceId, SUBMISSION_ID),
    payload: { serviceName: '测试服务A', settleType: 'round', unitPrice: 110 },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
    ...overrides,
  };
  if (overrides.payload) value.payload = { serviceName: '测试服务A', settleType: 'round', unitPrice: 110, ...overrides.payload };
  const computed = computeSubmissionHashes(value);
  value.businessKey = computed.businessKey;
  value.contentHash = computed.contentHash;
  value.idempotencyKey = computed.idempotencyKey;
  return value;
}

async function issue(store, deviceId = DEVICE_A, now = NOW) {
  return registerDevice({
    store,
    input: registration(deviceId),
    now,
    randomBytes: () => Buffer.alloc(32, deviceId === DEVICE_A ? 7 : 8),
  });
}

function expectCode(errorType, code) {
  return error => error instanceof errorType && error.code === code;
}

test('registration returns plaintext token once but Blob stores only its hash', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store);
  assert.match(credential.deviceToken, /^dt_v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.nicknameTag, 'ABCD');
  const persisted = JSON.stringify([...store.values.values()]);
  assert.equal(persisted.includes(credential.deviceToken), false);
  assert.equal(persisted.includes(hashDeviceToken(credential.deviceToken)), true);
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes.every(item => item.options.onlyIfNew === true), true);
});

test('authentication uses strong reads and rejects expired tokens', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store);
  const identity = await authenticateDevice({
    store,
    authorization: `Bearer ${credential.deviceToken}`,
    now: NOW + 1,
  });
  assert.equal(identity.deviceId, DEVICE_A);
  assert.equal(store.reads.slice(-2).every(item => item.options.consistency === 'strong'), true);
  await assert.rejects(
    authenticateDevice({ store, authorization: `Bearer ${credential.deviceToken}`, now: credential.expiresAt }),
    expectCode(DeviceRegistrationError, 'DEVICE_TOKEN_EXPIRED'),
  );
});

test('device token ttl has a hard 90-day cap and cannot overflow safe time', async () => {
  const tooLongStore = new MemoryBlobStore();
  await assert.rejects(
    registerDevice({
      store: tooLongStore,
      input: registration(),
      now: NOW,
      tokenTtlMs: MAX_DEVICE_TOKEN_TTL_MS + 1,
      randomBytes: () => Buffer.alloc(32, 7),
    }),
    expectCode(DeviceRegistrationError, 'INVALID_TOKEN_TTL'),
  );
  assert.equal(tooLongStore.writes.length, 0);

  const overflowStore = new MemoryBlobStore();
  await assert.rejects(
    registerDevice({
      store: overflowStore,
      input: registration(),
      now: Number.MAX_SAFE_INTEGER - 1_000,
      tokenTtlMs: 60_000,
      randomBytes: () => Buffer.alloc(32, 7),
    }),
    expectCode(DeviceRegistrationError, 'INVALID_TOKEN_EXPIRY'),
  );
  assert.equal(overflowStore.writes.length, 0);
});

test('the same deviceId cannot silently receive a second token', async () => {
  const store = new MemoryBlobStore();
  await issue(store);
  await assert.rejects(issue(store), expectCode(DeviceRegistrationError, 'DEVICE_ALREADY_REGISTERED'));
});

test('a valid submission becomes an immutable waiting-confirmation candidate', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store);
  const submission = rawSubmission();
  const result = await acceptSubmission({
    store,
    authorization: `Bearer ${credential.deviceToken}`,
    rawSubmission: submission,
    now: NOW + 10,
  });
  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.decision, 'waiting_confirmation');
  assert.equal(result.duplicate, false);
  assert.equal(result.publicMutationAllowed, false);
  assert.equal(result.autoApprovalEnabled, false);
  const submissionWrites = store.writes.filter(item => item.key.startsWith('submissions/'));
  assert.equal(submissionWrites.length, 1);
  assert.equal(submissionWrites[0].options.onlyIfNew, true);
  assert.equal([...store.values.keys()].some(key => key.startsWith('libraries/')), false);
});

test('same idempotency key and same body returns the original result', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store);
  const submission = rawSubmission();
  const args = { store, authorization: `Bearer ${credential.deviceToken}`, rawSubmission: submission, now: NOW + 10 };
  const first = await acceptSubmission(args);
  const second = await acceptSubmission({ ...args, now: NOW + 999 });
  assert.equal(first.receivedAt, second.receivedAt);
  assert.equal(second.duplicate, true);
  assert.equal(store.writes.filter(item => item.key.startsWith('submissions/')).length, 1);
});

test('same idempotency key with a different normalized body is rejected', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store);
  await acceptSubmission({
    store,
    authorization: `Bearer ${credential.deviceToken}`,
    rawSubmission: rawSubmission(),
    now: NOW + 10,
  });
  await assert.rejects(
    acceptSubmission({
      store,
      authorization: `Bearer ${credential.deviceToken}`,
      rawSubmission: rawSubmission(DEVICE_A, { payload: { unitPrice: 120 } }),
      now: NOW + 20,
    }),
    expectCode(SubmissionAcceptanceError, 'IDEMPOTENCY_CONFLICT'),
  );
});

test('Authorization device must match the submission deviceId', async () => {
  const store = new MemoryBlobStore();
  const credential = await issue(store, DEVICE_A);
  await assert.rejects(
    acceptSubmission({
      store,
      authorization: `Bearer ${credential.deviceToken}`,
      rawSubmission: rawSubmission(DEVICE_B),
      now: NOW + 10,
    }),
    expectCode(SubmissionAcceptanceError, 'DEVICE_SCOPE_MISMATCH'),
  );
  assert.equal(store.writes.filter(item => item.key.startsWith('submissions/')).length, 0);
});
