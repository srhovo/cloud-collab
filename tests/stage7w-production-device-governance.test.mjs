import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  handleAdminDeviceBlockByMode,
  handleAdminDeviceListByMode,
} from '../src/server/admin_device_governance_mode_dispatch_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleProductionAdminDeviceBlockRequest,
  handleProductionAdminDeviceListRequest,
  handleProductionAdminDeviceTrustRequest,
  handleProductionAdminDeviceUnblockRequest,
  readProductionDeviceGovernanceConfig,
} from '../src/server/production_device_governance_http_v1.js';
import { deviceRefFor } from '../src/server/device_governance_v1.js';
import { authenticateDevice, registerDevice } from '../src/server/device_registration_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_630_000_000;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';

const SECRETS = Object.freeze({
  password: 'stage7w-admin-password-0000000000000000000001',
  client: 'stage7w-client-key-0000000000000000000000002',
  publicRate: 'stage7w-public-rate-000000000000000000000003',
  session: 'stage7w-session-secret-00000000000000000000004',
  adminRate: 'stage7w-admin-rate-000000000000000000000005',
  device: 'stage7w-device-ref-000000000000000000000006',
  rollback: 'stage7w-rollback-ref-00000000000000000000007',
  audit: 'stage7w-export-audit-000000000000000000000008',
});

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin.example.invalid',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: SECRETS.password,
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: SECRETS.client,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: SECRETS.publicRate,
    CLOUD_ADMIN_SESSION_SECRET: SECRETS.session,
    CLOUD_ADMIN_RATE_LIMIT_SALT: SECRETS.adminRate,
    CLOUD_ADMIN_DEVICE_REF_SALT: SECRETS.device,
    CLOUD_ADMIN_ROLLBACK_REF_SALT: SECRETS.rollback,
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: SECRETS.audit,
    ...overrides,
  };
}

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

function sessionCookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const session = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 7),
  });
  return createAdminSessionCookie(session.token).split(';')[0];
}

function request(pathname, {
  method = 'GET',
  body = null,
  origin = method === 'POST' ? 'https://admin.example.invalid' : null,
  cookie = sessionCookie(),
} = {}) {
  const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin' });
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('Origin', origin);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`https://admin.example.invalid${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

function command(deviceRef, requestSuffix, reasonCode) {
  return {
    schemaVersion: 1,
    deviceRef,
    requestId: `dgrq_v1_${requestSuffix.padEnd(22, 'A')}`,
    reasonCode,
  };
}

async function register(store) {
  return registerDevice({
    store,
    input: {
      schemaVersion: 1,
      deviceId: DEVICE_A,
      nickname: '正式设备甲',
      clientContext: { appVersion: '8.2.31' },
    },
    now: NOW,
    randomBytes: () => Buffer.alloc(32, 9),
  });
}

test('正式设备治理配置绑定公共生产Blob、正式作用域和独立脱敏盐值', () => {
  const config = readProductionDeviceGovernanceConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.deviceRefSalt, SECRETS.device);
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(config.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(config.stablePromotionAuthorized, false);

  assert.throws(
    () => readProductionDeviceGovernanceConfig(env({ CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_DEVICE_GOVERNANCE_DISABLED',
  );
});

test('正式设备列表使用公共生产Blob并只返回不可逆deviceRef', async () => {
  const store = new MemoryBlobStore();
  await register(store);
  let requestedStore = null;
  const response = await handleProductionAdminDeviceListRequest({
    env: env(),
    request: request('/api/admin/devices'),
  }, {
    now: () => NOW + 1000,
    createStore: name => { requestedStore = name; return store; },
  });

  assert.equal(response.status, 200);
  assert.equal(requestedStore, 'cloud-collab-production-v1');
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'production');
  assert.equal(payload.data.result.count, 1);
  assert.equal(payload.data.result.devices[0].deviceRef.startsWith('devref_v1_'), true);
  assert.equal(payload.data.capabilities.productionAdmin, true);
  assert.equal(payload.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(payload.data.realSecretValuesExposed, false);
  assert.equal(payload.data.stablePromotionAuthorized, false);
  assert.equal(JSON.stringify(payload).includes(DEVICE_A), false);
  assert.equal(JSON.stringify(payload).includes('tokenHash'), false);
  assert.equal(store.lists.every(item => item.consistency === 'strong'), true);
});

test('正式可信、封禁和解封复用不可变治理链，封禁立即阻断设备认证', async () => {
  const store = new MemoryBlobStore();
  const registration = await register(store);
  const ref = deviceRefFor(DEVICE_A, SECRETS.device);
  const dependencies = { createStore: () => store };

  const trustResponse = await handleProductionAdminDeviceTrustRequest({
    env: env(),
    request: request('/api/admin/devices/trust', {
      method: 'POST',
      body: command(ref, 'trust', 'verified_operator'),
    }),
  }, { ...dependencies, now: () => NOW + 10 });
  assert.equal(trustResponse.status, 200);
  assert.equal((await trustResponse.json()).data.result.trusted, true);

  const blockResponse = await handleProductionAdminDeviceBlockRequest({
    env: env(),
    request: request('/api/admin/devices/block', {
      method: 'POST',
      body: command(ref, 'block', 'credential_compromise'),
    }),
  }, { ...dependencies, now: () => NOW + 20 });
  assert.equal(blockResponse.status, 200);
  const blocked = await blockResponse.json();
  assert.equal(blocked.data.result.blocked, true);
  assert.equal(blocked.data.result.trusted, false);

  await assert.rejects(
    () => authenticateDevice({
      store,
      authorization: `Bearer ${registration.deviceToken}`,
      now: NOW + 21,
    }),
    error => error.code === 'DEVICE_BLOCKED' && error.status === 403,
  );

  const unblockResponse = await handleProductionAdminDeviceUnblockRequest({
    env: env(),
    request: request('/api/admin/devices/unblock', {
      method: 'POST',
      body: command(ref, 'unblock', 'manual_review_cleared'),
    }),
  }, { ...dependencies, now: () => NOW + 30 });
  assert.equal(unblockResponse.status, 200);
  const unblocked = await unblockResponse.json();
  assert.equal(unblocked.data.result.blocked, false);
  assert.equal(unblocked.data.result.trusted, false);
  assert.equal((await authenticateDevice({
    store,
    authorization: `Bearer ${registration.deviceToken}`,
    now: NOW + 31,
  })).deviceId, DEVICE_A);
});

test('跨站正式治理写入在解析正文和创建公共Blob前失败关闭', async () => {
  let storeCreates = 0;
  let bodyReads = 0;
  const original = request('/api/admin/devices/block', {
    method: 'POST',
    origin: 'https://evil.example.invalid',
    body: {},
  });
  const wrapped = {
    method: original.method,
    url: original.url,
    headers: original.headers,
    text: async () => { bodyReads += 1; return '{}'; },
  };
  const response = await handleProductionAdminDeviceBlockRequest({ env: env(), request: wrapped }, {
    now: () => NOW,
    createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(storeCreates, 0);
});

test('生产总开关决定设备治理模式，子开关关闭不回退阶段5D预览', async () => {
  let previewCalls = 0;
  let storeCreates = 0;
  const disabledEnv = env({ CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0' });
  const response = await handleAdminDeviceListByMode({
    env: disabledEnv,
    request: request('/api/admin/devices', { cookie: sessionCookie(disabledEnv) }),
  }, {
    production: {
      now: () => NOW,
      createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
    },
    preview: {
      listDevices: async () => { previewCalls += 1; return { count: 0, devices: [] }; },
    },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_DEVICE_GOVERNANCE_DISABLED');
  assert.equal(previewCalls, 0);
  assert.equal(storeCreates, 0);

  const invalid = await handleAdminDeviceListByMode({
    env: env({ CLOUD_PRODUCTION_ENABLED: 'invalid' }),
    request: request('/api/admin/devices'),
  });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('六个设备治理Cloud Function入口只依赖模式分发器并保留阶段5D处理器名', () => {
  const files = [
    ['cloud-functions/api/admin/devices.js', 'handleAdminDeviceListRequest'],
    ['cloud-functions/api/admin/devices/detail.js', 'handleAdminDeviceDetailRequest'],
    ['cloud-functions/api/admin/devices/trust.js', 'handleAdminDeviceTrustRequest'],
    ['cloud-functions/api/admin/devices/revoke-trust.js', 'handleAdminDeviceRevokeTrustRequest'],
    ['cloud-functions/api/admin/devices/block.js', 'handleAdminDeviceBlockRequest'],
    ['cloud-functions/api/admin/devices/unblock.js', 'handleAdminDeviceUnblockRequest'],
  ];
  for (const [filename, legacyName] of files) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.match(source, /admin_device_governance_mode_dispatch_v1/u);
    assert.match(source, new RegExp(legacyName, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*device_governance_http_v1\.js['"]/u);
  }
});
