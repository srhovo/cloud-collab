import test from 'node:test';
import assert from 'node:assert/strict';
import registerHandler from '../edge-functions/api/device/register.js';
import {
  DEVICE_REGISTRATION_LIMITS,
  DeviceRegistrationError,
  assertRegisterRequestBytes,
  authenticateDeviceToken,
  deviceStorageKey,
  issueDeviceToken,
  normalizeRegisterRequest,
  registerDevice,
  verifyDeviceToken,
} from '../edge-functions/api/_shared/device-registration.js';

const SECRET = 'stage4b-test-secret-0123456789abcdef';
const NOW = 1784376000000;
const DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD';
const REGISTER_REQUEST = Object.freeze({
  schemaVersion: 1,
  deviceId: DEVICE_ID,
  nickname: ' 小雪 ',
  clientContext: { appVersion: '8.2.28', protocolVersion: 1 },
});

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function expectCode(code, fn) {
  return assert.rejects(fn, error => error instanceof DeviceRegistrationError && error.code === code);
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function endpointContext({ method = 'POST', body = REGISTER_REQUEST, contentType = 'application/json', env = {} } = {}) {
  const init = { method, headers: {} };
  if (contentType !== null) init.headers['content-type'] = contentType;
  if (!['GET', 'HEAD'].includes(method)) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    request: new Request('https://example.test/api/device/register', init),
    env,
  };
}

test('normalizes the strict registration whitelist', () => {
  const value = normalizeRegisterRequest(REGISTER_REQUEST);
  assert.deepEqual(value, {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    nickname: '小雪',
    clientContext: { appVersion: '8.2.28', protocolVersion: 1 },
  });
  assert.equal(Object.isFrozen(value), true);
});

test('rejects unknown fields, invalid ids, control characters and oversized bodies', () => {
  assert.throws(
    () => normalizeRegisterRequest({ ...clone(REGISTER_REQUEST), trusted: true }),
    error => error instanceof DeviceRegistrationError && error.code === 'INVALID_REGISTER_FIELDS',
  );
  assert.throws(
    () => normalizeRegisterRequest({ ...clone(REGISTER_REQUEST), deviceId: 'dev_short' }),
    error => error instanceof DeviceRegistrationError && error.code === 'INVALID_DEVICE_ID',
  );
  const control = clone(REGISTER_REQUEST);
  control.nickname = '小\u0000雪';
  assert.throws(
    () => normalizeRegisterRequest(control),
    error => error instanceof DeviceRegistrationError && error.code === 'INVALID_NICKNAME',
  );
  assert.equal(DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes, 8 * 1024);
  assert.ok(assertRegisterRequestBytes(REGISTER_REQUEST) < DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes);
  assert.throws(
    () => assertRegisterRequestBytes('x'.repeat(DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes + 1)),
    error => error instanceof DeviceRegistrationError && error.code === 'REGISTER_REQUEST_TOO_LARGE',
  );
});

test('issues and verifies a signed token without exposing the secret', async () => {
  const issued = await issueDeviceToken({
    deviceId: DEVICE_ID,
    tokenVersion: 1,
    secret: SECRET,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.match(issued.token, /^dt_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(issued.tokenHash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.token.includes(SECRET), false);
  const verified = await verifyDeviceToken(issued.token, { secret: SECRET, now: NOW + 1 });
  assert.equal(verified.payload.deviceId, DEVICE_ID);
  assert.equal(verified.payload.tokenVersion, 1);
  assert.equal(verified.tokenHash, issued.tokenHash);
});

test('rejects tampered, expired and weak-secret tokens', async () => {
  const issued = await issueDeviceToken({
    deviceId: DEVICE_ID,
    tokenVersion: 1,
    secret: SECRET,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: 'BBBBBBBBBBBBBBBBBBBBBB',
  });
  const parts = issued.token.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await expectCode('INVALID_DEVICE_TOKEN_SIGNATURE', () => verifyDeviceToken(parts.join('.'), { secret: SECRET, now: NOW + 1 }));
  await expectCode('DEVICE_TOKEN_EXPIRED', () => verifyDeviceToken(issued.token, { secret: SECRET, now: NOW + 60_000 }));
  await expectCode('DEVICE_TOKEN_SECRET_TOO_SHORT', () => issueDeviceToken({
    deviceId: DEVICE_ID,
    tokenVersion: 1,
    secret: 'too-short',
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  }));
});

test('first registration stores only a token hash and authenticates against the private record', async () => {
  const kv = new FakeKV();
  const result = await registerDevice({ request: REGISTER_REQUEST, kv, secret: SECRET, now: NOW, ttlMs: 60_000 });
  assert.equal(result.device.deviceId, DEVICE_ID);
  assert.equal(result.device.nickname, '小雪');
  assert.equal(result.device.nicknameTag, 'ABCD');
  assert.equal(result.credential.tokenVersion, 1);

  const raw = await kv.get(deviceStorageKey(DEVICE_ID));
  assert.ok(raw);
  assert.equal(raw.includes(result.credential.token), false);
  assert.equal(raw.includes('dt_v1.'), false);
  const stored = JSON.parse(raw);
  assert.match(stored.tokenHash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(stored, 'deviceToken'), false);
  assert.equal(Object.hasOwn(stored, 'token'), false);

  const authenticated = await authenticateDeviceToken({
    authorization: `Bearer ${result.credential.token}`,
    kv,
    secret: SECRET,
    now: NOW + 1,
  });
  assert.equal(authenticated.deviceId, DEVICE_ID);
  assert.equal(authenticated.trusted, false);
});

test('anonymous repeat registration cannot rotate or take over an existing device', async () => {
  const kv = new FakeKV();
  await registerDevice({ request: REGISTER_REQUEST, kv, secret: SECRET, now: NOW, ttlMs: 60_000 });
  const before = await kv.get(deviceStorageKey(DEVICE_ID));
  await expectCode('DEVICE_ALREADY_REGISTERED', () => registerDevice({
    request: { ...clone(REGISTER_REQUEST), nickname: '冒名者' },
    kv,
    secret: SECRET,
    now: NOW + 1,
    ttlMs: 60_000,
  }));
  assert.equal(await kv.get(deviceStorageKey(DEVICE_ID)), before);
});

test('authentication rejects banned, revoked and missing device records', async () => {
  const kv = new FakeKV();
  const result = await registerDevice({ request: REGISTER_REQUEST, kv, secret: SECRET, now: NOW, ttlMs: 60_000 });
  const key = deviceStorageKey(DEVICE_ID);
  const original = JSON.parse(await kv.get(key));

  await kv.put(key, JSON.stringify({ ...original, status: 'banned' }));
  await expectCode('DEVICE_BANNED', () => authenticateDeviceToken({
    authorization: `Bearer ${result.credential.token}`,
    kv,
    secret: SECRET,
    now: NOW + 1,
  }));

  await kv.put(key, JSON.stringify({ ...original, tokenHash: 'A'.repeat(43) }));
  await expectCode('DEVICE_TOKEN_REVOKED', () => authenticateDeviceToken({
    authorization: `Bearer ${result.credential.token}`,
    kv,
    secret: SECRET,
    now: NOW + 1,
  }));

  kv.map.delete(key);
  await expectCode('DEVICE_NOT_REGISTERED', () => authenticateDeviceToken({
    authorization: `Bearer ${result.credential.token}`,
    kv,
    secret: SECRET,
    now: NOW + 1,
  }));
});

test('registration endpoint is disabled by default and never pretends success', async () => {
  const response = await registerHandler(endpointContext());
  assert.equal(response.status, 503);
  const payload = await responseJson(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DEVICE_REGISTRATION_DISABLED');
});

test('configured endpoint registers once and keeps every mutation capability disabled', async () => {
  const kv = new FakeKV();
  const env = {
    CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED: 'true',
    CLOUD_COLLAB_KV: kv,
    CLOUD_COLLAB_DEVICE_TOKEN_SECRET: SECRET,
  };
  const response = await registerHandler(endpointContext({ env }));
  assert.equal(response.status, 201);
  const payload = await responseJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, 'registered');
  assert.equal(payload.data.device.deviceId, DEVICE_ID);
  assert.match(payload.data.credential.token, /^dt_v1\./);
  assert.equal(payload.data.publicMutationAllowed, false);
  assert.equal(payload.data.submissionEnabled, false);
  assert.equal(payload.data.autoApprovalEnabled, false);

  const repeated = await registerHandler(endpointContext({ env }));
  assert.equal(repeated.status, 409);
  assert.equal((await responseJson(repeated)).error.code, 'DEVICE_ALREADY_REGISTERED');
});

test('endpoint validates method, media type, json, configuration and body size', async () => {
  const kv = new FakeKV();
  const env = {
    CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED: 'true',
    CLOUD_COLLAB_KV: kv,
    CLOUD_COLLAB_DEVICE_TOKEN_SECRET: SECRET,
  };

  const options = await registerHandler(endpointContext({ method: 'OPTIONS', body: '' }));
  assert.equal(options.status, 204);
  const get = await registerHandler(endpointContext({ method: 'GET', body: '' }));
  assert.equal(get.status, 405);
  const media = await registerHandler(endpointContext({ env, contentType: 'text/plain' }));
  assert.equal(media.status, 415);
  const invalidJson = await registerHandler(endpointContext({ env, body: '{bad' }));
  assert.equal(invalidJson.status, 400);
  assert.equal((await responseJson(invalidJson)).error.code, 'INVALID_JSON');
  const tooLarge = await registerHandler(endpointContext({ env, body: 'x'.repeat(DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes + 1) }));
  assert.equal(tooLarge.status, 413);
  const missingKv = await registerHandler(endpointContext({ env: {
    CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED: 'true',
    CLOUD_COLLAB_DEVICE_TOKEN_SECRET: SECRET,
  } }));
  assert.equal(missingKv.status, 503);
  assert.equal((await responseJson(missingKv)).error.code, 'DEVICE_REGISTRY_NOT_CONFIGURED');
});
