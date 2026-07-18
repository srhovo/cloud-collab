import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEANUP_CONFIRMATION,
  PreviewFixtureCleanupError,
  inspectPreviewFixtureObjects,
  readPreviewFixtureCleanupConfig,
  runPreviewFixtureCleanup,
} from '../src/server/preview_fixture_cleanup_once_v1.js';

const DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD';
const TOKEN_HASH = `dth_v1_${'A'.repeat(43)}`;
const IDEMPOTENCY = `ik_v1_${'B'.repeat(43)}`;

class FakeStore {
  constructor(entries = {}) {
    this.items = new Map(Object.entries(entries).map(([key, value]) => [key, structuredClone(value)]));
    this.calls = [];
  }
  async list(options = {}) {
    this.calls.push(['list', options]);
    return { blobs: [...this.items.keys()].map(key => ({ key, etag: 'e' })) };
  }
  async get(key, options = {}) {
    this.calls.push(['get', key, options]);
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async delete(key) {
    this.calls.push(['delete', key]);
    this.items.delete(key);
  }
}

function fixtureEntries() {
  return {
    [`devices/profiles/${DEVICE_ID}.json`]: {
      schemaVersion: 1, deviceId: DEVICE_ID, nickname: '测试设备', nicknameTag: 'ABCD', tokenHash: TOKEN_HASH,
      tokenVersion: 1, issuedAt: 1000, expiresAt: 2000, createdAt: 1000, updatedAt: 1000, lastAppVersion: '8.2.28',
    },
    [`devices/token-index/${TOKEN_HASH}.json`]: {
      schemaVersion: 1, deviceId: DEVICE_ID, tokenHash: TOKEN_HASH, tokenVersion: 1, issuedAt: 1000, expiresAt: 2000,
    },
    [`submissions/lib_receive_fixture/pending/${IDEMPOTENCY}.json`]: {
      schemaVersion: 1, requestHash: `req_v1_${'C'.repeat(43)}`, status: 'waiting_confirmation', decision: 'waiting_confirmation', reason: 'fixture',
      submission: { groupId: 'group_fixture', libraryId: 'lib_receive_fixture', dataType: 'exact_price', operation: 'upsert', idempotencyKey: IDEMPOTENCY },
      receivedAt: 1000, authenticatedTokenVersion: 1, publicMutationAllowed: false, autoApprovalEnabled: false,
    },
    [`preview-rate/device-register/${'D'.repeat(43)}/123.json`]: { schemaVersion: 1, scope: 'device-register', slot: 123, createdAt: 1000 },
  };
}

test('cleanup config is default-deny and requires write preview to be off', () => {
  assert.throws(() => readPreviewFixtureCleanupConfig({}), error => error.code === 'PREVIEW_CLEANUP_DISABLED');
  assert.throws(() => readPreviewFixtureCleanupConfig({
    CLOUD_PREVIEW_CLEANUP_ENABLED: '1', CLOUD_WRITE_PREVIEW_ENABLED: '1', CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1', CLOUD_PREVIEW_CLEANUP_KEY: 'x'.repeat(32),
  }), error => error.code === 'PREVIEW_WRITE_MUST_BE_DISABLED');
});

test('inspection accepts only known synthetic keys and uses strong reads', async () => {
  const store = new FakeStore(fixtureEntries());
  const result = await inspectPreviewFixtureObjects(store);
  assert.equal(result.objectCount, 4);
  assert.deepEqual(result.counts, { deviceProfile: 1, tokenIndex: 1, pendingSubmission: 1, rateSlot: 1 });
  assert.match(result.manifestDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(store.calls.some(call => call[0] === 'list' && call[1].consistency === 'strong'));
  assert.ok(store.calls.filter(call => call[0] === 'get').every(call => call[2].consistency === 'strong'));
});

test('unknown or formal-looking object aborts before any deletion', async () => {
  const store = new FakeStore({ ...fixtureEntries(), 'libraries/lib_xiacijian_regular/current.json': { formal: true } });
  await assert.rejects(() => inspectPreviewFixtureObjects(store), error => error instanceof PreviewFixtureCleanupError && error.code === 'PREVIEW_CLEANUP_UNKNOWN_KEY');
  assert.equal(store.calls.some(call => call[0] === 'delete'), false);
});

test('execute requires an unchanged dry-run digest and exact confirmation', async () => {
  const store = new FakeStore(fixtureEntries());
  const inspected = await inspectPreviewFixtureObjects(store);
  await assert.rejects(() => runPreviewFixtureCleanup({ store, expectedDigest: 'wrong', confirmation: CLEANUP_CONFIRMATION }), error => error.code === 'PREVIEW_CLEANUP_MANIFEST_CHANGED');
  assert.equal(store.items.size, 4);
  await assert.rejects(() => runPreviewFixtureCleanup({ store, expectedDigest: inspected.manifestDigest, confirmation: 'wrong' }), error => error.code === 'PREVIEW_CLEANUP_CONFIRMATION_REQUIRED');
  assert.equal(store.items.size, 4);
});

test('execute deletes the exact inspected synthetic set and verifies empty', async () => {
  const store = new FakeStore(fixtureEntries());
  const inspected = await inspectPreviewFixtureObjects(store);
  const result = await runPreviewFixtureCleanup({ store, expectedDigest: inspected.manifestDigest, confirmation: CLEANUP_CONFIRMATION });
  assert.deepEqual(result, { schemaVersion: 1, storeName: 'cloud-collab-preview-v1', deletedCount: 4, verifiedEmpty: true });
  assert.equal(store.items.size, 0);
  assert.equal(store.calls.filter(call => call[0] === 'delete').length, 4);
});
