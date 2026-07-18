import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlobRepositoryError,
  putJSONOnlyIfNew,
} from '../src/server/blob_repository_v1.js';

class RaceStore {
  constructor({ createDuringFailure = true, readFailsAfterWrite = false } = {}) {
    this.value = null;
    this.createDuringFailure = createDuringFailure;
    this.readFailsAfterWrite = readFailsAfterWrite;
    this.setAttempts = 0;
    this.reads = 0;
  }

  async get() {
    this.reads += 1;
    if (this.readFailsAfterWrite && this.setAttempts > 0) {
      throw new Error('read failed');
    }
    return this.value === null ? null : JSON.parse(JSON.stringify(this.value));
  }

  async setJSON(_key, value, options = {}) {
    this.setAttempts += 1;
    assert.equal(options.onlyIfNew, true);
    if (this.createDuringFailure) this.value = JSON.parse(JSON.stringify(value));
    const error = new Error('platform onlyIfNew conflict');
    error.code = 'ALREADY_EXISTS';
    throw error;
  }

  async delete() {
    this.value = null;
  }
}

test('platform onlyIfNew race is normalized to BLOB_ALREADY_EXISTS after strong reread', async () => {
  const store = new RaceStore({ createDuringFailure: true });
  await assert.rejects(
    putJSONOnlyIfNew(store, 'race/object.json', { schemaVersion: 1, value: 7 }),
    error => error instanceof BlobRepositoryError
      && error.code === 'BLOB_ALREADY_EXISTS'
      && error.details?.key === 'race/object.json',
  );
  assert.deepEqual(store.value, { schemaVersion: 1, value: 7 });
  assert.equal(store.reads, 2);
});

test('real onlyIfNew storage failure remains BLOB_ONLY_IF_NEW_FAILED when no object appeared', async () => {
  const store = new RaceStore({ createDuringFailure: false });
  await assert.rejects(
    putJSONOnlyIfNew(store, 'race/object.json', { schemaVersion: 1, value: 7 }),
    error => error instanceof BlobRepositoryError
      && error.code === 'BLOB_ONLY_IF_NEW_FAILED'
      && error.details?.key === 'race/object.json',
  );
  assert.equal(store.value, null);
  assert.equal(store.reads, 2);
});

test('failed verification read remains a storage failure rather than a false conflict', async () => {
  const store = new RaceStore({ createDuringFailure: true, readFailsAfterWrite: true });
  await assert.rejects(
    putJSONOnlyIfNew(store, 'race/object.json', { schemaVersion: 1, value: 7 }),
    error => error instanceof BlobRepositoryError
      && error.code === 'BLOB_ONLY_IF_NEW_FAILED'
      && /无法核验/.test(error.message),
  );
});
