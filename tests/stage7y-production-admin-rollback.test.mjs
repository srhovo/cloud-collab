import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  approvalIndexKey,
  buildPublicSnapshot,
  publicEventKey,
} from '../src/server/auto_approval_engine_v1.js';
import {
  ADMIN_ROLLBACK_CONFIRMATION,
  executeAdminRollback,
  listAdminRollbackCandidates,
} from '../src/server/admin_rollback_v1.js';
import {
  handleAdminRollbackListByMode,
} from '../src/server/admin_rollback_mode_dispatch_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleProductionAdminRollbackExecuteRequest,
  handleProductionAdminRollbackListRequest,
  readProductionAdminRollbackConfig,
} from '../src/server/production_admin_rollback_http_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_640_000_000;
const GROUP_ID = 'group_see';
const LIBRARY_ID = 'lib_see_cz';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';

const SECRETS = Object.freeze({
  password: 'stage7y-admin-password-0000000000000000000001',
  client: 'stage7y-client-key-0000000000000000000000002',
  publicRate: 'stage7y-public-rate-000000000000000000000003',
  session: 'stage7y-session-secret-00000000000000000000004',
  adminRate: 'stage7y-admin-rate-000000000000000000000005',
  rollback: 'stage7y-rollback-ref-000000000000000000000006',
});

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '0',
    CLOUD_PRODUCTION_ROLLBACK_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: GROUP_ID,
    CLOUD_PRODUCTION_LIBRARY_ID: LIBRARY_ID,
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
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: SECRETS.rollback,
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
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

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hashes(payload) {
  return {
    businessKey: `bk_v1_${sha256(canonicalize({
      groupId: GROUP_ID,
      libraryId: LIBRARY_ID,
      normalizedServiceName: payload.serviceName.toLowerCase(),
      settleType: payload.settleType,
      ruleType: 'exact',
      variant: 'standard',
    }))}`,
    contentHash: `ch_v1_${sha256(canonicalize({
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      groupId: GROUP_ID,
      libraryId: LIBRARY_ID,
      bossId: null,
      dataType: 'exact_price',
      operation: 'upsert',
      payload,
    }))}`,
  };
}

async function putApprovedEvent(store, { version, payload, baseline, label, deviceId, submissionId }) {
  const { businessKey, contentHash } = hashes(payload);
  const approvalId = `ap_v1_${sha256(label)}`;
  const eventKey = publicEventKey(LIBRARY_ID, version);
  const approvedAt = NOW + version * 1000;
  const event = {
    schemaVersion: 1,
    version,
    eventKey,
    approvalId,
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
  await store.setJSON(eventKey, event);
  await store.setJSON(approvalIndexKey(LIBRARY_ID, approvalId), {
    schemaVersion: 1,
    approvalId,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey,
    contentHash,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    version,
    eventKey,
    createdAt: approvedAt,
  });
  return event;
}

async function seedTwoVersions(store) {
  const first = await putApprovedEvent(store, {
    version: 1,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 100 },
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: 'stage7y-first',
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
  });
  const second = await putApprovedEvent(store, {
    version: 2,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 120 },
    baseline: { approvedVersion: 1, contentHash: first.contentHash, unitPrice: 100 },
    label: 'stage7y-second',
    deviceId: DEVICE_B,
    submissionId: SUBMISSION_B,
  });
  return { first, second };
}

function sessionCookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const session = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 8),
  });
  return createAdminSessionCookie(session.token).split(';')[0];
}

function request(pathname, { method = 'GET', body = null, origin = null, runtimeEnv = env() } = {}) {
  const headers = new Headers({
    Cookie: sessionCookie(runtimeEnv),
    'Sec-Fetch-Site': 'same-origin',
  });
  if (origin) headers.set('Origin', origin);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`https://admin.example.invalid${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

function command(rollbackRef, requestLabel = 'SUCCESS') {
  return {
    schemaVersion: 1,
    rollbackRef,
    requestId: `rbrq_v1_${requestLabel.padEnd(22, 'A')}`,
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  };
}

test('正式回滚配置使用独立门禁、生产公共Blob和see作用域', () => {
  const config = readProductionAdminRollbackConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, GROUP_ID);
  assert.equal(config.libraryId, LIBRARY_ID);
  assert.equal(config.rollbackRefSalt, SECRETS.rollback);
  assert.equal(config.syntheticFixtureOnly, false);
  assert.equal(config.stablePromotionAuthorized, false);

  assert.throws(
    () => readProductionAdminRollbackConfig(env({ CLOUD_PRODUCTION_ROLLBACK_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_ADMIN_ROLLBACK_DISABLED',
  );
});

test('统一回滚核心接受生产作用域并追加补偿事件，不覆盖历史', async () => {
  const store = new MemoryBlobStore();
  const config = readProductionAdminRollbackConfig(env());
  const seeded = await seedTwoVersions(store);
  const beforeFirst = await store.get(seeded.first.eventKey);
  const beforeSecond = await store.get(seeded.second.eventKey);
  const listed = await listAdminRollbackCandidates({ store, config });
  assert.equal(listed.count, 1);
  assert.equal(listed.candidates[0].currentUnitPrice, 120);
  assert.equal(listed.candidates[0].previousUnitPrice, 100);

  const result = await executeAdminRollback({
    store,
    config,
    identity: { username: 'xiaxue', sessionIdSuffix: '7Y01', expiresAt: NOW + 900_000 },
    command: command(listed.candidates[0].rollbackRef),
    now: NOW + 5000,
  });
  assert.equal(result.restoredUnitPrice, 100);
  assert.equal(result.replacedUnitPrice, 120);
  assert.equal(result.eventVersion, 3);
  assert.equal(result.publicVersion, 3);
  assert.equal(result.duplicate, false);
  assert.deepEqual(await store.get(seeded.first.eventKey), beforeFirst);
  assert.deepEqual(await store.get(seeded.second.eventKey), beforeSecond);

  const snapshot = await buildPublicSnapshot({ store, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW + 6000 });
  assert.equal(snapshot.publicVersion, 3);
  assert.equal(snapshot.records[0].payload.unitPrice, 100);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`public/${LIBRARY_ID}/events/`)).length, 3);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`rollbacks/${LIBRARY_ID}/decisions/`)).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith('audit/')).length, 1);

  const replay = await executeAdminRollback({
    store,
    config,
    identity: { username: 'xiaxue', sessionIdSuffix: '7Y01', expiresAt: NOW + 900_000 },
    command: command(listed.candidates[0].rollbackRef),
    now: NOW + 7000,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.eventVersion, 3);
});

test('正式HTTP使用生产issuer与公共Blob，并返回脱敏能力', async () => {
  const store = new MemoryBlobStore();
  await seedTwoVersions(store);
  let selectedStore = null;
  const response = await handleProductionAdminRollbackListRequest({
    env: env(),
    request: request('/api/admin/rollbacks'),
  }, {
    now: () => NOW + 100,
    createStore: name => { selectedStore = name; return store; },
  });
  assert.equal(response.status, 200);
  assert.equal(selectedStore, 'cloud-collab-production-v1');
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'production');
  assert.equal(payload.data.result.count, 1);
  assert.equal(payload.data.capabilities.productionAdmin, true);
  assert.equal(payload.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(payload.data.realSecretValuesExposed, false);
  assert.equal(payload.data.stablePromotionAuthorized, false);
  assert.equal(JSON.stringify(payload).includes('businessKey'), false);
});

test('跨站正式回滚在正文解析和公共Blob创建前失败关闭', async () => {
  let bodyReads = 0;
  let storeCreates = 0;
  const original = request('/api/admin/rollbacks/execute', {
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
  const response = await handleProductionAdminRollbackExecuteRequest({ env: env(), request: wrapped }, {
    now: () => NOW,
    createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(storeCreates, 0);
});

test('生产总开关决定回滚模式，回滚子开关关闭不回退预览', async () => {
  const disabledEnv = env({ CLOUD_PRODUCTION_ROLLBACK_ENABLED: '0' });
  let previewCalls = 0;
  let storeCreates = 0;
  const response = await handleAdminRollbackListByMode({
    env: disabledEnv,
    request: request('/api/admin/rollbacks', { runtimeEnv: disabledEnv }),
  }, {
    production: {
      now: () => NOW,
      createStore: () => { storeCreates += 1; return new MemoryBlobStore(); },
    },
    preview: {
      listCandidates: async () => { previewCalls += 1; return { count: 0, candidates: [] }; },
    },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_ADMIN_ROLLBACK_DISABLED');
  assert.equal(previewCalls, 0);
  assert.equal(storeCreates, 0);
});

test('两个回滚Cloud Function入口只依赖模式分发器并保留阶段5E处理器名', () => {
  const files = [
    ['cloud-functions/api/admin/rollbacks.js', 'handleAdminRollbackListRequest'],
    ['cloud-functions/api/admin/rollbacks/execute.js', 'handleAdminRollbackExecuteRequest'],
  ];
  for (const [filename, handler] of files) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.match(source, /admin_rollback_mode_dispatch_v1/u);
    assert.match(source, new RegExp(handler, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*admin_rollback_http_v1\.js['"]/u);
  }
});
