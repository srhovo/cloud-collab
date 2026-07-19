import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionToken,
  readAdminAuthConfig,
} from '../src/server/admin_auth_v1.js';
import {
  DEVICE_GOVERNANCE_PREVIEW_STORE_NAME,
  deviceRefFor,
  getAdminDeviceDetail,
  isAdminDeviceGovernanceProjectionSafe,
  listAdminDevices,
  mutateDeviceGovernance,
  readDeviceGovernanceConfig,
  readEffectiveDeviceGovernance,
} from '../src/server/device_governance_v1.js';
import {
  handleAdminDeviceBlockRequest,
  handleAdminDeviceListRequest,
  handleAdminDeviceTrustRequest,
} from '../src/server/device_governance_http_v1.js';
import {
  authenticateDevice,
  registerDevice,
} from '../src/server/device_registration_v1.js';

const NOW = 1_784_430_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const REF_SALT = 'stage5d-device-ref-salt-0123456789012345';
const USERNAME = 'stage5d-admin@example.test';
const PASSWORD = 'stage5d-admin-password-0123456789';
const SESSION_SECRET = 'stage5d-session-secret-012345678901234';
const RATE_SALT = 'stage5d-rate-limit-salt-0123456789012';
const PUBLIC_ORIGIN = 'https://cloud-collab-stage5d-test-dpxqrhy0935t.edgeone.cool';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: DEVICE_GOVERNANCE_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_DEVICE_REF_SALT: REF_SALT,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
});

const IDENTITY = Object.freeze({
  username: USERNAME,
  sessionIdSuffix: '5D01',
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

function profile(deviceId, nickname, createdAt = NOW) {
  return {
    schemaVersion: 1,
    deviceId,
    nickname,
    nicknameTag: deviceId.slice(-4),
    tokenHash: `dth_v1_${'A'.repeat(43)}`,
    tokenVersion: 1,
    issuedAt: createdAt,
    expiresAt: createdAt + 86_400_000,
    createdAt,
    updatedAt: createdAt,
    lastAppVersion: '8.2.28',
  };
}

async function seedProfiles(store) {
  await store.setJSON(`devices/profiles/${DEVICE_A}.json`, profile(DEVICE_A, '设备甲', NOW));
  await store.setJSON(`devices/profiles/${DEVICE_B}.json`, profile(DEVICE_B, null, NOW + 1));
}

function command(action, deviceRef, requestSuffix, reasonCode) {
  return {
    action,
    input: {
      schemaVersion: 1,
      deviceRef,
      requestId: `dgrq_v1_${requestSuffix.padEnd(22, 'A')}`,
      reasonCode,
    },
  };
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

function sessionCookie() {
  const config = readAdminAuthConfig(ENV);
  const token = createAdminSessionToken({
    config,
    now: NOW,
    randomBytes: () => Buffer.alloc(16, 7),
  }).token;
  return `${ADMIN_SESSION_COOKIE_NAME}=${token}`;
}

test('Stage5D governance defaults closed, hard-locks synthetic store, and requires an independent ref salt', () => {
  assert.throws(
    () => readDeviceGovernanceConfig({}),
    error => error.code === 'DEVICE_GOVERNANCE_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readDeviceGovernanceConfig({ ...ENV, CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: 'formal-devices' }),
    error => error.code === 'DEVICE_GOVERNANCE_SCOPE_INVALID',
  );
  assert.throws(
    () => readDeviceGovernanceConfig({ ...ENV, CLOUD_ADMIN_DEVICE_REF_SALT: SESSION_SECRET }),
    error => error.code === 'DEVICE_GOVERNANCE_REF_SALT_REUSED',
  );
  assert.throws(
    () => readDeviceGovernanceConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'DEVICE_GOVERNANCE_REQUIRES_OTHER_MUTATIONS_CLOSED',
  );
  assert.equal(readDeviceGovernanceConfig(ENV).storeName, DEVICE_GOVERNANCE_PREVIEW_STORE_NAME);
});

test('Stage5D list and detail expose irreversible refs without device ids, token hashes, or Blob keys', async () => {
  const store = new MemoryBlobStore();
  const config = readDeviceGovernanceConfig(ENV);
  await seedProfiles(store);
  const listed = await listAdminDevices({ store, config });
  assert.equal(listed.count, 2);
  assert.equal(listed.devices[0].deviceRef.startsWith('devref_v1_'), true);
  assert.equal(JSON.stringify(listed).includes(DEVICE_A), false);
  assert.equal(JSON.stringify(listed).includes('tokenHash'), false);
  assert.equal(isAdminDeviceGovernanceProjectionSafe(listed), true);
  assert.equal(store.lists.every(item => item.consistency === 'strong'), true);

  const detail = await getAdminDeviceDetail({ store, config, deviceRef: deviceRefFor(DEVICE_A, REF_SALT) });
  assert.equal(detail.device.displayName, '设备甲 · ABCD');
  assert.deepEqual(detail.events, []);
  assert.equal(JSON.stringify(detail).includes(DEVICE_A), false);
  assert.equal(isAdminDeviceGovernanceProjectionSafe(detail), true);
});

test('Stage5D trust, revoke, block and unblock are immutable, idempotent, and never restore trust implicitly', async () => {
  const store = new MemoryBlobStore();
  const config = readDeviceGovernanceConfig(ENV);
  await seedProfiles(store);
  const ref = deviceRefFor(DEVICE_A, REF_SALT);

  const trusted = await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('trust', ref, 'trust', 'verified_operator'),
    now: NOW + 10,
  });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.blocked, false);
  assert.equal(trusted.governanceVersion, 1);
  assert.equal(trusted.duplicate, false);

  const replayed = await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('trust', ref, 'trust', 'verified_operator'),
    now: NOW + 20,
  });
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.governanceVersion, 1);

  const revoked = await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('revoke_trust', ref, 'revoke', 'trust_withdrawn'),
    now: NOW + 30,
  });
  assert.equal(revoked.trusted, false);
  assert.equal(revoked.governanceVersion, 2);

  await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('trust', ref, 'trust-again', 'verified_operator'),
    now: NOW + 40,
  });
  const blocked = await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('block', ref, 'block', 'manual_safety'),
    now: NOW + 50,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.trusted, false);

  await assert.rejects(
    () => mutateDeviceGovernance({
      store,
      config,
      identity: IDENTITY,
      command: command('trust', ref, 'blocked-trust', 'verified_operator'),
      now: NOW + 60,
    }),
    error => error.code === 'DEVICE_GOVERNANCE_BLOCKED_CANNOT_TRUST',
  );

  const unblocked = await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('unblock', ref, 'unblock', 'manual_review_cleared'),
    now: NOW + 70,
  });
  assert.equal(unblocked.blocked, false);
  assert.equal(unblocked.trusted, false);

  const state = await readEffectiveDeviceGovernance({ store, deviceId: DEVICE_A });
  assert.equal(state.blocked, false);
  assert.equal(state.trusted, false);
  const eventKeys = [...store.values.keys()].filter(key => key.startsWith(`devices/governance/events/${DEVICE_A}/`));
  const auditKeys = [...store.values.keys()].filter(key => key.startsWith('audit/'));
  assert.equal(eventKeys.length, 5);
  assert.equal(auditKeys.length, 5);
});

test('Stage5D block makes device authentication fail closed; unblock does not issue or alter credentials', async () => {
  const store = new MemoryBlobStore();
  const config = readDeviceGovernanceConfig(ENV);
  const registration = await registerDevice({
    store,
    input: {
      schemaVersion: 1,
      deviceId: DEVICE_A,
      nickname: '认证设备',
      clientContext: { appVersion: '8.2.28' },
    },
    now: NOW,
    randomBytes: () => Buffer.alloc(32, 9),
  });
  const authorization = `Bearer ${registration.deviceToken}`;
  assert.equal((await authenticateDevice({ store, authorization, now: NOW + 1 })).deviceId, DEVICE_A);

  const ref = deviceRefFor(DEVICE_A, REF_SALT);
  await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('block', ref, 'auth-block', 'credential_compromise'),
    now: NOW + 10,
  });
  await assert.rejects(
    () => authenticateDevice({ store, authorization, now: NOW + 11 }),
    error => error.code === 'DEVICE_BLOCKED' && error.status === 403,
  );

  await mutateDeviceGovernance({
    store,
    config,
    identity: IDENTITY,
    command: command('unblock', ref, 'auth-unblock', 'manual_review_cleared'),
    now: NOW + 20,
  });
  assert.equal((await authenticateDevice({ store, authorization, now: NOW + 21 })).deviceId, DEVICE_A);
  const state = await readEffectiveDeviceGovernance({ store, deviceId: DEVICE_A });
  assert.equal(state.trusted, false);
});

test('Stage5D HTTP accepts EdgeOne internal HTTP only with same-project HTTPS origin and rejects unsafe responses', async () => {
  const store = new MemoryBlobStore();
  await seedProfiles(store);
  const cookie = sessionCookie();
  const createStore = () => store;

  const listResponse = await handleAdminDeviceListRequest(
    { request: adminRequest('/api/admin/devices', { cookie, origin: '' }), env: ENV },
    { createStore, now: () => NOW },
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.data.result.count, 2);
  assert.equal(JSON.stringify(listPayload).includes(DEVICE_A), false);

  const ref = deviceRefFor(DEVICE_A, REF_SALT);
  const body = command('trust', ref, 'http-trust', 'verified_operator').input;
  const trustResponse = await handleAdminDeviceTrustRequest(
    { request: adminRequest('/api/admin/devices/trust', { method: 'POST', body, cookie }), env: ENV },
    { createStore, now: () => NOW + 100 },
  );
  assert.equal(trustResponse.status, 200);
  assert.equal((await trustResponse.json()).data.result.trusted, true);

  const crossProject = await handleAdminDeviceBlockRequest(
    {
      request: adminRequest('/api/admin/devices/block', {
        method: 'POST',
        body: command('block', ref, 'http-block', 'abuse').input,
        cookie,
        origin: 'https://evil-project-aaaaaaaaaaaa.edgeone.cool',
      }),
      env: ENV,
    },
    { createStore, now: () => NOW + 200 },
  );
  assert.equal(crossProject.status, 403);
  assert.equal((await crossProject.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');
});
