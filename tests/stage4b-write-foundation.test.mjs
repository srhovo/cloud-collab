import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBlobRepository } from '../cloud-functions/api/_shared/blob-store.js';
import { issueDeviceToken, verifyDeviceToken } from '../cloud-functions/api/_shared/device-token.js';
import { createDeviceRegistrationService, createSubmissionIntakeService } from '../cloud-functions/api/_shared/intake-service.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';
import deviceRegisterRoute from '../cloud-functions/api/v1/device-register.js';
import submissionsRoute from '../cloud-functions/api/v1/submissions.js';

const SECRET = 'stage4b-test-secret-that-is-longer-than-32-bytes';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUB_A = 'sub_01JABCDEF0123456789XYZABCD';

function hash(value) { return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url'); }
function makeSubmission({ deviceId = DEVICE_A, submissionId = SUB_A, unitPrice = 110 } = {}) {
  const payload = { serviceName: '测试服务A', settleType: 'round', unitPrice };
  const groupId = 'group_fixture';
  const libraryId = 'lib_receive_fixture';
  const businessKey = `bk_v1_${hash(canonicalize({ groupId, libraryId, normalizedServiceName: '测试服务a', ruleType: 'exact', settleType: 'round', variant: 'standard' }))}`;
  const contentHash = `ch_v1_${hash(canonicalize({ schemaVersion: 1, payloadSchemaVersion: 1, groupId, libraryId, bossId: null, dataType: 'exact_price', operation: 'upsert', payload }))}`;
  const idempotencyKey = `ik_v1_${hash(canonicalize({ schemaVersion: 1, deviceId, submissionId }))}`;
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId,
    libraryId,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: 1784376000000,
    businessKey,
    contentHash,
    idempotencyKey,
    payload,
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
}

class FakeBlobStore {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.status = 412;
      throw error;
    }
    this.values.set(key, structuredClone(value));
  }
  async list({ prefix = '' } = {}) {
    return { blobs: [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key, etag: 'test' })) };
  }
}

function registration(deviceId = DEVICE_A) {
  return { schemaVersion: 1, deviceId, nickname: '小雪', clientContext: { appVersion: '8.2.28', protocolVersion: 1 } };
}

async function registeredFixture({ nowValue = 1784376000000 } = {}) {
  const repository = createBlobRepository(new FakeBlobStore());
  const registrationService = createDeviceRegistrationService({ repository, secret: SECRET, now: () => nowValue, tokenTtlMs: 3600000 });
  const credential = await registrationService.register(registration());
  return { repository, credential, nowValue };
}

test('device token signs, verifies and rejects tampering', () => {
  const issued = issueDeviceToken({ deviceId: DEVICE_A, tokenVersion: 1, issuedAt: 1000, expiresAt: 5000, tokenId: 'abcdefghijklmnop' }, SECRET);
  assert.equal(verifyDeviceToken(issued.token, SECRET, { now: 2000 }).deviceId, DEVICE_A);
  const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => verifyDeviceToken(tampered, SECRET, { now: 2000 }), error => error.code === 'INVALID_DEVICE_TOKEN');
  assert.throws(() => verifyDeviceToken(issued.token, SECRET, { now: 6000 }), error => error.code === 'DEVICE_TOKEN_EXPIRED');
});

test('registration uses only-if-new and replays the same credential', async () => {
  const repository = createBlobRepository(new FakeBlobStore());
  const service = createDeviceRegistrationService({ repository, secret: SECRET, now: () => 1000, tokenTtlMs: 60000 });
  const first = await service.register(registration());
  const second = await service.register(registration());
  assert.equal(first.deviceToken, second.deviceToken);
  assert.equal(first.deviceId, DEVICE_A);
  assert.equal(first.tokenVersion, 1);
});

test('registration rejects unknown fields and short signing secret', async () => {
  const repository = createBlobRepository(new FakeBlobStore());
  const service = createDeviceRegistrationService({ repository, secret: 'short', now: () => 1000 });
  await assert.rejects(() => service.register({ ...registration(), role: 'admin' }), error => error.code === 'INVALID_REGISTRATION_FIELDS');
  await assert.rejects(() => service.register(registration()), error => error.code === 'TOKEN_SECRET_NOT_CONFIGURED');
});

test('submission intake persists a waiting candidate without public mutation', async () => {
  const { repository, credential, nowValue } = await registeredFixture();
  const service = createSubmissionIntakeService({ repository, secret: SECRET, now: () => nowValue + 1000 });
  const result = await service.submit(makeSubmission(), credential.deviceToken);
  assert.equal(result.state, 'waiting_confirmation');
  assert.equal(result.publicMutationAllowed, false);
  assert.equal(result.autoApprovalEnabled, false);
  const candidates = await repository.list('candidates/');
  assert.equal(candidates.length, 1);
});

test('same idempotent request returns the original result', async () => {
  const { repository, credential, nowValue } = await registeredFixture();
  const service = createSubmissionIntakeService({ repository, secret: SECRET, now: () => nowValue + 1000 });
  const first = await service.submit(makeSubmission(), credential.deviceToken);
  const second = await service.submit(makeSubmission(), credential.deviceToken);
  assert.equal(second.candidateId, first.candidateId);
  assert.equal(second.idempotentReplay, true);
  assert.equal((await repository.list('candidates/')).length, 1);
});

test('same idempotency key with a different body returns 409', async () => {
  const { repository, credential, nowValue } = await registeredFixture();
  const service = createSubmissionIntakeService({ repository, secret: SECRET, now: () => nowValue + 1000 });
  await service.submit(makeSubmission(), credential.deviceToken);
  await assert.rejects(() => service.submit(makeSubmission({ unitPrice: 120 }), credential.deviceToken), error => error.code === 'IDEMPOTENCY_BODY_MISMATCH' && error.status === 409);
});

test('device token must match the submission device and active profile', async () => {
  const { repository, credential, nowValue } = await registeredFixture();
  const service = createSubmissionIntakeService({ repository, secret: SECRET, now: () => nowValue + 1000 });
  await assert.rejects(() => service.submit(makeSubmission({ deviceId: DEVICE_B }), credential.deviceToken), error => error.code === 'DEVICE_TOKEN_MISMATCH');
});

test('minute rate limit is enforced with persistent markers', async () => {
  const { repository, credential, nowValue } = await registeredFixture();
  const service = createSubmissionIntakeService({ repository, secret: SECRET, now: () => nowValue + 1000, minuteLimit: 1, hourLimit: 10 });
  await service.submit(makeSubmission(), credential.deviceToken);
  const second = makeSubmission({ submissionId: 'sub_01JABCDEF0123456789XYZABCE', unitPrice: 120 });
  await assert.rejects(() => service.submit(second, credential.deviceToken), error => error.code === 'RATE_LIMITED' && error.status === 429 && error.retryable === true);
});

test('write routes fail closed before storage access when feature flags are absent', async () => {
  const registerResponse = await deviceRegisterRoute({ request: new Request('https://test/api/v1/device-register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration()) }), env: {} });
  assert.equal(registerResponse.status, 503);
  assert.equal((await registerResponse.json()).error.code, 'DEVICE_REGISTRATION_DISABLED');

  const submitResponse = await submissionsRoute({ request: new Request('https://test/api/v1/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify(makeSubmission()) }), env: {} });
  assert.equal(submitResponse.status, 503);
  assert.equal((await submitResponse.json()).error.code, 'SUBMISSION_INTAKE_DISABLED');
});

test('write routes answer OPTIONS without enabling writes', async () => {
  const response = await submissionsRoute({ request: new Request('https://test/api/v1/submissions', { method: 'OPTIONS' }), env: {} });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
