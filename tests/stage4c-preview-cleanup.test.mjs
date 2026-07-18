import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_CLEANUP_CONFIRMATION,
  PREVIEW_CLEANUP_NAMESPACE,
  PreviewCleanupError,
  assertPreviewCleanupAccess,
  cleanupSyntheticPreviewObjects,
  inspectSyntheticPreviewObjects,
  isSyntheticPreviewKey,
  readPreviewCleanupConfig,
} from '../src/server/preview_cleanup_v1.js';
import { handlePreviewCleanupRequest } from '../src/server/preview_cleanup_http_v1.js';

const CLEANUP_KEY = 'stage4c-independent-cleanup-key-0123456789';
const PREVIEW_KEY = 'stage4b2-preview-write-key-012345678901';
const RATE_SALT = 'stage4b2-rate-limit-salt-012345678901';
const ENV = Object.freeze({
  CLOUD_PREVIEW_CLEANUP_ENABLED: '1',
  CLOUD_PREVIEW_CLEANUP_CONFIRMATION: PREVIEW_CLEANUP_CONFIRMATION,
  CLOUD_PREVIEW_CLEANUP_KEY: CLEANUP_KEY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: PREVIEW_CLEANUP_NAMESPACE,
});

const ALLOWED_KEYS = Object.freeze([
  'devices/profiles/dev_01JABCDEF0123456789XYZABCD.json',
  'devices/token-index/dth_v1_0000000000000000000000000000000000000000000.json',
  'submissions/lib_receive_fixture/pending/ik_v1_0000000000000000000000000000000000000000000.json',
  'preview-rate/device-register/0000000000000000000000000000000000000000000/123.json',
  'preview-rate/submission-create/0000000000000000000000000000000000000000000/456.json',
]);
const EXTRA_ALLOWED_KEY = 'devices/profiles/dev_01JABCDEF0123456789XYZABCE.json';

class MemoryListStore {
  constructor(keys = []) {
    this.items = new Set(keys);
    this.deleted = [];
    this.listOptions = [];
  }
  async list(options = {}) {
    this.listOptions.push({ ...options });
    return { blobs: [...this.items].sort().map(key => ({ key, etag: `etag-${key.length}` })) };
  }
  async delete(key) {
    this.deleted.push(key);
    this.items.delete(key);
  }
}

function request({ key = CLEANUP_KEY, action = 'inspect', digest = null, body = null } = {}) {
  const payload = body || {
    schemaVersion: 1,
    action,
    confirmation: PREVIEW_CLEANUP_CONFIRMATION,
    ...(action === 'execute' ? { expectedKeySetDigest: digest } : {}),
  };
  return new Request('https://example.test/one-shot/cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Collab-Cleanup-Key': key },
    body: JSON.stringify(payload),
  });
}

function expectCode(code, action) {
  return assert.rejects(action, error => error instanceof PreviewCleanupError && error.code === code);
}

test('cleanup config is fail-closed, fixed-scope, and requires an independent secret', () => {
  assert.throws(() => readPreviewCleanupConfig({}), error => error.code === 'PREVIEW_CLEANUP_DISABLED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }), error => error.code === 'PREVIEW_WRITE_MUST_REMAIN_DISABLED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'production-data' }), error => error.code === 'PREVIEW_CLEANUP_NAMESPACE_MISMATCH');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_xiacijian' }), error => error.code === 'PREVIEW_CLEANUP_SCOPE_MISMATCH');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_PREVIEW_CLEANUP_CONFIRMATION: '' }), error => error.code === 'PREVIEW_CLEANUP_CONFIRMATION_MISSING');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_PREVIEW_CLEANUP_KEY: '' }), error => error.code === 'PREVIEW_CLEANUP_KEY_NOT_CONFIGURED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_PREVIEW_CLEANUP_KEY: PREVIEW_KEY }), error => error.code === 'PREVIEW_CLEANUP_KEY_REUSED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_PREVIEW_CLEANUP_KEY: RATE_SALT }), error => error.code === 'PREVIEW_CLEANUP_KEY_REUSED');
  assert.equal(readPreviewCleanupConfig(ENV).namespace, PREVIEW_CLEANUP_NAMESPACE);
});

test('cleanup access uses the independent cleanup header and rejects wrong values', () => {
  const config = readPreviewCleanupConfig(ENV);
  assert.equal(assertPreviewCleanupAccess(request(), config), true);
  assert.throws(() => assertPreviewCleanupAccess(request({ key: 'wrong' }), config), error => error.code === 'PREVIEW_CLEANUP_ACCESS_DENIED' && error.status === 403);
  const wrongHeader = new Request('https://example.test/one-shot/cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Collab-Preview-Key': CLEANUP_KEY },
    body: JSON.stringify({ schemaVersion: 1, action: 'inspect', confirmation: PREVIEW_CLEANUP_CONFIRMATION }),
  });
  assert.throws(() => assertPreviewCleanupAccess(wrongHeader, config), error => error.code === 'PREVIEW_CLEANUP_ACCESS_DENIED');
});

test('allowlist recognizes only stage4B.2 synthetic object shapes', () => {
  [...ALLOWED_KEYS, EXTRA_ALLOWED_KEY].forEach(key => assert.equal(isSyntheticPreviewKey(key), true, key));
  [
    'devices/profiles/not-a-device.json',
    'submissions/lib_xiacijian_regular/pending/ik_v1_0000000000000000000000000000000000000000000.json',
    'libraries/lib_receive_fixture/snapshots/1.json',
    'public-version.json',
  ].forEach(key => assert.equal(isSyntheticPreviewKey(key), false, key));
});

test('inspect is strong, returns only a digest, and performs zero deletes', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const result = await inspectSyntheticPreviewObjects({ store });
  assert.equal(result.readyToExecute, true);
  assert.equal(result.objectCount, ALLOWED_KEYS.length);
  assert.match(result.keySetDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(store.deleted, []);
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
  assert.equal(JSON.stringify(result).includes('devices/profiles'), false);
});

test('unsafe object aborts before any delete and exposes only a digest', async () => {
  const store = new MemoryListStore([...ALLOWED_KEYS, 'libraries/lib_receive_fixture/snapshots/1.json']);
  await expectCode('PREVIEW_CLEANUP_UNSAFE_OBJECTS', () => inspectSyntheticPreviewObjects({ store }));
  assert.deepEqual(store.deleted, []);
  try {
    await inspectSyntheticPreviewObjects({ store });
  } catch (error) {
    assert.equal(error.details.unsafeCount, 1);
    assert.match(error.details.unsafeKeySetDigest, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(error.details).includes('libraries/'), false);
  }
});

test('execute refuses a changed key set before the first delete', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const inspection = await inspectSyntheticPreviewObjects({ store });
  store.items.add(EXTRA_ALLOWED_KEY);
  await expectCode('PREVIEW_CLEANUP_KEYSET_CHANGED', () => cleanupSyntheticPreviewObjects({ store, expectedKeySetDigest: inspection.keySetDigest }));
  assert.deepEqual(store.deleted, []);
});

test('synthetic objects are deleted only with the matching inspected digest and strong re-list is empty', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const inspection = await inspectSyntheticPreviewObjects({ store });
  const result = await cleanupSyntheticPreviewObjects({ store, expectedKeySetDigest: inspection.keySetDigest });
  assert.equal(result.completed, true);
  assert.equal(result.deletedCount, ALLOWED_KEYS.length);
  assert.equal(result.remainingCount, 0);
  assert.equal(result.publicMutationAllowed, false);
  assert.deepEqual(store.deleted.sort(), [...ALLOWED_KEYS].sort());
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
});

test('HTTP gate validates config and cleanup secret before parsing body or creating Blob store', async () => {
  let creates = 0;
  const response = await handlePreviewCleanupRequest({ request: request({ key: 'wrong', body: { invalid: true } }), env: ENV }, {
    createStore: () => { creates += 1; return new MemoryListStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(creates, 0);
  const payload = await response.json();
  assert.equal(payload.error.code, 'PREVIEW_CLEANUP_ACCESS_DENIED');
});

test('HTTP requires inspect then execute with the exact digest and returns no keys or secrets', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const dependencies = { createStore: () => store };
  const inspectResponse = await handlePreviewCleanupRequest({ request: request(), env: ENV }, dependencies);
  assert.equal(inspectResponse.status, 200);
  assert.equal(inspectResponse.headers.get('access-control-allow-origin'), null);
  assert.equal(inspectResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  const inspectText = await inspectResponse.text();
  const inspectPayload = JSON.parse(inspectText);
  assert.equal(inspectPayload.action, 'inspect');
  assert.equal(inspectPayload.data.objectCount, ALLOWED_KEYS.length);
  assert.deepEqual(store.deleted, []);

  const executeResponse = await handlePreviewCleanupRequest({
    request: request({ action: 'execute', digest: inspectPayload.data.keySetDigest }),
    env: ENV,
  }, dependencies);
  assert.equal(executeResponse.status, 200);
  const executeText = await executeResponse.text();
  const executePayload = JSON.parse(executeText);
  assert.equal(executePayload.action, 'execute');
  assert.equal(executePayload.data.deletedCount, ALLOWED_KEYS.length);
  assert.equal(executePayload.data.remainingCount, 0);
  for (const forbidden of ['devices/profiles', CLEANUP_KEY, PREVIEW_KEY, RATE_SALT]) {
    assert.equal(inspectText.includes(forbidden) || executeText.includes(forbidden), false);
  }
});
