import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  ADMIN_ROLLBACK_CONFIRMATION,
  executeAdminRollback,
  rollbackRefForEventPair,
} from '../src/server/admin_rollback_v1.js';
import {
  handleAdminRollbackListByMode,
} from '../src/server/admin_rollback_mode_dispatch_v1.js';
import {
  handleProductionAdminRollbackExecuteRequest,
  handleProductionAdminRollbackListRequest,
  readProductionAdminRollbackConfig,
} from '../src/server/production_admin_rollback_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_650_000_000;
const ADMIN_ORIGIN = 'https://admin.example.invalid';
const ROLLBACK_REF = `rbref_v1_${'A'.repeat(43)}`;
const REQUEST_ID = `rbrq_v1_${'B'.repeat(22)}`;
const BUSINESS_KEY = `bk_v1_${'C'.repeat(43)}`;
const CONTENT_ONE = `ch_v1_${'D'.repeat(43)}`;
const CONTENT_TWO = `ch_v1_${'E'.repeat(43)}`;
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const SUBMISSION = 'sub_01JABCDEF0123456789XYZABCD';
const secret = label => `${label}-${'x'.repeat(40)}`;

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
    CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: secret('device-ref'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: secret('rollback-ref'),
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('export-audit'),
    ...overrides,
  };
}

function cookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 14),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(pathname, {
  method = 'GET',
  body,
  origin = ADMIN_ORIGIN,
  runtimeEnv = env(),
} = {}) {
  return new Request(`${ADMIN_ORIGIN}${pathname}`, {
    method,
    headers: {
      Cookie: cookie(runtimeEnv),
      'Sec-Fetch-Site': origin === ADMIN_ORIGIN ? 'same-origin' : 'cross-site',
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function publicEvent({ version, contentHash, unitPrice }) {
  return {
    schemaVersion: 1,
    version,
    eventKey: `public/lib_see_cz/events/${String(version).padStart(12, '0')}.json`,
    approvalId: `ap_v1_${String(version).repeat(43).slice(0, 43)}`,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    approvedAt: new Date(NOW + version * 1000).toISOString(),
    businessKey: BUSINESS_KEY,
    contentHash,
    dataType: 'exact_price',
    operation: 'upsert',
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice },
    baseline: { approvedVersion: Math.max(0, version - 1), contentHash: version === 1 ? null : CONTENT_ONE, unitPrice: version === 1 ? null : 100 },
    approval: { mode: 'admin_approved', deviceIds: [DEVICE], submissionIds: [SUBMISSION] },
  };
}

test('正式回滚配置绑定公共Store、生产作用域和独立回滚盐', () => {
  const config = readProductionAdminRollbackConfig(env());
  assert.equal(config.productionEnabled, true);
  assert.equal(config.previewEnabled, false);
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.groupId, 'group_see');
  assert.equal(config.libraryId, 'lib_see_cz');
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.equal(config.rollbackRefSalt, secret('rollback-ref'));
  assert.equal(config.syntheticFixtureOnly, false);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('回滚核心使用传入正式作用域生成引用，不再硬编码合成库', () => {
  const config = readProductionAdminRollbackConfig(env());
  const previous = publicEvent({ version: 1, contentHash: CONTENT_ONE, unitPrice: 100 });
  const current = publicEvent({ version: 2, contentHash: CONTENT_TWO, unitPrice: 120 });
  const ref = rollbackRefForEventPair({ config, current, previous });
  assert.match(ref, /^rbref_v1_[A-Za-z0-9_-]{43}$/u);
  assert.throws(
    () => rollbackRefForEventPair({
      config,
      current: { ...current, groupId: 'group_fixture' },
      previous,
    }),
    error => error.code === 'ADMIN_ROLLBACK_EVENT_INVALID',
  );
});

test('回滚核心接受productionEnabled门禁并继续严格校验正文', async () => {
  const config = readProductionAdminRollbackConfig(env());
  await assert.rejects(
    () => executeAdminRollback({
      store: {},
      config,
      identity: { username: 'xiaxue' },
      command: {},
      now: NOW,
    }),
    error => error.code === 'ADMIN_ROLLBACK_INPUT_INVALID',
  );
  await assert.rejects(
    () => executeAdminRollback({
      store: {},
      config: { ...config, productionEnabled: false },
      identity: { username: 'xiaxue' },
      command: {},
      now: NOW,
    }),
    error => error.code === 'ADMIN_ROLLBACK_DISABLED',
  );
});

test('正式回滚列表使用生产会话和公共Store并返回脱敏候选', async () => {
  let storeName = null;
  const result = {
    schemaVersion: 1,
    count: 1,
    candidates: [{
      schemaVersion: 1,
      rollbackRef: ROLLBACK_REF,
      serviceName: '鹅鸭杀',
      settleType: 'round',
      currentUnitPrice: 120,
      previousUnitPrice: 100,
      currentVersion: 2,
      previousVersion: 1,
      currentApprovedAt: new Date(NOW + 2000).toISOString(),
      previousApprovedAt: new Date(NOW + 1000).toISOString(),
    }],
  };
  const response = await handleProductionAdminRollbackListRequest({
    env: env(),
    request: request('/api/admin/rollbacks'),
  }, {
    now: () => NOW,
    createStore: name => {
      storeName = name;
      return {};
    },
    listCandidates: async ({ config }) => {
      assert.equal(config.productionEnabled, true);
      return result;
    },
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.result.candidates[0].rollbackRef, ROLLBACK_REF);
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(body.data.capabilities.publicMutationAllowed, true);
  assert.equal(body.data.realSecretValuesExposed, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
  assert.equal(text.includes(secret('rollback-ref')), false);
});

test('正式回滚执行传递确认词、生产身份、公共Store和显式命令', async () => {
  const command = {
    schemaVersion: 1,
    rollbackRef: ROLLBACK_REF,
    requestId: REQUEST_ID,
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  };
  let captured = null;
  const response = await handleProductionAdminRollbackExecuteRequest({
    env: env(),
    request: request('/api/admin/rollbacks/execute', { method: 'POST', body: command }),
  }, {
    now: () => NOW + 1,
    createStore: name => ({ name }),
    executeRollback: async value => {
      captured = value;
      return {
        schemaVersion: 1,
        rollbackRef: ROLLBACK_REF,
        status: 'rolled_back',
        serviceName: '鹅鸭杀',
        settleType: 'round',
        restoredUnitPrice: 100,
        replacedUnitPrice: 120,
        restoredFromVersion: 1,
        replacedVersion: 2,
        eventVersion: 3,
        publicVersion: 3,
        publicMutationApplied: true,
        duplicate: false,
      };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.store.name, 'cloud-collab-production-v1');
  assert.equal(captured.identity.username, 'xiaxue');
  assert.deepEqual(captured.command, command);
  assert.equal(captured.config.groupId, 'group_see');
  const body = await response.json();
  assert.equal(body.data.result.status, 'rolled_back');
  assert.equal(body.data.result.publicMutationApplied, true);
});

test('跨站回滚执行在正文解析和Store创建前阻断', async () => {
  let stores = 0;
  const response = await handleProductionAdminRollbackExecuteRequest({
    env: env(),
    request: request('/api/admin/rollbacks/execute', {
      method: 'POST',
      body: { broken: true },
      origin: 'https://attacker.example.invalid',
    }),
  }, {
    createStore: () => {
      stores += 1;
      return {};
    },
  });
  assert.equal(response.status, 403);
  assert.equal(stores, 0);
});

test('生产模式子开关关闭时不得回退阶段5E预览回滚', async () => {
  const closed = env({
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
  });
  let stores = 0;
  const response = await handleAdminRollbackListByMode({
    env: {
      ...closed,
      CLOUD_ADMIN_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID: 'group_fixture',
      CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    },
    request: new Request(`${ADMIN_ORIGIN}/api/admin/rollbacks`, { method: 'GET' }),
  }, {
    createStore: () => {
      stores += 1;
      return {};
    },
  });
  assert.equal(response.status, 503);
  assert.equal(stores, 0);
});

test('非法生产总开关在进入任何回滚处理器前失败关闭', async () => {
  let stores = 0;
  const response = await handleAdminRollbackListByMode({
    env: { CLOUD_PRODUCTION_ENABLED: 'invalid' },
    request: new Request(`${ADMIN_ORIGIN}/api/admin/rollbacks`, { method: 'GET' }),
  }, {
    createStore: () => {
      stores += 1;
      return {};
    },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_FLAG_INVALID');
  assert.equal(stores, 0);
});

test('两条Cloud Function入口只依赖回滚模式分发器', () => {
  for (const [relative, handler] of [
    ['cloud-functions/api/admin/rollbacks.js', 'handleAdminRollbackListRequest'],
    ['cloud-functions/api/admin/rollbacks/execute.js', 'handleAdminRollbackExecuteRequest'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /admin_rollback_mode_dispatch_v1/u);
    assert.match(source, new RegExp(handler, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*admin_rollback_http_v1/u);
  }
});

test('正式回滚静态边界使用production issuer、配置作用域和补偿事件', () => {
  const core = fs.readFileSync(path.join(root, 'src/server/admin_rollback_v1.js'), 'utf8');
  const http = fs.readFileSync(path.join(root, 'src/server/production_admin_rollback_http_v1.js'), 'utf8');
  const dispatch = fs.readFileSync(path.join(root, 'src/server/admin_rollback_mode_dispatch_v1.js'), 'utf8');
  assert.match(core, /normalizeInternalEvent\(event, config/u);
  assert.match(core, /config\?\.productionEnabled/u);
  assert.match(core, /publishAdminReviewApproval/u);
  assert.doesNotMatch(core, /function normalizeInternalEvent\(event, label/u);
  assert.match(http, /verifyProductionAdminSessionToken/u);
  assert.match(http, /runtime\.publicStoreName/u);
  assert.match(http, /CLOUD_ADMIN_ROLLBACK_REF_SALT/u);
  assert.match(http, /stablePromotionAuthorized:\s*false/u);
  assert.doesNotMatch(http, /readAdminAuthConfig|verifyAdminSessionToken/u);
  assert.match(dispatch, /resolveAdminAuthMode/u);
  assert.doesNotMatch(dispatch, /CLOUD_ADMIN_PRODUCTION_ENABLED|CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED/u);
});
