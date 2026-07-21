import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_AUTH_CAPABILITIES,
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  AdminAuthError,
  createAdminSessionToken,
  readAdminAuthConfig,
  verifyAdminSessionToken,
} from '../src/server/admin_auth_v1.js';
import {
  dispatchAdminLoginRequest,
  dispatchAdminLogoutRequest,
  dispatchAdminSessionRequest,
} from '../src/server/admin_auth_mode_dispatch_v1.js';
import {
  PRODUCTION_ADMIN_ISSUER,
  consumeProductionAdminLoginRate,
  createProductionAdminSessionToken,
  productionAdminLoginRateKey,
  readProductionAdminAuthConfig,
  verifyProductionAdminSessionToken,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleProductionAdminLoginRequest,
  handleProductionAdminLogoutRequest,
  handleProductionAdminSessionRequest,
} from '../src/server/production_admin_auth_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_610_000_000;
const PASSWORD = 'stage7t-admin-password-0123456789abcdef';
const CLIENT_KEY = 'stage7t-client-access-key-0123456789abcdef';
const CLIENT_RATE_SALT = 'stage7t-client-rate-salt-0123456789abcdef';
const SESSION_SECRET = 'stage7t-admin-session-secret-0123456789abcdef';
const ADMIN_RATE_SALT = 'stage7t-admin-rate-salt-0123456789abcdef';
const ADMIN_ORIGIN = 'https://admin.example.invalid';

function productionEnv(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
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
    CLOUD_ADMIN_PASSWORD: PASSWORD,
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: CLIENT_KEY,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: CLIENT_RATE_SALT,
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
    CLOUD_ADMIN_RATE_LIMIT_SALT: 'preview-admin-rate-limit-salt-0123456789',
    CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
    CLOUD_WRITE_PREVIEW_ENABLED: '0',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  };
}

class MemoryStore {
  constructor() { this.items = new Map(); this.reads = []; }
  async get(key, options = {}) {
    this.reads.push({ key, options });
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
}

function random16(size) { assert.equal(size, 16); return Buffer.alloc(size, 9); }
function body(username = 'xiaxue', password = PASSWORD) { return { schemaVersion: 1, username, password }; }
function request(origin, pathName, { method = 'GET', payload, headers = {} } = {}) {
  return new Request(`${origin}${pathName}`, {
    method,
    headers: {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' ? { Origin: origin } : {}),
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '203.0.113.27',
      ...headers,
    },
    body: payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
}

function disabledEnv() {
  return productionEnv({
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
  });
}

test('正式管理员配置固定用户名、独立Store和生产issuer', () => {
  const config = readProductionAdminAuthConfig(productionEnv());
  assert.equal(config.username, 'xiaxue');
  assert.equal(config.storeName, 'cloud-collab-admin-production-v1');
  assert.equal(config.issuer, PRODUCTION_ADMIN_ISSUER);
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.equal(config.stablePromotionAuthorized, false);
  assert.throws(() => readProductionAdminAuthConfig(disabledEnv()), e => e.code === 'PRODUCTION_ADMIN_AUTH_DISABLED');
  assert.throws(() => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_USERNAME: 'other' })), e => e.code === 'PRODUCTION_ADMIN_USERNAME_INVALID');
  assert.throws(() => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_SESSION_SECRET: PASSWORD })), e => e.code === 'PRODUCTION_SECRETS_MUST_BE_DISTINCT');
});

test('正式与预览会话即使共享测试密钥也不能互相验证', () => {
  const production = readProductionAdminAuthConfig(productionEnv());
  const prodToken = createProductionAdminSessionToken({ config: production, now: NOW, randomBytes: random16 }).token;
  assert.equal(verifyProductionAdminSessionToken(prodToken, production, { now: NOW }).username, 'xiaxue');
  const preview = readAdminAuthConfig(previewEnv());
  assert.throws(() => verifyAdminSessionToken(prodToken, preview, { now: NOW }), e => e.code === 'ADMIN_SESSION_INVALID');
  const previewToken = createAdminSessionToken({ config: preview, now: NOW, randomBytes: random16 }).token;
  assert.throws(() => verifyProductionAdminSessionToken(previewToken, production, { now: NOW }), e => e.code === 'ADMIN_SESSION_INVALID');
});

test('正式限流Key只含加盐摘要且同槽重复失败', async () => {
  const key = productionAdminLoginRateKey({ username: 'xiaxue', clientAddress: '203.0.113.27', salt: ADMIN_RATE_SALT, now: NOW });
  assert.match(key, /^admin-production-rate\/login\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/u);
  for (const raw of ['xiaxue', '203.0.113.27', ADMIN_RATE_SALT]) assert.equal(key.includes(raw), false);
  const store = new MemoryStore();
  await consumeProductionAdminLoginRate({ store, username: 'xiaxue', clientAddress: '203.0.113.27', salt: ADMIN_RATE_SALT, now: NOW });
  await assert.rejects(
    () => consumeProductionAdminLoginRate({ store, username: 'xiaxue', clientAddress: '203.0.113.27', salt: ADMIN_RATE_SALT, now: NOW }),
    e => e instanceof AdminAuthError && e.code === 'ADMIN_LOGIN_RATE_LIMITED',
  );
});

test('正式登录、会话和退出形成无明文泄漏Cookie闭环', async () => {
  const store = new MemoryStore();
  let name = null;
  const login = await handleProductionAdminLoginRequest({
    env: productionEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', payload: body() }),
  }, { createStore: value => { name = value; return store; }, now: () => NOW, randomBytes: random16 });
  assert.equal(login.status, 200);
  assert.equal(name, 'cloud-collab-admin-production-v1');
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Strict/u);
  const text = await login.text();
  const parsed = JSON.parse(text);
  assert.equal(parsed.serviceId, 'cloud-collab-admin-auth-production');
  assert.deepEqual(parsed.data.capabilities, ADMIN_AUTH_CAPABILITIES);
  assert.equal(parsed.data.realSecretValuesExposed, false);
  const token = cookie.split(';')[0].split('=')[1];
  for (const secret of [PASSWORD, SESSION_SECRET, ADMIN_RATE_SALT, CLIENT_KEY, token]) assert.equal(text.includes(secret), false);

  const session = await handleProductionAdminSessionRequest({
    env: productionEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/session', { headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` } }),
  }, { now: () => NOW });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).data.username, 'xiaxue');

  const logout = await handleProductionAdminLogoutRequest({
    env: disabledEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/logout', { method: 'POST' }),
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
});

test('正式管理员关闭时在解析正文和创建Store前阻断', async () => {
  let stores = 0;
  const response = await handleProductionAdminLoginRequest({
    env: disabledEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', payload: '{broken' }),
  }, { createStore: () => { stores += 1; return new MemoryStore(); } });
  assert.equal(response.status, 503);
  assert.equal(stores, 0);
  assert.equal((await response.json()).error.code, 'PRODUCTION_ADMIN_AUTH_DISABLED');
});

test('共享分发器以生产总开关为准且生产模式不回退预览', async () => {
  const prod = await dispatchAdminLoginRequest({
    env: productionEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', payload: body() }),
  }, { production: { createStore: () => new MemoryStore(), now: () => NOW, randomBytes: random16 } });
  assert.equal((await prod.json()).serviceId, 'cloud-collab-admin-auth-production');

  let previewCalls = 0;
  const blocked = await dispatchAdminLoginRequest({
    env: { ...disabledEnv(), CLOUD_ADMIN_PREVIEW_ENABLED: '1', CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME },
    request: request(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', payload: '{broken' }),
  }, { preview: { createStore: () => { previewCalls += 1; return new MemoryStore(); } } });
  assert.equal(blocked.status, 503);
  assert.equal(previewCalls, 0);

  const preview = await dispatchAdminLoginRequest({
    env: previewEnv(),
    request: request('https://admin-preview.test', '/api/admin/auth/login', {
      method: 'POST', payload: body('preview-admin', 'preview-admin-password-0123456789'),
    }),
  }, { preview: { createStore: () => new MemoryStore(), now: () => NOW, randomBytes: random16 } });
  assert.equal((await preview.json()).serviceId, 'cloud-collab-admin-auth-preview');

  const invalid = await dispatchAdminLoginRequest({
    env: { CLOUD_PRODUCTION_ENABLED: 'maybe' },
    request: request(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', payload: '{broken' }),
  });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('共享会话、退出和Cloud Function路由均使用分发器', async () => {
  const config = readProductionAdminAuthConfig(productionEnv());
  const token = createProductionAdminSessionToken({ config, now: NOW, randomBytes: random16 }).token;
  const session = await dispatchAdminSessionRequest({
    env: productionEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/session', { headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` } }),
  }, { production: { now: () => NOW } });
  assert.equal(session.status, 200);
  const logout = await dispatchAdminLogoutRequest({
    env: productionEnv(),
    request: request(ADMIN_ORIGIN, '/api/admin/auth/logout', { method: 'POST' }),
  });
  assert.equal(logout.status, 204);

  for (const [relative, name] of [
    ['cloud-functions/api/admin/auth/login.js', 'dispatchAdminLoginRequest'],
    ['cloud-functions/api/admin/auth/session.js', 'dispatchAdminSessionRequest'],
    ['cloud-functions/api/admin/auth/logout.js', 'dispatchAdminLogoutRequest'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, new RegExp(name, 'u'));
    assert.doesNotMatch(source, /production_admin_auth_http_v1|admin_auth_http_v1/u);
  }
});
