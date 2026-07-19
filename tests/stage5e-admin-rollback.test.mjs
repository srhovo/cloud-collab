import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionToken,
  readAdminAuthConfig,
} from '../src/server/admin_auth_v1.js';
import {
  approvalIndexKey,
  buildPublicSnapshot,
  publicEventKey,
  transitionIndexKey,
} from '../src/server/auto_approval_engine_v1.js';
import {
  ADMIN_ROLLBACK_ALLOWED_GROUP_ID,
  ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID,
  ADMIN_ROLLBACK_CONFIRMATION,
  ADMIN_ROLLBACK_PREVIEW_STORE_NAME,
  executeAdminRollback,
  isAdminRollbackProjectionSafe,
  listAdminRollbackCandidates,
  readAdminRollbackConfig,
  rollbackRefForEventPair,
} from '../src/server/admin_rollback_v1.js';
import {
  handleAdminRollbackExecuteRequest,
  handleAdminRollbackListRequest,
} from '../src/server/admin_rollback_http_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

const NOW = 1_784_440_000_000;
const GROUP_ID = ADMIN_ROLLBACK_ALLOWED_GROUP_ID;
const LIBRARY_ID = ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID;
const REF_SALT = 'stage5e-rollback-ref-salt-012345678901234';
const USERNAME = 'stage5e-admin@example.test';
const PASSWORD = 'stage5e-admin-password-0123456789';
const SESSION_SECRET = 'stage5e-session-secret-012345678901234';
const RATE_SALT = 'stage5e-rate-limit-salt-01234567890123';
const PUBLIC_ORIGIN = 'https://cloud-collab-stage5e-test-dpxqrhy0935t.edgeone.cool';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: ADMIN_ROLLBACK_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID: GROUP_ID,
  CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID: LIBRARY_ID,
  CLOUD_ADMIN_ROLLBACK_REF_SALT: REF_SALT,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
});

const IDENTITY = Object.freeze({
  username: USERNAME,
  sessionIdSuffix: '5E01',
  expiresAt: NOW + 900_000,
});

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list(options = {}) {
    this.lists.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function approvalId(label) {
  return `ap_v1_${sha256(label)}`;
}

function hashes(payload) {
  const businessKey = `bk_v1_${sha256(canonicalize({
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    normalizedServiceName: payload.serviceName.toLowerCase(),
    settleType: payload.settleType,
    ruleType: 'exact',
    variant: 'standard',
  }))}`;
  const contentHash = `ch_v1_${sha256(canonicalize({
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
  }))}`;
  return { businessKey, contentHash };
}

async function putApprovedEvent(store, {
  version,
  payload,
  baseline,
  label,
  deviceId,
  submissionId,
  approvedAt = NOW,
} = {}) {
  const { businessKey, contentHash } = hashes(payload);
  const id = approvalId(label);
  const eventKey = publicEventKey(LIBRARY_ID, version);
  const event = {
    schemaVersion: 1,
    version,
    eventKey,
    approvalId: id,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    approvedAt: new Date(approvedAt).toISOString(),
    businessKey,
    contentHash,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
    baseline,
    approval: {
      mode: 'admin_approved',
      deviceIds: [deviceId],
      submissionIds: [submissionId],
    },
  };
  const index = {
    schemaVersion: 1,
    approvalId: id,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey,
    contentHash,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    version,
    eventKey,
    createdAt: approvedAt,
  };
  await store.setJSON(eventKey, event);
  await store.setJSON(approvalIndexKey(LIBRARY_ID, id), index);
  return event;
}

async function seedTwoVersions(store, {
  serviceName = '鹅鸭杀',
  firstPrice = 100,
  secondPrice = 120,
  firstVersion = 1,
  secondVersion = 2,
  labelPrefix = 'primary',
} = {}) {
  const first = await putApprovedEvent(store, {
    version: firstVersion,
    payload: { serviceName, settleType: 'round', unitPrice: firstPrice },
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: `${labelPrefix}-first`,
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
    approvedAt: NOW + firstVersion * 1000,
  });
  const second = await putApprovedEvent(store, {
    version: secondVersion,
    payload: { serviceName, settleType: 'round', unitPrice: secondPrice },
    baseline: { approvedVersion: first.version, contentHash: first.contentHash, unitPrice: firstPrice },
    label: `${labelPrefix}-second`,
    deviceId: DEVICE_B,
    submissionId: SUBMISSION_B,
    approvedAt: NOW + secondVersion * 1000,
  });
  return { first, second };
}

function requestId(label) {
  return `rbrq_v1_${String(label).replace(/[^A-Za-z0-9_-]/g, 'A').padEnd(22, 'A').slice(0, 40)}`;
}

function command(rollbackRef, label = 'ROLLBACK') {
  return {
    schemaVersion: 1,
    rollbackRef,
    requestId: requestId(label),
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  };
}

function sessionCookie() {
  const config = readAdminAuthConfig(ENV);
  const token = createAdminSessionToken({
    config,
    now: NOW,
    randomBytes: () => Buffer.alloc(16, 8),
  }).token;
  return `${ADMIN_SESSION_COOKIE_NAME}=${token}`;
}

function adminRequest(path, { method = 'GET', body = null, origin = PUBLIC_ORIGIN, cookie = '' } = {}) {
  const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin' });
  if (origin) headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`http://edgeone-cloud-function.internal${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

test('Stage5E rollback defaults closed, hard-locks fixture scope, and requires an independent ref salt', () => {
  assert.throws(
    () => readAdminRollbackConfig({}),
    error => error.code === 'ADMIN_ROLLBACK_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminRollbackConfig({ ...ENV, CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: 'formal-public' }),
    error => error.code === 'ADMIN_ROLLBACK_SCOPE_INVALID',
  );
  assert.throws(
    () => readAdminRollbackConfig({ ...ENV, CLOUD_ADMIN_ROLLBACK_REF_SALT: SESSION_SECRET }),
    error => error.code === 'ADMIN_ROLLBACK_REF_SALT_REUSED',
  );
  assert.throws(
    () => readAdminRollbackConfig({ ...ENV, CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_ROLLBACK_REQUIRES_OTHER_MUTATIONS_CLOSED',
  );
  assert.equal(readAdminRollbackConfig(ENV).storeName, ADMIN_ROLLBACK_PREVIEW_STORE_NAME);
});

test('Stage5E lists only current items with a previous approved value and hides internal identity', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  await seedTwoVersions(store);
  await putApprovedEvent(store, {
    version: 3,
    payload: { serviceName: '永劫无间', settleType: 'hour', unitPrice: 88 },
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: 'single',
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
    approvedAt: NOW + 3000,
  });

  const listed = await listAdminRollbackCandidates({ store, config });
  assert.equal(listed.count, 1);
  assert.equal(listed.candidates[0].currentUnitPrice, 120);
  assert.equal(listed.candidates[0].previousUnitPrice, 100);
  assert.equal(listed.candidates[0].rollbackRef.startsWith('rbref_v1_'), true);
  assert.equal(isAdminRollbackProjectionSafe(listed), true);
  const serialized = JSON.stringify(listed);
  for (const forbidden of ['businessKey', 'contentHash', 'eventKey', 'deviceId', 'submissionId']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(store.lists.every(item => item.consistency === 'strong'), true);
});

test('Stage5E requires the fixed confirmation phrase and reports first-insert rollback separately', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  const first = await putApprovedEvent(store, {
    version: 1,
    payload: { serviceName: '首次项目', settleType: 'round', unitPrice: 66 },
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: 'first-only',
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
    approvedAt: NOW + 1000,
  });
  const firstRef = rollbackRefForEventPair({ config, current: first, previous: null });

  await assert.rejects(
    () => executeAdminRollback({
      store,
      config,
      identity: IDENTITY,
      command: { ...command(firstRef, 'BADCONFIRM'), confirmation: 'ROLLBACK' },
      now: NOW + 2000,
    }),
    error => error.code === 'ADMIN_ROLLBACK_CONFIRMATION_REQUIRED' && error.status === 400,
  );

  await assert.rejects(
    () => executeAdminRollback({
      store,
      config,
      identity: IDENTITY,
      command: command(firstRef, 'NOPREVIOUS'),
      now: NOW + 3000,
    }),
    error => error.code === 'ADMIN_ROLLBACK_NO_PREVIOUS_VALUE' && error.status === 409,
  );
});

test('Stage5E appends a compensating event, preserves history, rebuilds snapshot, and recovers idempotently', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  const seeded = await seedTwoVersions(store);
  const beforeFirst = structuredClone(await store.get(seeded.first.eventKey));
  const beforeSecond = structuredClone(await store.get(seeded.second.eventKey));
  const listed = await listAdminRollbackCandidates({ store, config });
  const input = command(listed.candidates[0].rollbackRef, 'SUCCESS');

  const result = await executeAdminRollback({
    store,
    config,
    identity: IDENTITY,
    command: input,
    now: NOW + 5000,
  });
  assert.equal(result.restoredUnitPrice, 100);
  assert.equal(result.replacedUnitPrice, 120);
  assert.equal(result.eventVersion, 3);
  assert.equal(result.publicVersion, 3);
  assert.equal(result.duplicate, false);
  assert.equal(isAdminRollbackProjectionSafe(result), true);

  assert.deepEqual(await store.get(seeded.first.eventKey), beforeFirst);
  assert.deepEqual(await store.get(seeded.second.eventKey), beforeSecond);
  const snapshot = await buildPublicSnapshot({ store, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW + 6000 });
  assert.equal(snapshot.publicVersion, 3);
  assert.equal(snapshot.records[0].payload.unitPrice, 100);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`public/${LIBRARY_ID}/events/`)).length, 3);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`rollbacks/${LIBRARY_ID}/decisions/`)).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`rollbacks/${LIBRARY_ID}/requests/`)).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`rollbacks/${LIBRARY_ID}/completions/`)).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('audit/')).length, 1);

  const replay = await executeAdminRollback({
    store,
    config,
    identity: IDENTITY,
    command: input,
    now: NOW + 7000,
  });
  assert.equal(replay.eventVersion, 3);
  assert.equal(replay.publicVersion, 3);
  assert.equal(replay.duplicate, true);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`public/${LIBRARY_ID}/events/`)).length, 3);

  await assert.rejects(
    () => executeAdminRollback({
      store,
      config,
      identity: IDENTITY,
      command: command(listed.candidates[0].rollbackRef, 'STALE'),
      now: NOW + 8000,
    }),
    error => error.code === 'ADMIN_ROLLBACK_TARGET_STALE' && error.status === 409,
  );
});

test('Stage5E same request id with a different valid target conflicts before a second decision is created', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  await seedTwoVersions(store, { serviceName: '项目甲', firstVersion: 1, secondVersion: 2, labelPrefix: 'a' });
  await seedTwoVersions(store, { serviceName: '项目乙', firstVersion: 3, secondVersion: 4, labelPrefix: 'b' });
  const listed = await listAdminRollbackCandidates({ store, config });
  assert.equal(listed.count, 2);
  const sharedId = requestId('SHARED');
  const firstCommand = {
    schemaVersion: 1,
    rollbackRef: listed.candidates[0].rollbackRef,
    requestId: sharedId,
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  };
  const secondCommand = { ...firstCommand, rollbackRef: listed.candidates[1].rollbackRef };

  await executeAdminRollback({ store, config, identity: IDENTITY, command: firstCommand, now: NOW + 5000 });
  await assert.rejects(
    () => executeAdminRollback({ store, config, identity: IDENTITY, command: secondCommand, now: NOW + 6000 }),
    error => error.code === 'ADMIN_ROLLBACK_REQUEST_CONFLICT' && error.status === 409,
  );
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`rollbacks/${LIBRARY_ID}/decisions/`)).length, 1);
});

test('Stage5E rejects an occupied public baseline without overwriting the other transition', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  const { second } = await seedTwoVersions(store);
  const listed = await listAdminRollbackCandidates({ store, config });
  const key = transitionIndexKey(LIBRARY_ID, second.businessKey, second.version);
  await store.setJSON(key, {
    schemaVersion: 1,
    transitionKey: key,
    approvalId: approvalId('other-transition'),
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey: second.businessKey,
    baselineApprovedVersion: second.version,
    baselineContentHash: second.contentHash,
    targetContentHash: hashes({ serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 90 }).contentHash,
    version: 3,
    eventKey: publicEventKey(LIBRARY_ID, 3),
    createdAt: NOW + 3000,
  });

  await assert.rejects(
    () => executeAdminRollback({
      store,
      config,
      identity: IDENTITY,
      command: command(listed.candidates[0].rollbackRef, 'CONFLICT'),
      now: NOW + 4000,
    }),
    error => error.code === 'ADMIN_ROLLBACK_TRANSITION_CONFLICT' && error.status === 409,
  );
  const untouched = await store.get(key);
  assert.equal(untouched.approvalId, approvalId('other-transition'));
});

test('Stage5E HTTP reuses admin session and accepts EdgeOne internal HTTP only with same-project HTTPS origin', async () => {
  const store = new MemoryBlobStore();
  await seedTwoVersions(store);
  const cookie = sessionCookie();
  const createStore = () => store;

  const listResponse = await handleAdminRollbackListRequest(
    { request: adminRequest('/api/admin/rollbacks', { cookie, origin: '' }), env: ENV },
    { createStore, now: () => NOW },
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.data.result.count, 1);

  const executeResponse = await handleAdminRollbackExecuteRequest(
    {
      request: adminRequest('/api/admin/rollbacks/execute', {
        method: 'POST',
        body: command(listPayload.data.result.candidates[0].rollbackRef, 'HTTP'),
        cookie,
      }),
      env: ENV,
    },
    { createStore, now: () => NOW + 5000 },
  );
  assert.equal(executeResponse.status, 200);
  const executePayload = await executeResponse.json();
  assert.equal(executePayload.data.result.restoredUnitPrice, 100);
  assert.equal(JSON.stringify(executePayload).includes('businessKey'), false);

  const crossProject = await handleAdminRollbackExecuteRequest(
    {
      request: adminRequest('/api/admin/rollbacks/execute', {
        method: 'POST',
        body: command(executePayload.data.result.rollbackRef, 'EVIL'),
        cookie,
        origin: 'https://evil-project-aaaaaaaaaaaa.edgeone.cool',
      }),
      env: ENV,
    },
    { createStore, now: () => NOW + 6000 },
  );
  assert.equal(crossProject.status, 403);
  assert.equal((await crossProject.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');
});
