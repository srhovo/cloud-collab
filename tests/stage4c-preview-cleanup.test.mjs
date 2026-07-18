import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_CLEANUP_CONFIRMATION,
  PREVIEW_CLEANUP_NAMESPACE,
  PreviewCleanupError,
  assertPreviewCleanupAccess,
  cleanupSyntheticPreviewObjects,
  isSyntheticPreviewKey,
  readPreviewCleanupConfig,
} from '../src/server/preview_cleanup_v1.js';
import { handlePreviewCleanupRequest } from '../src/server/preview_cleanup_http_v1.js';

const PREVIEW_KEY = 'stage4c-preview-cleanup-key-0123456789';
const ENV = Object.freeze({
  CLOUD_PREVIEW_CLEANUP_ENABLED: '1',
  CLOUD_PREVIEW_CLEANUP_CONFIRMATION: PREVIEW_CLEANUP_CONFIRMATION,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
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

class MemoryListStore {
  constructor(keys = []) {
    this.items = new Set(keys);
    this.deleted = [];
  }
  async list() { return { blobs: [...this.items].sort().map(key => ({ key, etag: `etag-${key.length}` })) }; }
  async delete(key) { this.deleted.push(key); this.items.delete(key); }
}

function request(key = PREVIEW_KEY, body = {}) {
  return new Request('https://example.test/one-shot/cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Collab-Preview-Key': key },
    body: JSON.stringify({ schemaVersion: 1, confirmation: PREVIEW_CLEANUP_CONFIRMATION, ...body }),
  });
}

function expectCode(code, action) {
  return assert.rejects(action, error => error instanceof PreviewCleanupError && error.code === code);
}

test('cleanup config is independent from write enablement and fails unless write remains disabled', () => {
  assert.throws(() => readPreviewCleanupConfig({}), error => error.code === 'PREVIEW_CLEANUP_DISABLED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }), error => error.code === 'PREVIEW_WRITE_MUST_REMAIN_DISABLED');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'production-data' }), error => error.code === 'PREVIEW_CLEANUP_NAMESPACE_MISMATCH');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_xiacijian' }), error => error.code === 'PREVIEW_CLEANUP_SCOPE_MISMATCH');
  assert.throws(() => readPreviewCleanupConfig({ ...ENV, CLOUD_PREVIEW_CLEANUP_CONFIRMATION: '' }), error => error.code === 'PREVIEW_CLEANUP_CONFIRMATION_MISSING');
  assert.equal(readPreviewCleanupConfig(ENV).namespace, PREVIEW_CLEANUP_NAMESPACE);
});

test('cleanup access uses the existing preview secret and rejects wrong values', () => {
  const config = readPreviewCleanupConfig(ENV);
  assert.equal(assertPreviewCleanupAccess(request(), config), true);
  assert.throws(() => assertPreviewCleanupAccess(request('wrong'), config), error => error.code === 'PREVIEW_CLEANUP_ACCESS_DENIED' && error.status === 403);
});

test('allowlist recognizes only stage4B.2 synthetic object shapes', () => {
  ALLOWED_KEYS.forEach(key => assert.equal(isSyntheticPreviewKey(key), true, key));
  [
    'devices/profiles/not-a-device.json',
    'submissions/lib_xiacijian_regular/pending/ik_v1_0000000000000000000000000000000000000000000.json',
    'libraries/lib_receive_fixture/snapshots/1.json',
    'public-version.json',
  ].forEach(key => assert.equal(isSyntheticPreviewKey(key), false, key));
});

test('unsafe object aborts before any delete and exposes only a digest', async () => {
  const store = new MemoryListStore([...ALLOWED_KEYS, 'libraries/lib_receive_fixture/snapshots/1.json']);
  await expectCode('PREVIEW_CLEANUP_UNSAFE_OBJECTS', () => cleanupSyntheticPreviewObjects({ store }));
  assert.deepEqual(store.deleted, []);
  try {
    await cleanupSyntheticPreviewObjects({ store });
  } catch (error) {
    assert.equal(error.details.unsafeCount, 1);
    assert.match(error.details.unsafeKeySetDigest, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(error.details).includes('libraries/'), false);
  }
});

test('synthetic objects are deleted and strong re-list must be empty', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const result = await cleanupSyntheticPreviewObjects({ store });
  assert.equal(result.completed, true);
  assert.equal(result.deletedCount, ALLOWED_KEYS.length);
  assert.equal(result.remainingCount, 0);
  assert.equal(result.publicMutationAllowed, false);
  assert.deepEqual(store.deleted.sort(), [...ALLOWED_KEYS].sort());
});

test('HTTP gate validates config and secret before creating Blob store', async () => {
  let creates = 0;
  const response = await handlePreviewCleanupRequest({ request: request('wrong'), env: ENV }, {
    createStore: () => { creates += 1; return new MemoryListStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(creates, 0);
  const payload = await response.json();
  assert.equal(payload.error.code, 'PREVIEW_CLEANUP_ACCESS_DENIED');
});

test('HTTP success returns no object keys or secrets', async () => {
  const response = await handlePreviewCleanupRequest({ request: request(), env: ENV }, {
    createStore: () => new MemoryListStore(ALLOWED_KEYS),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.deletedCount, ALLOWED_KEYS.length);
  assert.equal(text.includes('devices/profiles'), false);
  assert.equal(text.includes(PREVIEW_KEY), false);
});
