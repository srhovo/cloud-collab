import test from 'node:test';
import assert from 'node:assert/strict';
import healthHandler from '../edge-functions/api/health.js';
import protocolHandler from '../edge-functions/api/protocol.js';
import publicVersionHandler from '../edge-functions/api/public-version.js';

async function call(handler, url, { method = 'GET', env = {} } = {}) {
  return handler({ request: new Request(url, { method }), env, params: {}, waitUntil() {} });
}

async function json(response) {
  return JSON.parse(await response.text());
}

test('health is read-only, uncached, and exposes no secret', async () => {
  const response = await call(healthHandler, 'https://test.example/api/health', { env: { APP_ENV: 'preview', SECRET_TOKEN: 'must-not-leak' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.data.environment, 'preview');
  assert.equal(body.data.writeEnabled, false);
  assert.equal(body.data.capabilities.submission, false);
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
});

test('health rejects write methods and supports OPTIONS/HEAD', async () => {
  const post = await call(healthHandler, 'https://test.example/api/health', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal((await json(post)).error.code, 'METHOD_NOT_ALLOWED');
  const options = await call(healthHandler, 'https://test.example/api/health', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-methods'), /GET/);
  const head = await call(healthHandler, 'https://test.example/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('protocol freezes version 1 and disables write capabilities', async () => {
  const response = await call(protocolHandler, 'https://test.example/api/protocol');
  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.data.protocolVersion, 1);
  assert.equal(body.data.minimumClientProtocolVersion, 1);
  assert.equal(body.data.writeEnabled, false);
  assert.equal(body.data.capabilities.snapshotRead, false);
  assert.equal(body.data.capabilities.submission, false);
  assert.match(response.headers.get('cache-control'), /max-age=300/);
});

test('public-version returns only empty test metadata for the registered scope', async () => {
  const response = await call(publicVersionHandler, 'https://test.example/api/public-version?groupId=group_xiacijian&libraryId=lib_xiacijian_regular');
  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.data.publicVersion, 0);
  assert.equal(body.data.snapshotAvailable, false);
  assert.equal(body.data.writeEnabled, false);
  assert.deepEqual(body.data.recordCounts, {
    exactPrice: 0,
    rankRangeRule: 0,
    surchargeRule: 0,
    giftRule: 0,
    playableName: 0,
    bossProfile: 0,
  });
  assert.equal(JSON.stringify(body).includes('deviceId'), false);
  assert.equal(JSON.stringify(body).includes('unitPrice'), false);
});

test('public-version validates scope and does not enumerate unknown libraries', async () => {
  const invalid = await call(publicVersionHandler, 'https://test.example/api/public-version?groupId=bad&libraryId=lib_ok');
  assert.equal(invalid.status, 400);
  assert.equal((await json(invalid)).error.code, 'INVALID_PUBLIC_SCOPE');
  const missing = await call(publicVersionHandler, 'https://test.example/api/public-version?groupId=group_unknown&libraryId=lib_unknown');
  assert.equal(missing.status, 404);
  const missingBody = await json(missing);
  assert.equal(missingBody.error.code, 'PUBLIC_LIBRARY_NOT_FOUND');
  assert.deepEqual(missingBody.error.details, { groupId: 'group_unknown', libraryId: 'lib_unknown' });
});
