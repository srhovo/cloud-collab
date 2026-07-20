import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchAdminLoginRequest,
  dispatchAdminSessionRequest,
} from '../src/server/admin_auth_mode_dispatch_v1.js';
import {
  dispatchSensitiveReviewListRequest,
} from '../src/server/admin_sensitive_review_mode_dispatch_v1.js';
import {
  handleProductionAdminLoginRequest,
  handleProductionAdminLogoutRequest,
  handleProductionAdminSessionRequest,
} from '../src/server/production_admin_auth_http_v1.js';
import {
  ProductionAdminAuthError,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleProductionSensitiveReviewApproveRequest,
  handleProductionSensitiveReviewDetailRequest,
  handleProductionSensitiveReviewEditAndApproveRequest,
  handleProductionSensitiveReviewListRequest,
  handleProductionSensitiveReviewRejectRequest,
} from '../src/server/production_admin_sensitive_review_http_v1.js';
import {
  ProductionAdminSensitiveReviewError,
  readProductionAdminSensitiveReviewConfig,
} from '../src/server/production_admin_sensitive_review_v1.js';

const NOW = 1_784_620_000_000;
const ADMIN_ORIGIN = 'https://admin.example.invalid';
const USER_ORIGIN = 'https://app.example.invalid';
const PASSWORD = 'stage7t-admin-password-0123456789-ABCDEFG';

function secret(label) {
  return `${label}_${'q'.repeat(40)}`;
}

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1',
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
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: USER_ORIGIN,
    CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: PASSWORD,
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

function disabledEnv() {
  const value = env();
  for (const key of [
    'CLOUD_PRODUCTION_ENABLED',
    'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
    'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
    'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
    'CLOUD_ADMIN_PRODUCTION_ENABLED',
  ]) value[key] = '0';
  value.CLOUD_PRODUCTION_PUBLIC_ORIGIN = '';
  value.CLOUD_ADMIN_PUBLIC_ORIGIN = '';
  for (const key of Object.keys(value).filter(key => key.includes('PASSWORD') || key.includes('SECRET') || key.includes('SALT') || key.includes('ACCESS_KEY'))) {
    value[key] = '';
  }
  return value;
}

class MemoryStore {
  constructor(name) {
    this.name = name;
    this.items = new Map();
    this.calls = { get: 0, setJSON: 0, delete: 0 };
  }
  async get(key) {
    this.calls.get += 1;
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    this.calls.setJSON += 1;
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, structuredClone(value));
  }
  async delete(key) {
    this.calls.delete += 1;
    this.items.delete(key);
  }
}

function adminRequest(pathname, { method = 'GET', body = null, cookie = '', origin = ADMIN_ORIGIN } = {}) {
  const headers = {
    Origin: origin,
    Referer: `${origin}/admin/`,
    'Sec-Fetch-Site': 'same-origin',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  return new Request(`${ADMIN_ORIGIN}${pathname}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
}

function cookiePair(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function login(adminStore, runtimeEnv = env()) {
  const response = await handleProductionAdminLoginRequest({
    env: runtimeEnv,
    request: adminRequest('/api/admin/auth/login', {
      method: 'POST',
      body: { schemaVersion: 1, username: 'xiaxue', password: PASSWORD },
    }),
  }, {
    createStore: name => {
      assert.equal(name, 'cloud-collab-admin-production-v1');
      return adminStore;
    },
    now: () => NOW,
    randomBytes: size => Buffer.alloc(size, 7),
  });
  return { response, cookie: cookiePair(response.headers.get('set-cookie')) };
}

test('正式管理员配置使用管理员Store、正式来源和敏感审核能力', () => {
  const config = readProductionAdminAuthConfig(env());
  assert.equal(config.storeName, 'cloud-collab-admin-production-v1');
  assert.equal(config.publicStoreName, 'cloud-collab-production-v1');
  assert.equal(config.publicOrigin, ADMIN_ORIGIN);
  assert.equal(config.username, 'xiaxue');
  assert.equal(config.capabilities.reviewQueueRead, true);
  assert.equal(config.capabilities.reviewMutation, true);
  assert.equal(config.capabilities.sensitiveReview, true);
  assert.equal(config.capabilities.deviceMutation, false);
  assert.equal(config.capabilities.rollback, false);
  assert.equal(config.capabilities.export, false);
  assert.equal(config.capabilities.stablePromotionAuthorized, false);

  const review = readProductionAdminSensitiveReviewConfig(env());
  assert.equal(review.storeName, 'cloud-collab-production-v1');
  assert.equal(review.groupId, 'group_see');
  assert.equal(review.libraryId, 'lib_see_cz');
  assert.deepEqual(review.externalScope, { clubId: 'see', libraryId: 'see_cz' });
});

test('管理员或人工审核关闭时失败关闭', () => {
  assert.throws(
    () => readProductionAdminAuthConfig(disabledEnv()),
    error => error instanceof ProductionAdminAuthError && error.code === 'PRODUCTION_ADMIN_DISABLED',
  );
  assert.throws(
    () => readProductionAdminSensitiveReviewConfig(env({ CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0' })),
    error => error instanceof ProductionAdminSensitiveReviewError
      && error.code === 'PRODUCTION_ADMIN_SENSITIVE_REVIEW_DISABLED',
  );
});

test('正式登录、会话与退出使用短时HttpOnly Cookie', async () => {
  const adminStore = new MemoryStore('admin');
  const { response: loginResponse, cookie } = await login(adminStore);
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/u);
  assert.match(loginResponse.headers.get('set-cookie'), /Secure/u);
  assert.match(loginResponse.headers.get('set-cookie'), /SameSite=Strict/u);
  assert.match(loginResponse.headers.get('set-cookie'), /Path=\/api\/admin/u);
  assert.match(cookie, /^cloud_collab_admin_session=/u);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.data.username, 'xiaxue');
  assert.equal(loginBody.data.capabilities.sensitiveReview, true);
  assert.equal(loginBody.data.stablePromotionAuthorized, false);

  const sessionResponse = await handleProductionAdminSessionRequest({
    env: env(),
    request: adminRequest('/api/admin/auth/session', { cookie }),
  }, { createStore: () => adminStore, now: () => NOW + 1000 });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).data.authenticated, true);

  const logoutResponse = await handleProductionAdminLogoutRequest({
    env: env(),
    request: adminRequest('/api/admin/auth/logout', { method: 'POST', cookie }),
  }, { now: () => NOW + 2000 });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/u);
});

test('错误来源在创建管理员Store前被阻断', async () => {
  let storeCalls = 0;
  const response = await handleProductionAdminLoginRequest({
    env: env(),
    request: adminRequest('/api/admin/auth/login', {
      method: 'POST',
      origin: 'https://evil.example.invalid',
      body: { username: 'xiaxue', password: PASSWORD },
    }),
  }, { createStore() { storeCalls += 1; return new MemoryStore('unexpected'); } });
  assert.equal(response.status, 403);
  assert.equal(storeCalls, 0);
});

test('审核列表严格分离管理员Store与公共Store', async () => {
  const adminStore = new MemoryStore('admin');
  const publicStore = new MemoryStore('public');
  const { cookie } = await login(adminStore);
  const created = [];
  let listInput = null;
  const response = await handleProductionSensitiveReviewListRequest({
    env: env(),
    request: adminRequest('/api/admin/sensitive-reviews?limit=10', { cookie }),
  }, {
    createAdminStore(name) { created.push(['admin', name]); return adminStore; },
    createPublicStore(name) { created.push(['public', name]); return publicStore; },
    now: () => NOW + 3000,
    async listProduction(input) {
      listInput = input;
      return { schemaVersion: 1, items: [], nextCursor: null };
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(created, [
    ['admin', 'cloud-collab-admin-production-v1'],
    ['public', 'cloud-collab-production-v1'],
  ]);
  assert.equal(listInput.store, publicStore);
  assert.equal(listInput.limit, 10);
  const body = await response.json();
  assert.equal(body.data.administrator, 'xiaxue');
  assert.equal(body.data.capabilities.reviewMutation, true);
  assert.equal(body.data.stablePromotionAuthorized, undefined);
});

test('详情、批准、拒绝和修改后批准传递管理员身份与公共Store', async () => {
  const adminStore = new MemoryStore('admin');
  const publicStore = new MemoryStore('public');
  const { cookie } = await login(adminStore);
  const common = {
    createAdminStore: () => adminStore,
    createPublicStore: () => publicStore,
    now: () => NOW + 4000,
  };

  let detailInput = null;
  const detail = await handleProductionSensitiveReviewDetailRequest({
    env: env(), request: adminRequest('/api/admin/sensitive-reviews/detail?id=sr_v1_test', { cookie }),
  }, {
    ...common,
    async detailProduction(input) { detailInput = input; return { reviewId: input.reviewId, status: 'pending_review' }; },
  });
  assert.equal(detail.status, 200);
  assert.equal(detailInput.reviewId, 'sr_v1_test');
  assert.equal(detailInput.store, publicStore);

  for (const [handler, dependencyName, action] of [
    [handleProductionSensitiveReviewApproveRequest, 'approveProduction', 'approve'],
    [handleProductionSensitiveReviewRejectRequest, 'rejectProduction', 'reject'],
    [handleProductionSensitiveReviewEditAndApproveRequest, 'editAndApproveProduction', 'edit_and_approve'],
  ]) {
    let received = null;
    const response = await handler({
      env: env(),
      request: adminRequest(`/api/admin/sensitive-reviews/${action}`, {
        method: 'POST', cookie, body: { schemaVersion: 1, reviewId: 'sr_v1_test', confirmation: `CONFIRM_${action}` },
      }),
    }, {
      ...common,
      async [dependencyName](input) {
        received = input;
        return { reviewId: input.request.reviewId, status: action === 'reject' ? 'rejected' : 'approved' };
      },
    });
    assert.equal(response.status, 200);
    assert.equal(received.store, publicStore);
    assert.equal(received.administrator, 'xiaxue');
    const body = await response.json();
    assert.equal(body.data.manualReview, true);
    assert.equal(body.data.stablePromotionAuthorized, false);
  }
});

test('管理员认证和审核路由按显式生产总开关分发', async () => {
  const adminStore = new MemoryStore('admin');
  const productionLogin = await dispatchAdminLoginRequest({
    env: env(),
    request: adminRequest('/api/admin/auth/login', {
      method: 'POST', body: { username: 'xiaxue', password: PASSWORD },
    }),
  }, {
    production: {
      createStore: () => adminStore,
      now: () => NOW,
      randomBytes: size => Buffer.alloc(size, 8),
    },
  });
  assert.equal((await productionLogin.json()).serviceId, 'cloud-collab-admin-production');

  const invalidSession = await dispatchAdminSessionRequest({
    env: { CLOUD_PRODUCTION_ENABLED: 'invalid' },
    request: adminRequest('/api/admin/auth/session'),
  });
  assert.equal(invalidSession.status, 503);
  assert.equal((await invalidSession.json()).error.code, 'PRODUCTION_FLAG_INVALID');

  const invalidReview = await dispatchSensitiveReviewListRequest({
    env: { CLOUD_PRODUCTION_ENABLED: 'invalid' },
    request: adminRequest('/api/admin/sensitive-reviews'),
  });
  assert.equal(invalidReview.status, 503);
  assert.equal((await invalidReview.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('管理员页面能力不进入普通用户公开产物', () => {
  const ordinaryFiles = ['index.html', 'build-manifest.json', 'pages-release.json'];
  assert.equal(ordinaryFiles.some(name => /admin/u.test(name)), false);
});
