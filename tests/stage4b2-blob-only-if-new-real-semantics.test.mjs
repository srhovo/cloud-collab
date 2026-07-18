import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlobRepositoryError,
  getJSONStrong,
  putJSONOnlyIfNew,
} from '../src/server/blob_repository_v1.js';
import {
  PreviewWriteError,
  consumePreviewRateSlot,
} from '../src/server/preview_write_runtime_v1.js';

class SilentOnlyIfNewBlobStore {
  constructor() {
    this.items = new Map();
    this.getCalls = [];
  }

  async get(key, options = {}) {
    this.getCalls.push({ key, options: { ...options } });
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) return;
    this.items.set(key, structuredClone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }
}

test('putJSONOnlyIfNew detects a silent no-op when the Blob key already exists', async () => {
  const store = new SilentOnlyIfNewBlobStore();
  const key = 'fixtures/only-if-new.json';

  const first = await putJSONOnlyIfNew(store, key, { schemaVersion: 1, owner: 'first' });
  assert.equal(first.created, true);
  assert.deepEqual(await getJSONStrong(store, key), { schemaVersion: 1, owner: 'first' });

  await assert.rejects(
    () => putJSONOnlyIfNew(store, key, { schemaVersion: 1, owner: 'second' }),
    error => error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS',
  );

  assert.deepEqual(await getJSONStrong(store, key), { schemaVersion: 1, owner: 'first' });
  assert.ok(store.getCalls.some(call => call.options?.consistency === 'strong'));
});

test('preview rate limiter returns 429 semantics with a Blob SDK that silently skips duplicate onlyIfNew writes', async () => {
  const store = new SilentOnlyIfNewBlobStore();
  const input = {
    store,
    scope: 'submission-create',
    subject: 'dev_01JABCDEF0123456789XYZABCD',
    salt: 'stage4b2-real-blob-rate-salt-0123456789',
    now: 1_784_380_000_000,
    slotMs: 5_000,
  };

  const first = await consumePreviewRateSlot(input);
  assert.equal(first.allowed, true);

  await assert.rejects(
    () => consumePreviewRateSlot(input),
    error => error instanceof PreviewWriteError
      && error.code === 'PREVIEW_RATE_LIMITED'
      && error.status === 429,
  );
});
