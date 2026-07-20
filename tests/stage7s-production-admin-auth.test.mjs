import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  handleProductionAdminLoginRequest,
  handleProductionAdminSessionRequest,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_http_v1.js';
import { resolveAdminAuthMode } from '../src/server/admin_auth_mode_dispatch_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_610_000_000;
const ADMIN_PASSWORD = 'stage7s-admin-password-0123456789ABCDEF';
const SESSION_SECRET = 'stage7s-admin-session-secret-0123456789ABCDEF';
const ADMIN_RATE_SALT = 'stage7s-admin-rate-salt-0123456789ABCDEF';
const CLIENT_KEY = 'stage7s-client-key-0123456789ABCDEFGHIJK';
const PUBLIC_RATE_SALT = 'stage7s-public-rate-salt-0123456789ABCDE';

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
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
    CLOUD_ADMIN_PASSWORD: ADMIN_PASSWORD,
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: CLIENT_KEY,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: PUBLIC_RATE_SALT,
    CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
    CLOUD_ADMIN_RATE_LIMIT_SALT: ADMIN_RATE_SALT,
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

class MemoryStore {
  constructor() { this.items = new Map(); }
  async get(key) {
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('exists');
      error.code = 'BLOB_ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, structuredClone(value));
  }
  async delete(key) {
    this.items.delete(key);
  }
}

function loginRequest({ origin = 'https://admin.example.invalid', password = ADMIN_PASSWORD } = {}) {
  return new Request('https://admin.example.invalid/api/admin/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-For': '203.0.113.10',
    },
    body: JSON.stringify({ schemaVersion: 1, username: 'xiaxue', password }),
  });
}

test('正式管理员配置使用独立生产Store、来源与密钥', () => {
  const config = readProductionAdminAuthConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.username, 'xiaxue');
  assert.equal(config.storeName, 'cloud-collab-admin-production-v1');
  assert.equal(config.publicOrigin, 'https://admin.example.invalid');
  assert.equal(config.password, ADMIN_PASSWORD);
  assert.equal(config.sessionSecret, SESSION_SECRET);
  assert.equal(config.rateLimitSalt, ADMIN_RATE_SALT);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('模式分发默认保持预览，只有显式1进入生产', () => {
  assert.equal(resolveAdminAuthMode({}), 'preview');
  assert.equal(resolveAdminAuthMode({ CLOUD_ADMIN_PRODUCTION_ENABLED: '0' }), 'preview');
  assert.equal(resolveAdminAuthMode({ CLOUD_ADMIN_PRODUCTION_ENABLED: '1' }), 'production');
  assert.throws(
    () => resolveAdminAuthMode({ CLOUD_ADMIN_PRODUCTION_ENABLED: 'yes' }),
    error => error.code === 'ADMIN_AUTH_MODE_INVALID',
  );
});

test('正式登录签发HttpOnly会话且会话端点可以验证', async () => {
  const store = new MemoryStore();
  const login = await handleProductionAdminLoginRequest({ env: env(), request: loginRequest() }, {
    createStore: name => {
      assert.equal(name, 'cloud-collab-admin-production-v1');
      return store;
    },
    now: () => NOW,
    randomBytes: length => Buffer.alloc(length, 7),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.ok, true);
  assert.equal(loginBody.serviceId, 'cloud-collab-admin-auth-production');
  assert.equal(loginBody.data.username, 'xiaxue');
  assert.equal(loginBody.data.capabilities.productionAdmin, true);
  assert.equal(loginBody.data.capabilities.stablePromotionAuthorized, false);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^cloud_admin_session=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);

  const session = await handleProductionAdminSessionRequest({
    env: env(),
    request: new Request('https://admin.example.invalid/api/admin/auth/session', {
      method: 'GET',
      headers: { Cookie: cookie.split(';')[0], 'Sec-Fetch-Site': 'same-origin' },
    }),
  }, { now: () => NOW + 1000 });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.data.authenticated, true);
  assert.equal(sessionBody.data.username, 'xiaxue');
});

test('错误来源在创建管理员Blob Store之前失败', async () => {
  let storeCreates = 0;
  const response = await handleProductionAdminLoginRequest({
    env: env(),
    request: loginRequest({ origin: 'https://evil.example.invalid' }),
  }, {
    createStore: () => { storeCreates += 1; return new MemoryStore(); },
    now: () => NOW,
  });
  assert.equal(response.status, 403);
  assert.equal(storeCreates, 0);
});

test('弱密钥、错误管理员Store和未开启生产管理员均失败关闭', () => {
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_PASSWORD: 'short' })),
    error => error.code === 'PRODUCTION_SECRET_INVALID',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-preview-v1' })),
    error => error.code === 'PRODUCTION_STORE_INVALID',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_PRODUCTION_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_ADMIN_DISABLED',
  );
});

test('三个Cloud Function入口保留阶段5A名称并只依赖模式分发器', () => {
  for (const [name, handler] of [
    ['login.js', 'handleAdminLoginRequest'],
    ['session.js', 'handleAdminSessionRequest'],
    ['logout.js', 'handleAdminLogoutRequest'],
  ]) {
    const source = fs.readFileSync(path.join(root, 'cloud-functions/api/admin/auth', name), 'utf8');
    assert.match(source, new RegExp(handler, 'u'));
    assert.match(source, /admin_auth_mode_dispatch_v1/u);
    assert.doesNotMatch(source, /production_admin_auth_http_v1|admin_auth_http_v1/u);
  }
});
