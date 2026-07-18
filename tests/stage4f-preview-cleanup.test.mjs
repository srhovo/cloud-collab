import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  STAGE4F_CLEANUP_CONFIRMATION,
  STAGE4F_CLEANUP_MAX_OBJECTS,
  STAGE4F_CLEANUP_NAMESPACE,
  Stage4fPreviewCleanupError,
  assertStage4fPreviewCleanupAccess,
  cleanupStage4fSyntheticPreviewObjects,
  inspectStage4fSyntheticPreviewObjects,
  isStage4fSyntheticPreviewKey,
  readStage4fPreviewCleanupConfig,
} from '../src/server/stage4f_preview_cleanup_v1.js';
import { handleStage4fPreviewCleanupRequest } from '../src/server/stage4f_preview_cleanup_http_v1.js';

const CLEANUP_KEY = 'stage4f-independent-cleanup-key-0123456789';
const PREVIEW_KEY = 'stage4f-preview-write-key-012345678901234';
const RATE_SALT = 'stage4f-rate-limit-salt-012345678901234';
const ENV = Object.freeze({
  CLOUD_STAGE4F_CLEANUP_ENABLED: '1',
  CLOUD_STAGE4F_CLEANUP_CONFIRMATION: STAGE4F_CLEANUP_CONFIRMATION,
  CLOUD_STAGE4F_CLEANUP_KEY: CLEANUP_KEY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: STAGE4F_CLEANUP_NAMESPACE,
});

const H = '0'.repeat(43);
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const ALLOWED_KEYS = Object.freeze([
  `devices/profiles/${DEVICE}.json`,
  `devices/token-index/dth_v1_${H}.json`,
  `devices/trusted/${DEVICE}.json`,
  `submissions/lib_receive_fixture/pending/ik_v1_${H}.json`,
  `submissions/lib_receive_fixture/matches/bk_v1_${H}/pv_000000000000/ch_v1_${H}/${DEVICE}.json`,
  `reviews/lib_receive_fixture/pending/bk_v1_${H}/pv_000000000002/ch_v1_${H}.json`,
  'public/lib_receive_fixture/events/000000000001.json',
  'public/lib_receive_fixture/snapshots/000000000002.json',
  `public/lib_receive_fixture/approvals/ap_v1_${H}.json`,
  `public/lib_receive_fixture/transitions/bk_v1_${H}/000000000001.json`,
  `preview-rate/device-register/${H}/123.json`,
  `preview-rate/submission-create/${H}/456.json`,
]);

class MemoryListStore {
  constructor(keys = []) { this.items = new Set(keys); this.deleted = []; this.listOptions = []; }
  async list(options = {}) {
    this.listOptions.push({ ...options });
    return { blobs: [...this.items].sort().map(key => ({ key })) };
  }
  async delete(key) { this.deleted.push(key); this.items.delete(key); }
}

function request({ key = CLEANUP_KEY, action = 'inspect', digest = null, body = null } = {}) {
  const payload = body || {
    schemaVersion: 1,
    action,
    confirmation: STAGE4F_CLEANUP_CONFIRMATION,
    ...(action === 'execute' ? { expectedKeySetDigest: digest } : {}),
  };
  return new Request('https://preview.example/one-shot/stage4f-cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Collab-Cleanup-Key': key },
    body: JSON.stringify(payload),
  });
}

function expectCode(code, action) {
  return assert.rejects(action, error => error instanceof Stage4fPreviewCleanupError && error.code === code);
}

test('stage4F cleanup config fails closed and requires both preview switches off', () => {
  assert.throws(() => readStage4fPreviewCleanupConfig({}), error => error.code === 'STAGE4F_CLEANUP_DISABLED');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }), error => error.code === 'PREVIEW_WRITE_MUST_BE_DISABLED');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1' }), error => error.code === 'PREVIEW_AUTO_APPROVAL_MUST_BE_DISABLED');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'formal-data' }), error => error.code === 'STAGE4F_CLEANUP_NAMESPACE_MISMATCH');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_other' }), error => error.code === 'STAGE4F_CLEANUP_SCOPE_MISMATCH');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_STAGE4F_CLEANUP_KEY: PREVIEW_KEY }), error => error.code === 'STAGE4F_CLEANUP_KEY_REUSED');
  assert.throws(() => readStage4fPreviewCleanupConfig({ ...ENV, CLOUD_STAGE4F_CLEANUP_KEY: RATE_SALT }), error => error.code === 'STAGE4F_CLEANUP_KEY_REUSED');
  assert.equal(readStage4fPreviewCleanupConfig(ENV).namespace, STAGE4F_CLEANUP_NAMESPACE);
});

test('cleanup header is independent from preview access and checked before storage', async () => {
  const config = readStage4fPreviewCleanupConfig(ENV);
  assert.equal(assertStage4fPreviewCleanupAccess(request(), config), true);
  assert.throws(() => assertStage4fPreviewCleanupAccess(request({ key: 'wrong' }), config), error => error.code === 'STAGE4F_CLEANUP_ACCESS_DENIED');
  let creates = 0;
  const response = await handleStage4fPreviewCleanupRequest({ request: request({ key: 'wrong', body: { invalid: true } }), env: ENV }, {
    createStore: () => { creates += 1; return new MemoryListStore(); },
  });
  assert.equal(response.status, 403);
  assert.equal(creates, 0);
});

test('cleanup allowlist covers every stage4E synthetic object family and nothing broader', () => {
  for (const key of ALLOWED_KEYS) assert.equal(isStage4fSyntheticPreviewKey(key), true, key);
  for (const key of [
    `submissions/lib_formal/pending/ik_v1_${H}.json`,
    'public/lib_formal/events/000000000001.json',
    'public/lib_receive_fixture/unknown/000000000001.json',
    'users/private.json',
    '../escape.json',
  ]) assert.equal(isStage4fSyntheticPreviewKey(key), false, key);
});

test('inspect is strong, returns only count and digest, and deletes nothing', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const result = await inspectStage4fSyntheticPreviewObjects({ store });
  assert.equal(result.objectCount, ALLOWED_KEYS.length);
  assert.match(result.keySetDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.publicMutationAllowed, false);
  assert.equal(result.autoApprovalEnabled, false);
  assert.deepEqual(store.deleted, []);
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
  assert.equal(JSON.stringify(result).includes('devices/'), false);
});

test('unknown object or changed key set aborts before the first delete', async () => {
  const unsafeStore = new MemoryListStore([...ALLOWED_KEYS, 'formal/private.json']);
  await expectCode('STAGE4F_CLEANUP_UNSAFE_OBJECTS', () => inspectStage4fSyntheticPreviewObjects({ store: unsafeStore }));
  assert.deepEqual(unsafeStore.deleted, []);

  const store = new MemoryListStore(ALLOWED_KEYS);
  const inspected = await inspectStage4fSyntheticPreviewObjects({ store });
  store.items.add(`devices/profiles/dev_01JABCDEF0123456789XYZABCE.json`);
  await expectCode('STAGE4F_CLEANUP_KEYSET_CHANGED', () => cleanupStage4fSyntheticPreviewObjects({ store, expectedKeySetDigest: inspected.keySetDigest }));
  assert.deepEqual(store.deleted, []);
});

test('matching inspect digest deletes exactly the synthetic set and strongly relists zero', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const inspected = await inspectStage4fSyntheticPreviewObjects({ store });
  const result = await cleanupStage4fSyntheticPreviewObjects({ store, expectedKeySetDigest: inspected.keySetDigest });
  assert.equal(result.completed, true);
  assert.equal(result.deletedCount, ALLOWED_KEYS.length);
  assert.equal(result.remainingCount, 0);
  assert.deepEqual(store.deleted.sort(), [...ALLOWED_KEYS].sort());
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
});

test('HTTP requires inspect then execute with exact digest and never returns keys or secrets', async () => {
  const store = new MemoryListStore(ALLOWED_KEYS);
  const dependencies = { createStore: () => store };
  const inspectResponse = await handleStage4fPreviewCleanupRequest({ request: request(), env: ENV }, dependencies);
  assert.equal(inspectResponse.status, 200);
  assert.equal(inspectResponse.headers.get('access-control-allow-origin'), null);
  assert.equal(inspectResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  const inspectText = await inspectResponse.text();
  const inspectPayload = JSON.parse(inspectText);
  const executeResponse = await handleStage4fPreviewCleanupRequest({
    request: request({ action: 'execute', digest: inspectPayload.data.keySetDigest }), env: ENV,
  }, dependencies);
  assert.equal(executeResponse.status, 200);
  const executeText = await executeResponse.text();
  const executePayload = JSON.parse(executeText);
  assert.equal(executePayload.data.remainingCount, 0);
  for (const forbidden of ['devices/profiles', CLEANUP_KEY, PREVIEW_KEY, RATE_SALT]) {
    assert.equal(inspectText.includes(forbidden) || executeText.includes(forbidden), false);
  }
});

test('cleanup refuses a suspiciously large namespace before deletion', async () => {
  assert.equal(STAGE4F_CLEANUP_MAX_OBJECTS, 500);
  const blobs = Array.from({ length: STAGE4F_CLEANUP_MAX_OBJECTS + 1 }, (_, index) => ({
    key: `preview-rate/device-register/${H}/${index}.json`,
  }));
  let deleted = false;
  const store = {
    async list(options = {}) { assert.equal(options.consistency, 'strong'); return { blobs }; },
    async delete() { deleted = true; },
  };
  await assert.rejects(
    () => inspectStage4fSyntheticPreviewObjects({ store }),
    error => error.code === 'STAGE4F_CLEANUP_OBJECT_LIMIT' && error.details?.objectCount === 501,
  );
  assert.equal(deleted, false);
});

test('environment template keeps all temporary gates off and all secrets empty', () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.match(env, /^CLOUD_WRITE_PREVIEW_ENABLED=0$/m);
  assert.match(env, /^CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED=0$/m);
  assert.match(env, /^CLOUD_STAGE4F_CLEANUP_ENABLED=0$/m);
  assert.match(env, /^CLOUD_WRITE_PREVIEW_KEY=$/m);
  assert.match(env, /^CLOUD_RATE_LIMIT_SALT=$/m);
  assert.match(env, /^CLOUD_STAGE4F_CLEANUP_KEY=$/m);
  assert.match(env, /^CLOUD_STAGE4F_CLEANUP_CONFIRMATION=$/m);
});
