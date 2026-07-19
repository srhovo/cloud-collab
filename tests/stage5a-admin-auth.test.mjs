import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ADMIN_AUTH_CAPABILITIES,
  ADMIN_LOGIN_RATE_SLOT_MS,
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
  AdminAuthError,
  adminLoginRateKey,
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  consumeAdminLoginRate,
  createAdminSessionCookie,
  createAdminSessionToken,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminCredentials,
  verifyAdminSessionToken,
} from '../src/server/admin_auth_v1.js';
import {
  handleAdminLoginRequest,
  handleAdminLogoutRequest,
  handleAdminSessionRequest,
} from '../src/server/admin_auth_http_v1.js';

const NOW = 1_784_410_000_000;
const USERNAME = 'admin@example.test';
const PASSWORD = 'stage5a-admin-password-0123456789';
const SESSION_SECRET = 'stage5a-session-secret-012345678901234';
const RATE_SALT = 'stage5a-rate-limit-salt-0123456789012';
const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin-preview.test',
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
});

class MemoryBlobStore {
  constructor() {
    this.items = new Map();
    this.getOptions = [];
  }

  async get(key, options = {}) {
    this.getOptions.push(options);
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }
}

function request(path, { method = 'GET', body, headers = {}, urlProtocol = 'https' } = {}) {
  return new Request(`${urlProtocol}://admin-preview.test${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' ? { Origin: 'https://admin-preview.test' } : {}),
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '203.0.113.17',
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function loginBody(overrides = {}) {
  return { schemaVersion: 1, username: USERNAME, password: PASSWORD, ...overrides };
}

function deterministicRandomBytes(size) {
  assert.equal(size, 16);
  return Buffer.alloc(size, 7);
}

function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof AdminAuthError && error.code === code);
}

test('admin config is default-off, isolated, secret-complete, and cannot overlap public preview gates', () => {
  assert.throws(() => readAdminAuthConfig({}), error => error.code === 'ADMIN_PREVIEW_DISABLED');
  for (const name of ['CLOUD_ADMIN_PASSWORD', 'CLOUD_ADMIN_SESSION_SECRET', 'CLOUD_ADMIN_RATE_LIMIT_SALT']) {
    assert.throws(() => readAdminAuthConfig({ ...ENV, [name]: '' }), error => error.status === 503, name);
  }
  assert.throws(
    () => readAdminAuthConfig({ ...ENV, CLOUD_ADMIN_SESSION_SECRET: PASSWORD }),
    error => error.code === 'ADMIN_SECRETS_MUST_BE_DISTINCT',
  );
  assert.throws(
    () => readAdminAuthConfig({ ...ENV, CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-preview-v1' }),
    error => error.code === 'ADMIN_STORE_MISCONFIGURED',
  );
  assert.throws(
    () => readAdminAuthConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_PREVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminAuthConfig({ ...ENV, CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_PREVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED',
  );
  for (const value of ['', 'http://admin-preview.test', 'https://admin-preview.test/path', 'https://user@admin-preview.test']) {
    assert.throws(
      () => readAdminAuthConfig({ ...ENV, CLOUD_ADMIN_PUBLIC_ORIGIN: value }),
      error => error.code === 'ADMIN_PUBLIC_ORIGIN_NOT_CONFIGURED',
    );
  }
  const config = readAdminAuthConfig(ENV);
  assert.equal(config.storeName, ADMIN_PREVIEW_STORE_NAME);
  assert.equal(config.sessionTtlSeconds, ADMIN_SESSION_TTL_SECONDS);
});

test('credential verification is exact and returns only a boolean', () => {
  const config = readAdminAuthConfig(ENV);
  assert.equal(verifyAdminCredentials(config, loginBody()), true);
  assert.equal(verifyAdminCredentials(config, loginBody({ username: `x${USERNAME}` })), false);
  assert.equal(verifyAdminCredentials(config, loginBody({ password: `${PASSWORD}x` })), false);
  assert.equal(verifyAdminCredentials(config, { username: {}, password: [] }), false);
});

test('15-minute HS256 session verifies strict claims and rejects tampering or expiry', () => {
  const config = readAdminAuthConfig(ENV);
  const session = createAdminSessionToken({ config, now: NOW, randomBytes: deterministicRandomBytes });
  assert.equal(session.expiresAt, NOW - (NOW % 1000) + ADMIN_SESSION_TTL_SECONDS * 1000);
  assert.equal(session.token.includes(PASSWORD), false);
  assert.equal(session.token.includes(SESSION_SECRET), false);
  const identity = verifyAdminSessionToken(session.token, config, { now: NOW });
  assert.equal(identity.username, USERNAME);
  assert.equal(identity.sessionIdSuffix.length, 4);
  const last = session.token.at(-1);
  const tampered = `${session.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  assert.throws(() => verifyAdminSessionToken(tampered, config, { now: NOW }), error => error.code === 'ADMIN_SESSION_INVALID');
  assert.throws(
    () => verifyAdminSessionToken(session.token, config, { now: session.expiresAt }),
    error => error.code === 'ADMIN_SESSION_EXPIRED',
  );
  assert.throws(
    () => verifyAdminSessionToken(session.token, { ...config, username: 'other@example.test' }, { now: NOW }),
    error => error.code === 'ADMIN_SESSION_INVALID',
  );
});

test('session cookie is HttpOnly, Secure, Strict, API-scoped, and duplicate cookies are rejected', () => {
  const config = readAdminAuthConfig(ENV);
  const { token } = createAdminSessionToken({ config, now: NOW, randomBytes: deterministicRandomBytes });
  const cookie = createAdminSessionCookie(token);
  for (const required of [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    'Path=/api/admin',
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ]) assert.ok(cookie.includes(required), required);
  assert.equal(readAdminSessionCookie(request('/api/admin/auth/session', { headers: { Cookie: cookie.split(';')[0] } })), token);
  assert.throws(
    () => readAdminSessionCookie(request('/api/admin/auth/session', { headers: { Cookie: `${cookie.split(';')[0]}; ${cookie.split(';')[0]}` } })),
    error => error.code === 'ADMIN_SESSION_MISSING',
  );
  assert.match(clearAdminSessionCookie(), /Max-Age=0/);
});

test('login rate key contains only salted hashes and the immutable slot blocks repeats', async () => {
  const key = adminLoginRateKey({
    username: USERNAME,
    clientAddress: '203.0.113.17',
    salt: RATE_SALT,
    now: NOW,
  });
  assert.match(key, /^admin-preview-rate\/login\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/);
  for (const forbidden of [USERNAME, '203.0.113.17', RATE_SALT]) assert.equal(key.includes(forbidden), false);
  const store = new MemoryBlobStore();
  await consumeAdminLoginRate({ store, username: USERNAME, clientAddress: '203.0.113.17', salt: RATE_SALT, now: NOW });
  await expectCode('ADMIN_LOGIN_RATE_LIMITED', () => consumeAdminLoginRate({
    store, username: USERNAME, clientAddress: '203.0.113.17', salt: RATE_SALT, now: NOW,
  }));
  assert.ok(store.getOptions.every(options => options.consistency === 'strong'));
  assert.equal(JSON.stringify([...store.items.entries()]).includes(USERNAME), false);
  assert.equal(JSON.stringify([...store.items.entries()]).includes('203.0.113.17'), false);
});

test('same-origin guard requires HTTPS and rejects cross-site mutation requests', () => {
  const publicOrigin = ENV.CLOUD_ADMIN_PUBLIC_ORIGIN;
  assert.equal(assertAdminSameOriginRequest(request('/api/admin/auth/login', { method: 'POST', body: loginBody() }), { requireOrigin: true, publicOrigin }), true);
  assert.equal(assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/login', {
    method: 'POST',
    headers: {
      Origin: 'https://admin-preview.test',
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-Proto': 'https',
    },
  }), { requireOrigin: true, publicOrigin }), true);
  assert.equal(assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/login', {
    method: 'POST',
    headers: {
      Origin: 'https://admin-preview.test',
      'Sec-Fetch-Site': 'same-origin',
    },
  }), { requireOrigin: true, publicOrigin }), true);
  assert.equal(assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/session', {
    headers: { 'X-Forwarded-Proto': 'quic' },
  }), { publicOrigin }), true);
  assert.equal(assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/session', {
    headers: { 'X-Forwarded-Proto': 'http' },
  }), { publicOrigin }), true);
  assert.throws(
    () => assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/session')),
    error => error.code === 'ADMIN_HTTPS_REQUIRED',
  );
  assert.throws(
    () => assertAdminSameOriginRequest(new Request('http://other-preview.test/api/admin/auth/session'), { publicOrigin }),
    error => error.code === 'ADMIN_HTTPS_REQUIRED',
  );
  assert.throws(
    () => assertAdminSameOriginRequest(new Request('http://admin-preview.test/api/admin/auth/login', {
      method: 'POST',
      headers: { Origin: 'http://admin-preview.test', 'Sec-Fetch-Site': 'same-origin' },
    }), { requireOrigin: true, publicOrigin }),
    error => error.code === 'ADMIN_REQUEST_ORIGIN_INVALID',
  );
  assert.throws(
    () => assertAdminSameOriginRequest(request('/api/admin/auth/login', {
      method: 'POST', body: loginBody(), headers: { Origin: 'https://attacker.test' },
    }), { requireOrigin: true, publicOrigin }),
    error => error.code === 'ADMIN_REQUEST_ORIGIN_INVALID',
  );
});

test('EdgeOne rotating deployment hosts remain locked to one project prefix', () => {
  const publicOrigin = 'https://cloud-collab-stage5a-acceptance-temp-dpuu5szgt09q.edgeone.cool';
  const currentOrigin = 'https://cloud-collab-stage5a-acceptance-temp-dprvtgvseh0h.edgeone.cool';
  assert.equal(assertAdminSameOriginRequest(new Request(
    'http://cloud-collab-stage5a-acceptance-temp-dprvtgvseh0h.edgeone.cool/api/admin/auth/session',
  ), { publicOrigin }), true);
  assert.equal(assertAdminSameOriginRequest(new Request(
    'http://cloud-collab-stage5a-acceptance-temp-dprvtgvseh0h.edgeone.cool/api/admin/auth/login',
    {
      method: 'POST',
      headers: { Origin: currentOrigin, 'Sec-Fetch-Site': 'same-origin' },
    },
  ), { requireOrigin: true, publicOrigin }), true);
  for (const url of [
    'http://other-stage5a-temp-dprvtgvseh0h.edgeone.cool/api/admin/auth/session',
    'http://cloud-collab-stage5a-acceptance-temp-short.edgeone.cool/api/admin/auth/session',
    'http://cloud-collab-stage5a-acceptance-temp-dprvtgvseh0h.edgeone.cool.attacker.test/api/admin/auth/session',
  ]) {
    assert.throws(
      () => assertAdminSameOriginRequest(new Request(url), { publicOrigin }),
      error => error.code === 'ADMIN_HTTPS_REQUIRED',
    );
  }
  assert.throws(
    () => assertAdminSameOriginRequest(new Request(
      'http://cloud-collab-stage5a-acceptance-temp-dprvtgvseh0h.edgeone.cool/api/admin/auth/login',
      {
        method: 'POST',
        headers: { Origin: publicOrigin, 'Sec-Fetch-Site': 'same-origin' },
      },
    ), { requireOrigin: true, publicOrigin }),
    error => error.code === 'ADMIN_REQUEST_ORIGIN_INVALID',
  );
});

test('disabled login fails before body parsing and Blob initialization', async () => {
  let stores = 0;
  const response = await handleAdminLoginRequest({
    request: request('/api/admin/auth/login', { method: 'POST', body: '{broken' }),
    env: { ...ENV, CLOUD_ADMIN_PREVIEW_ENABLED: '0' },
  }, { createStore: () => { stores += 1; return new MemoryBlobStore(); } });
  assert.equal(response.status, 503);
  assert.equal(stores, 0);
  assert.equal((await response.json()).error.code, 'ADMIN_PREVIEW_DISABLED');
});

test('successful login returns no secret or token and establishes a strict cookie', async () => {
  const store = new MemoryBlobStore();
  const response = await handleAdminLoginRequest({
    request: request('/api/admin/auth/login', {
      method: 'POST',
      body: loginBody(),
      urlProtocol: 'http',
      headers: { 'X-Forwarded-Proto': 'http' },
    }),
    env: ENV,
  }, {
    createStore: env => {
      assert.equal(env.CLOUD_BLOB_STORE_NAME, ADMIN_PREVIEW_STORE_NAME);
      return store;
    },
    now: () => NOW,
    randomBytes: deterministicRandomBytes,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.equal(payload.data.authenticated, true);
  assert.deepEqual(payload.data.capabilities, ADMIN_AUTH_CAPABILITIES);
  for (const forbidden of [PASSWORD, SESSION_SECRET, RATE_SALT, cookie.split('=')[1].split(';')[0]]) {
    assert.equal(text.includes(forbidden), false);
  }
});

test('invalid credentials are generic, rate-limited, and clear any stale session', async () => {
  const store = new MemoryBlobStore();
  const context = {
    request: request('/api/admin/auth/login', { method: 'POST', body: loginBody({ password: 'wrong-password-value' }) }),
    env: ENV,
  };
  const dependencies = { createStore: () => store, now: () => NOW };
  const first = await handleAdminLoginRequest(context, dependencies);
  assert.equal(first.status, 401);
  const firstText = await first.text();
  assert.match(firstText, /ADMIN_CREDENTIALS_INVALID/);
  assert.equal(firstText.includes(USERNAME), false);
  assert.equal(firstText.includes('wrong-password-value'), false);
  assert.match(first.headers.get('set-cookie'), /Max-Age=0/);

  const second = await handleAdminLoginRequest({
    request: request('/api/admin/auth/login', { method: 'POST', body: loginBody({ password: 'another-wrong-value' }) }),
    env: ENV,
  }, dependencies);
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
});

test('session endpoint verifies cookie and clears tampered sessions', async () => {
  const config = readAdminAuthConfig(ENV);
  const { token } = createAdminSessionToken({ config, now: NOW, randomBytes: deterministicRandomBytes });
  const valid = await handleAdminSessionRequest({
    request: request('/api/admin/auth/session', { headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` } }),
    env: ENV,
  }, { now: () => NOW });
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).data.capabilities, ADMIN_AUTH_CAPABILITIES);

  const invalid = await handleAdminSessionRequest({
    request: request('/api/admin/auth/session', { headers: { Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}x` } }),
    env: ENV,
  }, { now: () => NOW });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('set-cookie'), /Max-Age=0/);
});

test('logout is same-origin, stateless, and clears the API-scoped cookie even when preview is disabled', async () => {
  const response = await handleAdminLogoutRequest({
    request: request('/api/admin/auth/logout', { method: 'POST' }),
    env: { CLOUD_ADMIN_PREVIEW_ENABLED: '0', CLOUD_ADMIN_PUBLIC_ORIGIN: ENV.CLOUD_ADMIN_PUBLIC_ORIGIN },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Path=\/api\/admin/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const crossSite = await handleAdminLogoutRequest({
    request: request('/api/admin/auth/logout', { method: 'POST', headers: { Origin: 'https://attacker.test' } }),
    env: { CLOUD_ADMIN_PUBLIC_ORIGIN: ENV.CLOUD_ADMIN_PUBLIC_ORIGIN },
  });
  assert.equal(crossSite.status, 403);
});

test('login body is strict, bounded, JSON-only, and methods advertise exact Allow values', async () => {
  const dependencies = { createStore: () => new MemoryBlobStore(), now: () => NOW };
  const extra = await handleAdminLoginRequest({
    request: request('/api/admin/auth/login', { method: 'POST', body: { ...loginBody(), extra: true } }), env: ENV,
  }, dependencies);
  assert.equal(extra.status, 400);
  const invalidType = await handleAdminLoginRequest({
    request: request('/api/admin/auth/login', {
      method: 'POST', body: JSON.stringify(loginBody()), headers: { 'Content-Type': 'text/plain' },
    }), env: ENV,
  }, dependencies);
  assert.equal(invalidType.status, 415);
  const wrongMethod = await handleAdminSessionRequest({ request: request('/api/admin/auth/session', { method: 'POST' }), env: ENV });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
});

test('admin preview page is isolated from the user client and never persists credentials', () => {
  const page = fs.readFileSync('dist/admin-preview.html', 'utf8');
  const userSource = fs.readFileSync('src/码单器8.2.26_公共协作本地候选版.html', 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(page, /阶段5A/);
  assert.match(page, /reviewQueueRead/);
  assert.match(page, /HttpOnly、Secure、SameSite=Strict/);
  assert.match(page, /\/api\/admin\/auth\/login/);
  assert.match(page, /\/api\/admin\/auth\/session/);
  assert.match(page, /\/api\/admin\/auth\/logout/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(page, /CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT)\s*=/);
  assert.doesNotMatch(page, /\/api\/(?:submissions|preview|public-)/);
  assert.doesNotMatch(userSource, /admin-preview|\/api\/admin/);
});

test('environment template leaves admin preview off and every real credential empty', () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.match(env, /^CLOUD_ADMIN_PREVIEW_ENABLED=0$/m);
  assert.match(env, /^CLOUD_ADMIN_PUBLIC_ORIGIN=$/m);
  assert.match(env, /^CLOUD_ADMIN_USERNAME=$/m);
  assert.match(env, /^CLOUD_ADMIN_PASSWORD=$/m);
  assert.match(env, /^CLOUD_ADMIN_SESSION_SECRET=$/m);
  assert.match(env, /^CLOUD_ADMIN_RATE_LIMIT_SALT=$/m);
  assert.match(env, /^CLOUD_ADMIN_BLOB_STORE_NAME=cloud-collab-admin-preview-v1$/m);
  assert.match(env, /^CLOUD_WRITE_PREVIEW_ENABLED=0$/m);
  assert.match(env, /^CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0$/m);
});

test('admin Cloud Function routes are separate, importable, and invoke only the stage5A auth handlers', async () => {
  const routes = {
    login: fs.readFileSync('cloud-functions/api/admin/auth/login.js', 'utf8'),
    session: fs.readFileSync('cloud-functions/api/admin/auth/session.js', 'utf8'),
    logout: fs.readFileSync('cloud-functions/api/admin/auth/logout.js', 'utf8'),
  };
  assert.match(routes.login, /handleAdminLoginRequest/);
  assert.match(routes.session, /handleAdminSessionRequest/);
  assert.match(routes.logout, /handleAdminLogoutRequest/);
  for (const source of Object.values(routes)) {
    assert.doesNotMatch(source, /handle[A-Za-z]*(?:AutoApproval|Review|Rollback|Export|Submission)/);
  }
  const modules = await Promise.all([
    import('../cloud-functions/api/admin/auth/login.js'),
    import('../cloud-functions/api/admin/auth/session.js'),
    import('../cloud-functions/api/admin/auth/logout.js'),
  ]);
  assert.ok(modules.every(module => typeof module.default === 'function'));
  assert.equal(ADMIN_LOGIN_RATE_SLOT_MS, 10_000);
});
