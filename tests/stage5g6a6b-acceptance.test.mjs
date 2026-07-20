import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAGE5G6A6B_ACCEPTANCE_HEADER,
  STAGE5G6A6B_SEED_CONFIRMATION,
  inspectStage5g6a6bAcceptance,
  readStage5g6a6bAcceptanceConfig,
  seedStage5g6a6bAcceptance,
} from '../src/server/stage5g6a6b_acceptance_v1.js';
import {
  handleStage5g6a6bSeedRequest,
  handleStage5g6a6bStatusRequest,
} from '../src/server/stage5g6a6b_acceptance_http_v1.js';

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) throw new Error('already exists');
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { this.values.delete(key); }
  async list(options = {}) {
    const prefix = String(options.prefix || '');
    return { blobs: [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key })) };
  }
}

const secrets = Object.freeze({
  acceptance: 'acceptance-'.padEnd(40, 'a'),
  cleanup: 'cleanup-'.padEnd(40, 'b'),
  preview: 'preview-'.padEnd(40, 'c'),
  rate: 'rate-'.padEnd(40, 'd'),
  password: 'admin-password-'.padEnd(40, 'e'),
  session: 'admin-session-'.padEnd(40, 'f'),
  adminRate: 'admin-rate-'.padEnd(40, 'g'),
});

function env(overrides = {}) {
  return {
    CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED: '1',
    CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY: secrets.acceptance,
    CLOUD_STAGE5G6A6B_CLEANUP_ENABLED: '0',
    CLOUD_STAGE5G6A6B_CLEANUP_KEY: secrets.cleanup,
    CLOUD_WRITE_PREVIEW_ENABLED: '1',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
    CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1',
    CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
    CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_WRITE_PREVIEW_KEY: secrets.preview,
    CLOUD_RATE_LIMIT_SALT: secrets.rate,
    CLOUD_ADMIN_PASSWORD: secrets.password,
    CLOUD_ADMIN_SESSION_SECRET: secrets.session,
    CLOUD_ADMIN_RATE_LIMIT_SALT: secrets.adminRate,
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://acceptance.example.test',
    ...overrides,
  };
}

function runtimeEnv(overrides = {}) {
  return env({
    CLOUD_WRITE_PREVIEW_ENABLED: '0',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
    ...overrides,
  });
}

function request(path, {
  method = 'GET',
  body = null,
  key = secrets.acceptance,
  origin = 'https://acceptance.example.test',
  fetchSite = 'same-origin',
} = {}) {
  const headers = new Headers({
    [STAGE5G6A6B_ACCEPTANCE_HEADER]: key,
  });
  if (origin) headers.set('Origin', origin);
  if (fetchSite) headers.set('Sec-Fetch-Site', fetchSite);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`https://acceptance.example.test${path}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
}

test('联合验收配置硬锁合成作用域并要求能力开启', () => {
  const config = readStage5g6a6bAcceptanceConfig(env());
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.equal(config.adminStoreName, 'cloud-collab-admin-preview-v1');
  assert.throws(
    () => readStage5g6a6bAcceptanceConfig(env({ CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_other' })),
    error => error.code === 'STAGE5G6A6B_ACCEPTANCE_SCOPE_INVALID',
  );
  assert.throws(
    () => readStage5g6a6bAcceptanceConfig(env({ CLOUD_STAGE5G6A6B_CLEANUP_ENABLED: '1' })),
    error => error.code === 'STAGE5G6A6B_ACCEPTANCE_CLEANUP_CONFLICT',
  );
});

test('种子创建两台确定性设备且精确重放不新增对象', async () => {
  const store = new MemoryStore();
  const first = await seedStage5g6a6bAcceptance({ store, confirmation: STAGE5G6A6B_SEED_CONFIRMATION, now: 1_785_000_000_000 });
  const objectCount = store.values.size;
  const second = await seedStage5g6a6bAcceptance({ store, confirmation: STAGE5G6A6B_SEED_CONFIRMATION, now: 1_785_000_001_000 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.devices.length, 2);
  assert.deepEqual(second.devices.map(item => item.deviceToken), first.devices.map(item => item.deviceToken));
  assert.equal(store.values.size, objectCount);
});

test('联合状态在空公共库中报告种子、设备和零版本', async () => {
  const store = new MemoryStore();
  await seedStage5g6a6bAcceptance({ store, confirmation: STAGE5G6A6B_SEED_CONFIRMATION, now: 1_785_000_000_000 });
  const status = await inspectStage5g6a6bAcceptance({ store, now: 1_785_000_010_000 });
  assert.equal(status.seeded, true);
  assert.equal(status.registeredDeviceCount, 2);
  assert.equal(status.publicVersion, 0);
  assert.equal(status.ordinaryPendingCount, 0);
  assert.equal(status.sensitivePendingCount, 0);
});

test('HTTP种子和状态要求同源验收密钥、关闭正式写入并支持幂等重放', async () => {
  const store = new MemoryStore();
  const dependencies = { createStore: () => store, now: () => 1_785_000_000_000 };
  const seedResponse = await handleStage5g6a6bSeedRequest({
    request: request('/api/stage5g6a6b/acceptance/seed', {
      method: 'POST',
      body: { confirmation: STAGE5G6A6B_SEED_CONFIRMATION },
    }),
    env: runtimeEnv(),
  }, dependencies);
  assert.equal(seedResponse.status, 201);
  const seedBody = await seedResponse.json();
  assert.equal(seedBody.ok, true);
  assert.equal(seedBody.data.devices.length, 2);

  const replayResponse = await handleStage5g6a6bSeedRequest({
    request: request('/api/stage5g6a6b/acceptance/seed', {
      method: 'POST',
      body: { confirmation: STAGE5G6A6B_SEED_CONFIRMATION },
    }),
    env: runtimeEnv(),
  }, dependencies);
  assert.equal(replayResponse.status, 200);

  // 浏览器同源GET通常不携带Origin；仍应依赖URL、Sec-Fetch-Site和验收密钥通过。
  const statusResponse = await handleStage5g6a6bStatusRequest({
    request: request('/api/stage5g6a6b/acceptance/status', { origin: '' }),
    env: runtimeEnv(),
  }, dependencies);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).data.registeredDeviceCount, 2);

  const denied = await handleStage5g6a6bStatusRequest({
    request: request('/api/stage5g6a6b/acceptance/status', {
      key: 'wrong-key'.padEnd(40, 'x'),
      origin: '',
    }),
    env: runtimeEnv(),
  }, dependencies);
  assert.equal(denied.status, 403);

  const crossSite = await handleStage5g6a6bStatusRequest({
    request: request('/api/stage5g6a6b/acceptance/status', {
      origin: '',
      fetchSite: 'cross-site',
    }),
    env: runtimeEnv(),
  }, dependencies);
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');

  const unsafe = await handleStage5g6a6bStatusRequest({
    request: request('/api/stage5g6a6b/acceptance/status', { origin: '' }),
    env: runtimeEnv({ CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
  }, dependencies);
  assert.equal(unsafe.status, 503);
  assert.equal((await unsafe.json()).error.code, 'STAGE5G6A6B_FORMAL_PUBLIC_MUTATION_MUST_BE_CLOSED');
});
