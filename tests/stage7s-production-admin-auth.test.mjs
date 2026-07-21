import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionToken,
  readAdminAuthConfig,
  verifyAdminSessionToken,
} from '../src/server/admin_auth_v1.js';
import {
  handleAdminLoginByMode,
  resolveAdminAuthMode,
} from '../src/server/admin_auth_mode_dispatch_v1.js';
import {
  PRODUCTION_ADMIN_ISSUER,
  consumeProductionAdminLoginRate,
  createProductionAdminSessionToken,
  productionAdminLoginRateKey,
  verifyProductionAdminSessionToken,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleProductionAdminLoginRequest,
  handleProductionAdminLogoutRequest,
  handleProductionAdminSessionRequest,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_610_000_000;
const ADMIN_PASSWORD = 'stage7t-admin-password-0123456789ABCDEF';
const SESSION_SECRET = 'stage7t-admin-session-secret-0123456789ABCDEF';
const ADMIN_RATE_SALT = 'stage7t-admin-rate-salt-0123456789ABCDEF';
const CLIENT_KEY = 'stage7t-client-key-0123456789ABCDEFGHIJK';
const PUBLIC_RATE_SALT = 'stage7t-public-rate-salt-0123456789ABCDE';
const ADMIN_ORIGIN = 'https://admin.example.invalid';

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
    CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
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

function previewEnv() {
  return {
    CLOUD_PRODUCTION_ENABLED: '0',
    CLOUD_ADMIN_PREVIEW_ENABLED: '1',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin-preview.test',
    CLOUD_ADMIN_USERNAME: 'preview-admin',
    CLOUD_ADMIN_PASSWORD: 'preview-admin-password-0123456789',
    CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
    CLOUD_ADMIN_RATE_LIMIT_SALT: 'preview-rate-salt-0123456789ABCDEFGH',
    CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
    CLOUD_WRITE_PREVIEW_ENABLED: '0',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  };
}

function disabledAdminEnv() {
  return env({
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
  });
}

class MemoryStore {
  constructor() { this.items = new Map(); this.getOptions = []; }
  async get(key, options = {}) {
    this.getOptions.push(options);
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
  async delete(key) { this.items.delete(key); }
}

function loginRequest({ origin = ADMIN_ORIGIN, password = ADMIN_PASSWORD, body = null } = {}) {
  return new Request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-For': '203.0.113.10',
    },
    body: body ?? JSON.stringify({ schemaVersion: 1, username: 'xiaxue', password }),
  });
}

function deterministicRandomBytes(length) {
  assert.equal(length, 16);
  return Buffer.alloc(length, 7);
}

test('正式管理员配置使用独立生产Store、来源、作用域与issuer', () => {
  const config = readProductionAdminAuthConfig(env());
  assert.equal(config.mode, 'production');
  assert.equal(config.username, 'xiaxue');
  assert.equal(config.storeName, 'cloud-collab-admin-production-v1');
  assert.equal(config.publicOrigin, ADMIN_ORIGIN);
  assert.equal(config.issuer, PRODUCTION_ADMIN_ISSUER);
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(config.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(config.stablePromotionAuthorized, false);
});

test('管理员路由由生产总开关选择，生产项目不会回退预览', async () => {
  assert.equal(resolveAdminAuthMode({}), 'preview');
  assert.equal(resolveAdminAuthMode({ CLOUD_PRODUCTION_ENABLED: '0', CLOUD_ADMIN_PRODUCTION_ENABLED: '1' }), 'preview');
  assert.equal(resolveAdminAuthMode({ CLOUD_PRODUCTION_ENABLED: '1', CLOUD_ADMIN_PRODUCTION_ENABLED: '0' }), 'production');
  assert.throws(
    () => resolveAdminAuthMode({ CLOUD_PRODUCTION_ENABLED: 'yes' }),
    error => error.code === 'PRODUCTION_FLAG_INVALID',
  );

  let previewStoreCreates = 0;
  const response = await handleAdminLoginByMode({
    env: {
      ...disabledAdminEnv(),
      CLOUD_ADMIN_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
    },
    request: loginRequest({ body: '{broken' }),
  }, {
    createStore: () => { previewStoreCreates += 1; return new MemoryStore(); },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_ADMIN_DISABLED');
  assert.equal(previewStoreCreates, 0);
});

test('正式与预览会话使用不同issuer并且不能交叉验证', () => {
  const productionConfig = readProductionAdminAuthConfig(env());
  const productionSession = createProductionAdminSessionToken({
    config: productionConfig,
    now: NOW,
    randomBytes: deterministicRandomBytes,
  });
  const productionPayload = JSON.parse(Buffer.from(productionSession.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(productionPayload.iss, 'cloud-collab-admin-production');
  assert.equal(verifyProductionAdminSessionToken(productionSession.token, productionConfig, { now: NOW }).username, 'xiaxue');

  const previewConfig = readAdminAuthConfig(previewEnv());
  assert.throws(
    () => verifyAdminSessionToken(productionSession.token, previewConfig, { now: NOW }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
  const previewSession = createAdminSessionToken({
    config: previewConfig,
    now: NOW,
    randomBytes: deterministicRandomBytes,
  });
  assert.throws(
    () => verifyProductionAdminSessionToken(previewSession.token, productionConfig, { now: NOW }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
});

test('正式登录限流使用独立前缀且只保存加盐摘要', async () => {
  const key = productionAdminLoginRateKey({
    username: 'xiaxue',
    clientAddress: '203.0.113.10',
    salt: ADMIN_RATE_SALT,
    now: NOW,
  });
  assert.match(key, /^admin-production-rate\/login\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/u);
  assert.equal(key.startsWith('admin-preview-rate/'), false);
  for (const raw of ['xiaxue', '203.0.113.10', ADMIN_RATE_SALT]) assert.equal(key.includes(raw), false);

  const store = new MemoryStore();
  await consumeProductionAdminLoginRate({ store, username: 'xiaxue', clientAddress: '203.0.113.10', salt: ADMIN_RATE_SALT, now: NOW });
  await assert.rejects(
    () => consumeProductionAdminLoginRate({ store, username: 'xiaxue', clientAddress: '203.0.113.10', salt: ADMIN_RATE_SALT, now: NOW }),
    error => error.code === 'ADMIN_LOGIN_RATE_LIMITED',
  );
  assert.ok(store.getOptions.every(options => options.consistency === 'strong'));
});

test('正式登录签发隔离HttpOnly会话且响应不暴露秘密', async () => {
  const store = new MemoryStore();
  const login = await handleProductionAdminLoginRequest({ env: env(), request: loginRequest() }, {
    createStore: name => {
      assert.equal(name, 'cloud-collab-admin-production-v1');
      return store;
    },
    now: () => NOW,
    randomBytes: deterministicRandomBytes,
  });
  assert.equal(login.status, 200);
  const text = await login.text();
  const loginBody = JSON.parse(text);
  assert.equal(loginBody.serviceId, 'cloud-collab-admin-auth-production');
  assert.equal(loginBody.mode, 'production');
  assert.equal(loginBody.data.username, 'xiaxue');
  assert.equal(loginBody.data.capabilities.productionAdmin, true);
  assert.equal(loginBody.data.capabilities.stablePromotionAuthorized, false);
  assert.equal(loginBody.data.realSecretValuesExposed, false);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^cloud_admin_session=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);
  const token = cookie.split(';')[0].split('=')[1];
  for (const secret of [ADMIN_PASSWORD, SESSION_SECRET, ADMIN_RATE_SALT, CLIENT_KEY, token]) {
    assert.equal(text.includes(secret), false);
  }

  const session = await handleProductionAdminSessionRequest({
    env: env(),
    request: new Request(`${ADMIN_ORIGIN}/api/admin/auth/session`, {
      method: 'GET',
      headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }),
  }, { now: () => NOW + 1000 });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).data.authenticated, true);
});

test('错误来源与关闭状态都在正文解析和Store创建前失败', async () => {
  let storeCreates = 0;
  const crossOrigin = await handleProductionAdminLoginRequest({
    env: env(),
    request: loginRequest({ origin: 'https://evil.example.invalid' }),
  }, {
    createStore: () => { storeCreates += 1; return new MemoryStore(); },
    now: () => NOW,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(storeCreates, 0);

  const disabled = await handleProductionAdminLoginRequest({
    env: disabledAdminEnv(),
    request: loginRequest({ body: '{broken' }),
  }, {
    createStore: () => { storeCreates += 1; return new MemoryStore(); },
  });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error.code, 'PRODUCTION_ADMIN_DISABLED');
  assert.equal(storeCreates, 0);
});

test('正式管理员关闭后仍可同源清理旧Cookie', async () => {
  const logout = await handleProductionAdminLogoutRequest({
    env: disabledAdminEnv(),
    request: new Request(`${ADMIN_ORIGIN}/api/admin/auth/logout`, {
      method: 'POST',
      headers: { Origin: ADMIN_ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
    }),
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Path=\/api\/admin/u);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
});

test('弱密钥、错误管理员Store和错误用户名均失败关闭', () => {
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_PASSWORD: 'short' })),
    error => error.code === 'PRODUCTION_SECRET_INVALID',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-preview-v1' })),
    error => error.code === 'PRODUCTION_STORE_INVALID',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(env({ CLOUD_ADMIN_USERNAME: 'other' })),
    error => error.code === 'PRODUCTION_ADMIN_USERNAME_INVALID',
  );
});

test('三个Cloud Function入口只依赖模式分发器', () => {
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
