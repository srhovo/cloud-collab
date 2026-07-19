import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAGE5DEF_CLEANUP_CONFIRMATION,
  cleanupStage5defObjects,
  inspectStage5defObjects,
  readStage5defCleanupConfig,
} from '../src/server/stage5def_cleanup_v1.js';
import { handleStage5defCleanupRequest } from '../src/server/stage5def_cleanup_http_v1.js';

const KEY = 'stage5def-cleanup-key-012345678901234567';
const ORIGIN = 'https://stage5def-cleanup.test';
const HASH = 'A'.repeat(43);
const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
const VERSION = '000000000001';

const ENV = Object.freeze({
  CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED: '0',
  CLOUD_STAGE5DEF_CLEANUP_ENABLED: '1',
  CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION: STAGE5DEF_CLEANUP_CONFIRMATION,
  CLOUD_STAGE5DEF_CLEANUP_KEY: KEY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_PUBLIC_ORIGIN: ORIGIN,
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
  CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
});

class MemoryBlobStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.deleted = [];
  }

  async get(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async setJSON(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.deleted.push(key);
    this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function validPublicEntries() {
  return {
    'stage5def/seed/v1.json': { schemaVersion: 1 },
    [`devices/profiles/${DEVICE}.json`]: { schemaVersion: 1 },
    [`devices/token-index/dth_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`devices/governance/heads/${DEVICE}.json`]: { schemaVersion: 1 },
    [`devices/governance/events/${DEVICE}/${VERSION}-dge_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`devices/governance/transitions/${DEVICE}/${VERSION}.json`]: { schemaVersion: 1 },
    [`devices/governance/requests/dgrh_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`public/lib_receive_fixture/events/${VERSION}.json`]: { schemaVersion: 1 },
    [`public/lib_receive_fixture/snapshots/${VERSION}.json`]: { schemaVersion: 1 },
    [`public/lib_receive_fixture/approvals/ap_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`public/lib_receive_fixture/transitions/bk_v1_${HASH}/${VERSION}.json`]: { schemaVersion: 1 },
    [`rollbacks/lib_receive_fixture/requests/rbtok_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`rollbacks/lib_receive_fixture/decisions/rb_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`rollbacks/lib_receive_fixture/completions/rb_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`exports/lib_receive_fixture/requests/extok_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`exports/lib_receive_fixture/decisions/ex_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`audit/2026/07/dge_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`audit/2026/07/rbau_v1_${HASH}.json`]: { schemaVersion: 1 },
    [`audit/2026/07/exau_v1_${HASH}.json`]: { schemaVersion: 1 },
  };
}

function validAdminEntries() {
  return {
    [`admin-preview-rate/login/${HASH}/178450000.json`]: { schemaVersion: 1 },
  };
}

test('Stage5DEF cleanup defaults closed, requires every capability closed, and prevents key reuse', () => {
  assert.throws(
    () => readStage5defCleanupConfig({}),
    error => error.code === 'STAGE5DEF_CLEANUP_DISABLED',
  );
  assert.throws(
    () => readStage5defCleanupConfig({ ...ENV, CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED: '1' }),
    error => error.code === 'STAGE5DEF_CLEANUP_REQUIRES_ALL_CAPABILITIES_CLOSED',
  );
  assert.throws(
    () => readStage5defCleanupConfig({ ...ENV, CLOUD_STAGE5DEF_ACCEPTANCE_KEY: KEY }),
    error => error.code === 'STAGE5DEF_CLEANUP_KEY_REUSED',
  );
  const config = readStage5defCleanupConfig(ENV);
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.equal(config.adminStoreName, 'cloud-collab-admin-preview-v1');
});

test('Stage5DEF cleanup inspects exact whitelist, rejects changed digest, deletes both stores, and rechecks zero', async () => {
  const publicStore = new MemoryBlobStore(validPublicEntries());
  const adminStore = new MemoryBlobStore(validAdminEntries());
  const inspected = await inspectStage5defObjects({ publicStore, adminStore });
  assert.equal(inspected.publicObjectCount, 19);
  assert.equal(inspected.adminObjectCount, 1);
  assert.equal(inspected.readyToExecute, true);

  await assert.rejects(
    () => cleanupStage5defObjects({
      publicStore,
      adminStore,
      expectedPublicKeySetDigest: 'B'.repeat(43),
      expectedAdminKeySetDigest: inspected.adminKeySetDigest,
    }),
    error => error.code === 'STAGE5DEF_CLEANUP_KEYSET_CHANGED',
  );
  assert.equal(publicStore.values.size, 19);
  assert.equal(adminStore.values.size, 1);

  const cleaned = await cleanupStage5defObjects({
    publicStore,
    adminStore,
    expectedPublicKeySetDigest: inspected.publicKeySetDigest,
    expectedAdminKeySetDigest: inspected.adminKeySetDigest,
  });
  assert.equal(cleaned.publicDeletedCount, 19);
  assert.equal(cleaned.adminDeletedCount, 1);
  assert.equal(cleaned.cleanupComplete, true);
  assert.equal(publicStore.values.size, 0);
  assert.equal(adminStore.values.size, 0);
  const second = await inspectStage5defObjects({ publicStore, adminStore });
  assert.equal(second.totalObjectCount, 0);
});

test('Stage5DEF cleanup fails closed before deletion when an unknown key exists', async () => {
  const publicStore = new MemoryBlobStore({
    ...validPublicEntries(),
    'formal/private/customer.json': { forbidden: true },
  });
  const adminStore = new MemoryBlobStore(validAdminEntries());
  await assert.rejects(
    () => inspectStage5defObjects({ publicStore, adminStore }),
    error => error.code === 'STAGE5DEF_CLEANUP_UNSAFE_OBJECTS' && error.status === 409,
  );
  assert.equal(publicStore.deleted.length, 0);
  assert.equal(adminStore.deleted.length, 0);
});

test('Stage5DEF cleanup HTTP requires same-origin key and exact inspect/execute bodies', async () => {
  const publicStore = new MemoryBlobStore(validPublicEntries());
  const adminStore = new MemoryBlobStore(validAdminEntries());
  const createStore = env => String(env.CLOUD_BLOB_STORE_NAME) === 'cloud-collab-admin-preview-v1'
    ? adminStore
    : publicStore;
  const request = body => new Request('http://stage5def-cleanup.test/api/stage5def/cleanup', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'x-cloud-stage5def-cleanup-key': KEY,
    },
    body: JSON.stringify(body),
  });
  const inspectResponse = await handleStage5defCleanupRequest({
    request: request({ schemaVersion: 1, action: 'inspect', confirmation: STAGE5DEF_CLEANUP_CONFIRMATION }),
    env: ENV,
  }, { createStore });
  assert.equal(inspectResponse.status, 200);
  const inspectPayload = await inspectResponse.json();
  assert.equal(inspectPayload.ok, true);

  const denied = await handleStage5defCleanupRequest({
    request: new Request('http://stage5def-cleanup.test/api/stage5def/cleanup', {
      method: 'POST',
      headers: {
        Origin: 'https://other-project.test',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
        'x-cloud-stage5def-cleanup-key': KEY,
      },
      body: JSON.stringify({ schemaVersion: 1, action: 'inspect', confirmation: STAGE5DEF_CLEANUP_CONFIRMATION }),
    }),
    env: ENV,
  }, { createStore });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');
});
