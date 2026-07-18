import test from 'node:test';
import assert from 'node:assert/strict';
import healthHandler from '../edge-functions/api/health.js';
import protocolHandler from '../edge-functions/api/protocol.js';
import publicVersionHandler from '../edge-functions/api/public-version.js';
import publicSnapshotHandler from '../edge-functions/api/public-snapshot.js';
import publicChangesHandler from '../edge-functions/api/public-changes.js';

async function call(handler, url, { method = 'GET', env = {} } = {}) {
  return handler({ request: new Request(url, { method }), env, params: {}, waitUntil() {} });
}
async function json(response) { return JSON.parse(await response.text()); }

test('health remains read-only, uncached, and exposes no secret', async () => {
  const response = await call(healthHandler, 'https://test.example/api/health', { env: { APP_ENV: 'preview', SECRET_TOKEN: 'must-not-leak' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.data.writeEnabled, false);
  assert.equal(body.data.capabilities.submission, false);
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
});

test('read endpoints reject writes and support OPTIONS/HEAD', async () => {
  for (const [handler, path] of [[healthHandler, 'health'], [publicSnapshotHandler, 'public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture'], [publicChangesHandler, 'public-changes?groupId=group_fixture&libraryId=lib_receive_fixture']]) {
    const post = await call(handler, `https://test.example/api/${path}`, { method: 'POST' });
    assert.equal(post.status, 405);
    const options = await call(handler, `https://test.example/api/${path}`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    const head = await call(handler, `https://test.example/api/${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('protocol enables snapshot and incremental read but no write capability', async () => {
  const body = await json(await call(protocolHandler, 'https://test.example/api/protocol'));
  assert.equal(body.data.protocolVersion, 1);
  assert.equal(body.data.writeEnabled, false);
  assert.equal(body.data.capabilities.snapshotRead, true);
  assert.equal(body.data.capabilities.incrementalRead, true);
  assert.equal(body.data.capabilities.exactPriceReceive, true);
  assert.equal(body.data.capabilities.submission, false);
  assert.equal(body.data.capabilities.adminReview, false);
});

test('official scope remains empty and contains no business record', async () => {
  const response = await call(publicVersionHandler, 'https://test.example/api/public-version?groupId=group_xiacijian&libraryId=lib_xiacijian_regular');
  const body = await json(response);
  assert.equal(body.data.publicVersion, 0);
  assert.equal(body.data.snapshotAvailable, false);
  assert.equal(JSON.stringify(body).includes('unitPrice'), false);
  const snapshot = await json(await call(publicSnapshotHandler, 'https://test.example/api/public-snapshot?groupId=group_xiacijian&libraryId=lib_xiacijian_regular'));
  assert.equal(snapshot.data.status, 'snapshot_unavailable');
  assert.equal(snapshot.data.snapshot, null);
});

test('fixture exposes a strict full snapshot and supports not_modified', async () => {
  const version = await json(await call(publicVersionHandler, 'https://test.example/api/public-version?groupId=group_fixture&libraryId=lib_receive_fixture'));
  assert.equal(version.data.publicVersion, 3);
  assert.equal(version.data.snapshotAvailable, true);
  assert.equal(version.data.recordCounts.exactPrice, 2);
  assert.equal(Object.hasOwn(version.data, 'events'), false);
  assert.equal(Object.hasOwn(version.data, 'snapshot'), false);

  const full = await json(await call(publicSnapshotHandler, 'https://test.example/api/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&ifVersion=0'));
  assert.equal(full.data.status, 'snapshot');
  assert.equal(full.data.snapshot.records.length, 2);
  assert.equal(full.data.snapshot.records[0].dataType, 'exact_price');
  assert.equal(full.data.writeEnabled, false);

  const unchanged = await json(await call(publicSnapshotHandler, 'https://test.example/api/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&ifVersion=3'));
  assert.equal(unchanged.data.status, 'not_modified');
  assert.equal(unchanged.data.snapshot, null);
});

test('incremental endpoint returns ordered immutable changes', async () => {
  const all = await json(await call(publicChangesHandler, 'https://test.example/api/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=0&limit=100'));
  assert.deepEqual(all.data.changes.map(item => item.version), [1, 2, 3]);
  assert.equal(all.data.nextVersion, 3);
  assert.equal(all.data.hasMore, false);
  assert.equal(all.data.changes[0].businessKey, all.data.changes[2].businessKey);
  assert.notEqual(all.data.changes[0].contentHash, all.data.changes[2].contentHash);

  const later = await json(await call(publicChangesHandler, 'https://test.example/api/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=1&limit=1'));
  assert.deepEqual(later.data.changes.map(item => item.version), [2]);
  assert.equal(later.data.nextVersion, 2);
  assert.equal(later.data.hasMore, true);
});

test('snapshot and changes validate inputs without enumerating unknown scopes', async () => {
  const invalid = await call(publicSnapshotHandler, 'https://test.example/api/public-snapshot?groupId=bad&libraryId=lib_ok');
  assert.equal(invalid.status, 400);
  const missing = await call(publicChangesHandler, 'https://test.example/api/public-changes?groupId=group_unknown&libraryId=lib_unknown');
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, 'PUBLIC_LIBRARY_NOT_FOUND');
  const ahead = await call(publicChangesHandler, 'https://test.example/api/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=4');
  assert.equal(ahead.status, 409);
  assert.equal((await json(ahead)).error.code, 'PUBLIC_VERSION_AHEAD');
});
