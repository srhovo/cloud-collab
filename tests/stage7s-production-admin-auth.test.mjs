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
  PRODUCTION_ADMIN_LOGIN_RATE_PREFIX,
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
const PASSWORD = 'stage7s-admin-password-0123456789abcdef';
const CLIENT_KEY = 'stage7s-client-access-key-0123456789abcdef';
const CLIENT_RATE_SALT = 'stage7s-client-rate-salt-0123456789abcdef';
const SESSION_SECRET = 'stage7s-admin-session-secret-0123456789abcdef';
const ADMIN_RATE_SALT = 'stage7s-admin-rate-salt-0123456789abcdef';
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

function previewEnv(overrides = {}) {
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
    ...overrides,
  };
}

class MemoryBlobStore {
  constructor() {
    this.items = new Map();
    this.reads = [];
    this.writes = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.items.has(key) ? this.clone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, this.clone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }
}

function deterministicRandomBytes(size) {
  assert.equal(size, 16);
  return Buffer.alloc(size, 9);
}

function adminRequest(origin, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Request(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' ? { Origin: origin } : {}),
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '203.0.113.27',
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function loginBody(username = 'xiaxue', password = PASSWORD) {
  return { schemaVersion: 1, username, password };
}

function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof AdminAuthError && error.code === code);
}

test('正式管理员配置复用生产门禁并固定独立管理员Store', () => {
  assert.throws(
    () => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_PRODUCTION_ENABLED: '0' })),
    error => error.code === 'PRODUCTION_ADMIN_AUTH_DISABLED',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_USERNAME: 'other' })),
    error => error.code === 'PRODUCTION_ADMIN_USERNAME_INVALID',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_SESSION_SECRET: PASSWORD })),
    error => error.code === 'PRODUCTION_SECRETS_MUST_BE_DISTINCT',
  );
  assert.throws(
    () => readProductionAdminAuthConfig(productionEnv({ CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1' })),
    error => error.code === 'PRODUCTION_STORE_INVALID',
  );
  const config = readProductionAdminAuthConfig(productionEnv());
  assert.equal(config.mode, 'production');
  assert.equal(config.username, 'xiaxue');
  assert.equal(config.storeName, 'cloud-collab-admin-production-v1');
  assert.equal(config.publicOrigin, ADMIN_ORIGIN);
  assert.equal(config.issuer, PRODUCTION_ADMIN_ISSUER);
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(config.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(config.stablePromotionAuthorized, false);
});

test('正式会话使用生产issuer并与预览会话域隔离', () => {
  const config = readProductionAdminAuthConfig(productionEnv());
  const session = createProductionAdminSessionToken({ config, now: NOW, randomBytes: deterministicRandomBytes });
  const payload = JSON.parse(Buffer.from(session.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, PRODUCTION_ADMIN_ISSUER);
  assert.equal(payload.aud, PRODUCTION_ADMIN_ISSUER);
  const identity = verifyProductionAdminSessionToken(session.token, config, { now: NOW });
  assert.equal(identity.username, 'xiaxue');
  assert.equal(session.token.includes(PASSWORD), false);
  assert.equal(session.token.includes(SESSION_SECRET), false);

  const previewConfig = readAdminAuthConfig(previewEnv());
  assert.throws(
    () => verifyAdminSessionToken(session.token, previewConfig, { now: NOW }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
  const previewSession = createAdminSessionToken({
    config: previewConfig,
    now: NOW,
    randomBytes: deterministicRandomBytes,
  });
  assert.throws(
    () => verifyProductionAdminSessionToken(previewSession.token, config, { now: NOW }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
});

test('正式管理员限流Key只含加盐摘要且不可与预览前缀混用', async () => {
  const key = productionAdminLoginRateKey({
    username: 'xiaxue',
    clientAddress: '203.0.113.27',
    salt: ADMIN_RATE_SALT,
    now: NOW,
  });
  assert.match(key, /^admin-production-rate\/login\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/u);
  assert.ok(key.startsWith(`${PRODUCTION_ADMIN_LOGIN_RATE_PREFIX}/`));
  assert.equal(key.includes('xiaxue'), false);
  assert.equal(key.includes('203.0.113.27'), false);
  assert.equal(key.includes(ADMIN_RATE_SALT), false);
  assert.equal(key.startsWith('admin-preview-rate/'), false);

  const store = new MemoryBlobStore();
  await consumeProductionAdminLoginRate({
    store,
    username: 'xiaxue',
    clientAddress: '203.0.113.27',
    salt: ADMIN_RATE_SALT,
    now: NOW,
  });
  await expectCode('ADMIN_LOGIN_RATE_LIMITED', () => consumeProductionAdminLoginRate({
    store,
    username: 'xiaxue',
    clientAddress: '203.0.113.27',
    salt: ADMIN_RATE_SALT,
    now: NOW,
  }));
  assert.ok(store.reads.every(item => item.options.consistency === 'strong'));
});

test('正式登录、会话和退出形成无明文泄漏的同源Cookie闭环', async () => {
  const store = new MemoryBlobStore();
  let storeName = null;
  const login = await handleProductionAdminLoginRequest({
    env: productionEnv(),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/login', {
      method: 'POST',
      body: loginBody(),
    }),
  }, {
    createStore(name) {
      storeName = name;
      return store;
    },
    now: () => NOW,
    randomBytes: deterministicRandomBytes,
  });
  assert.equal(login.status, 200);
  assert.equal(storeName, 'cloud-collab-admin-production-v1');
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);
  assert.match(cookie, /Path=\/api\/admin/u);
  const loginText = await login.text();
  const loginPayload = JSON.parse(loginText);
  assert.equal(loginPayload.serviceId, 'cloud-collab-admin-auth-production');
  assert.equal(loginPayload.mode, 'production');
  assert.equal(loginPayload.data.authenticated, true);
  assert.deepEqual(loginPayload.data.capabilities, ADMIN_AUTH_CAPABILITIES);
  assert.equal(loginPayload.data.realSecretValuesExposed, false);
  assert.equal(loginPayload.data.stablePromotionAuthorized, false);
  const token = cookie.split(';')[0].split('=')[1];
  for (const forbidden of [PASSWORD, SESSION_SECRET, ADMIN_RATE_SALT, CLIENT_KEY, token]) {
    assert.equal(loginText.includes(forbidden), false);
  }

  const session = await handleProductionAdminSessionRequest({
    env: productionEnv(),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/session', {
      headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` },
    }),
  }, { now: () => NOW });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).data.username, 'xiaxue');

  const logout = await handleProductionAdminLogoutRequest({
    env: productionEnv({
      CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
      CLOUD_ADMIN_PASSWORD: '',
      CLOUD_ADMIN_SESSION_SECRET: '',
      CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    }),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/logout', { method: 'POST' }),
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
});

test('正式管理员关闭时在正文解析和Store创建前失败关闭', async () => {
  let storeCalls = 0;
  const response = await handleProductionAdminLoginRequest({
    env: productionEnv({
      CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
      CLOUD_ADMIN_PASSWORD: '',
      CLOUD_ADMIN_SESSION_SECRET: '',
      CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    }),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/login', {
      method: 'POST',
      body: '{broken',
    }),
  }, {
    createStore() {
      storeCalls += 1;
      return new MemoryBlobStore();
    },
  });
  assert.equal(response.status, 503);
  assert.equal(storeCalls, 0);
  assert.equal((await response.json()).error.code, 'PRODUCTION_ADMIN_AUTH_DISABLED');
});

test('管理员共享路由按生产总开关分发且生产模式绝不回退预览', async () => {
  const prodStore = new MemoryBlobStore();
  const prod = await dispatchAdminLoginRequest({
    env: productionEnv(),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', body: loginBody() }),
  }, {
    production: {
      createStore: () => prodStore,
      now: () => NOW,
      randomBytes: deterministicRandomBytes,
    },
  });
  assert.equal((await prod.json()).serviceId, 'cloud-collab-admin-auth-production');

  let previewStoreCalls = 0;
  const noFallback = await dispatchAdminLoginRequest({
    env: {
      ...productionEnv({
        CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
        CLOUD_ADMIN_PASSWORD: '',
        CLOUD_ADMIN_SESSION_SECRET: '',
        CLOUD_ADMIN_RATE_LIMIT_SALT: '',
      }),
      CLOUD_ADMIN_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
    },
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', body: '{broken' }),
  }, {
    preview: {
      createStore() {
        previewStoreCalls += 1;
        return new MemoryBlobStore();
      },
    },
  });
  assert.equal(noFallback.status, 503);
  assert.equal((await noFallback.json()).error.code, 'PRODUCTION_ADMIN_AUTH_DISABLED');
  assert.equal(previewStoreCalls, 0);

  const previewStore = new MemoryBlobStore();
  const preview = await dispatchAdminLoginRequest({
    env: previewEnv(),
    request: adminRequest('https://admin-preview.test', '/api/admin/auth/login', {
      method: 'POST',
      body: loginBody('preview-admin', 'preview-admin-password-0123456789'),
    }),
  }, {
    preview: {
      createStore: () => previewStore,
      now: () => NOW,
      randomBytes: deterministicRandomBytes,
    },
  });
  assert.equal((await preview.json()).serviceId, 'cloud-collab-admin-auth-preview');

  const invalid = await dispatchAdminLoginRequest({
    env: { CLOUD_PRODUCTION_ENABLED: 'maybe' },
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/login', { method: 'POST', body: '{broken' }),
  });
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, 'PRODUCTION_FLAG_INVALID');
});

test('共享会话与退出路由同样使用生产预览分发器', async () => {
  const config = readProductionAdminAuthConfig(productionEnv());
  const { token } = createProductionAdminSessionToken({ config, now: NOW, randomBytes: deterministicRandomBytes });
  const session = await dispatchAdminSessionRequest({
    env: productionEnv(),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/session', {
      headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` },
    }),
  }, { production: { now: () => NOW } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).mode, 'production');

  const logout = await dispatchAdminLogoutRequest({
    env: productionEnv(),
    request: adminRequest(ADMIN_ORIGIN, '/api/admin/auth/logout', { method: 'POST' }),
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
});

test('Cloud Function管理员身份路由仅调用模式分发器', () => {
  const files = [
    ['cloud-functions/api/admin/auth/login.js', 'dispatchAdminLoginRequest'],
    ['cloud-functions/api/admin/auth/session.js', 'dispatchAdminSessionRequest'],
    ['cloud-functions/api/admin/auth/logout.js', 'dispatchAdminLogoutRequest'],
  ];
  for (const [relative, dispatcher] of files) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, new RegExp(dispatcher, 'u'));
    assert.doesNotMatch(source, /admin_auth_http_v1/u);
    assert.doesNotMatch(source, /production_admin_auth_http_v1/u);
  }
});
