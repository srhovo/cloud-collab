import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAGE5BC_CLEANUP_CONFIRMATION,
  cleanupStage5bcObjects,
  inspectStage5bcObjects,
  readStage5bcCleanupConfig,
} from '../src/server/stage5bc_cleanup_v1.js';
import { handleStage5bcCleanupRequest } from '../src/server/stage5bc_cleanup_http_v1.js';

const CLEANUP_KEY = 'stage5bc-cleanup-key-012345678901234';
const H = 'A'.repeat(43);
const V = '000000000001';
const ENV = Object.freeze({
  CLOUD_STAGE5BC_ACCEPTANCE_ENABLED: '0',
  CLOUD_STAGE5BC_CLEANUP_ENABLED: '1',
  CLOUD_STAGE5BC_CLEANUP_CONFIRMATION: STAGE5BC_CLEANUP_CONFIRMATION,
  CLOUD_STAGE5BC_CLEANUP_KEY: CLEANUP_KEY,
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_KEY: 'retired-stage5bc-preview-key-012345678',
  CLOUD_RATE_LIMIT_SALT: 'retired-stage5bc-public-salt-01234567',
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_PASSWORD: 'retired-admin-password-123456',
  CLOUD_ADMIN_SESSION_SECRET: 'retired-admin-session-secret-01234567',
  CLOUD_ADMIN_RATE_LIMIT_SALT: 'retired-admin-rate-salt-01234567890',
  CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
});

class MemoryStore {
  constructor(keys = []) {
    this.keys = new Set(keys);
    this.deleted = [];
    this.lists = [];
  }
  async list(options = {}) {
    this.lists.push({ ...options });
    return { blobs: [...this.keys].sort().map(key => ({ key })) };
  }
  async delete(key) {
    this.deleted.push(key);
    this.keys.delete(key);
  }
}

function publicKeys() {
  const device = 'dev_01JABCDEF0123456789XYZABCD';
  return [
    `devices/profiles/${device}.json`,
    `devices/token-index/dth_v1_${H}.json`,
    `submissions/lib_receive_fixture/pending/ik_v1_${H}.json`,
    `submissions/lib_receive_fixture/matches/bk_v1_${H}/pv_${V}/ch_v1_${H}/${device}.json`,
    `reviews/lib_receive_fixture/pending/bk_v1_${H}/pv_${V}/ch_v1_${H}.json`,
    `reviews/lib_receive_fixture/resolved/rv_v1_${H}.json`,
    `reviews/lib_receive_fixture/decisions/rv_v1_${H}.json`,
    `reviews/lib_receive_fixture/completions/rv_v1_${H}.json`,
    `reviews/lib_receive_fixture/approval-cycles/bk_v1_${H}/pv_${V}.json`,
    `audit/2026/07/au_v1_${H}.json`,
    `public/lib_receive_fixture/events/${V}.json`,
    `public/lib_receive_fixture/snapshots/${V}.json`,
    `public/lib_receive_fixture/approvals/ap_v1_${H}.json`,
    `public/lib_receive_fixture/transitions/bk_v1_${H}/${V}.json`,
    `preview-rate/submission-create/${H}/123.json`,
  ];
}

function adminKeys() {
  return [`admin-preview-rate/login/${H}/123.json`];
}

function cleanupRequest(body, { key = CLEANUP_KEY, origin = 'https://stage5bc.test' } = {}) {
  return new Request('https://stage5bc.test/api/stage5bc/cleanup', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'X-Cloud-Stage5bc-Cleanup-Key': key,
    },
    body: JSON.stringify(body),
  });
}

test('Stage5BC cleanup is default-off, mutually exclusive with every capability, hard-locked, and uses an independent key', () => {
  assert.throws(() => readStage5bcCleanupConfig({}), error => error.code === 'STAGE5BC_CLEANUP_DISABLED');
  assert.throws(
    () => readStage5bcCleanupConfig({ ...ENV, CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1' }),
    error => error.code === 'STAGE5BC_CLEANUP_REQUIRES_ALL_CAPABILITIES_CLOSED',
  );
  assert.throws(
    () => readStage5bcCleanupConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'formal-prices' }),
    error => error.code === 'STAGE5BC_CLEANUP_SCOPE_INVALID',
  );
  assert.throws(
    () => readStage5bcCleanupConfig({ ...ENV, CLOUD_STAGE5BC_CLEANUP_KEY: ENV.CLOUD_ADMIN_SESSION_SECRET }),
    error => error.code === 'STAGE5BC_CLEANUP_KEY_REUSED',
  );
  const config = readStage5bcCleanupConfig(ENV);
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.equal(config.adminStoreName, 'cloud-collab-admin-preview-v1');
});

test('Stage5BC cleanup recognizes every Stage4-to-Stage5C synthetic object family and deletes both stores to zero', async () => {
  const publicStore = new MemoryStore(publicKeys());
  const adminStore = new MemoryStore(adminKeys());
  const inspection = await inspectStage5bcObjects({ publicStore, adminStore });
  assert.equal(inspection.publicObjectCount, publicKeys().length);
  assert.equal(inspection.adminObjectCount, 1);
  assert.equal(inspection.totalObjectCount, publicKeys().length + 1);
  assert.equal(publicStore.lists.every(item => item.consistency === 'strong'), true);
  assert.equal(adminStore.lists.every(item => item.consistency === 'strong'), true);
  const result = await cleanupStage5bcObjects({
    publicStore,
    adminStore,
    expectedPublicKeySetDigest: inspection.publicKeySetDigest,
    expectedAdminKeySetDigest: inspection.adminKeySetDigest,
  });
  assert.equal(result.completed, true);
  assert.equal(result.deletedObjectCount, publicKeys().length + 1);
  assert.equal(result.remainingObjectCount, 0);
  assert.equal(publicStore.keys.size, 0);
  assert.equal(adminStore.keys.size, 0);
  const verification = await inspectStage5bcObjects({ publicStore, adminStore });
  assert.equal(verification.totalObjectCount, 0);
});

test('Stage5BC cleanup fails before the first delete on unsafe keys or either digest changing', async () => {
  const unsafePublic = new MemoryStore([...publicKeys(), 'formal/users/price.json']);
  const adminStore = new MemoryStore(adminKeys());
  await assert.rejects(
    () => inspectStage5bcObjects({ publicStore: unsafePublic, adminStore }),
    error => error.code === 'STAGE5BC_CLEANUP_UNSAFE_OBJECTS' && error.details.unsafeCount === 1,
  );
  assert.equal(unsafePublic.deleted.length, 0);
  assert.equal(adminStore.deleted.length, 0);

  const publicStore = new MemoryStore(publicKeys());
  const safeAdmin = new MemoryStore(adminKeys());
  const inspection = await inspectStage5bcObjects({ publicStore, adminStore: safeAdmin });
  safeAdmin.keys.add(`admin-preview-rate/login/${'B'.repeat(43)}/124.json`);
  await assert.rejects(
    () => cleanupStage5bcObjects({
      publicStore,
      adminStore: safeAdmin,
      expectedPublicKeySetDigest: inspection.publicKeySetDigest,
      expectedAdminKeySetDigest: inspection.adminKeySetDigest,
    }),
    error => error.code === 'STAGE5BC_CLEANUP_KEYSET_CHANGED',
  );
  assert.equal(publicStore.deleted.length, 0);
  assert.equal(safeAdmin.deleted.length, 0);
});

test('Stage5BC cleanup HTTP requires same-origin HTTPS, exact key and two-phase summaries', async () => {
  const publicStore = new MemoryStore(publicKeys().slice(0, 2));
  const adminStore = new MemoryStore(adminKeys());
  const createStore = env => env.CLOUD_BLOB_STORE_NAME === 'cloud-collab-preview-v1' ? publicStore : adminStore;
  const inspectBody = { schemaVersion: 1, action: 'inspect', confirmation: STAGE5BC_CLEANUP_CONFIRMATION };

  const denied = await handleStage5bcCleanupRequest({ request: cleanupRequest(inspectBody, { key: `${CLEANUP_KEY}x` }), env: ENV }, { createStore });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'STAGE5BC_CLEANUP_ACCESS_DENIED');

  const crossOrigin = await handleStage5bcCleanupRequest({ request: cleanupRequest(inspectBody, { origin: 'https://evil.test' }), env: ENV }, { createStore });
  assert.equal(crossOrigin.status, 403);

  const inspected = await handleStage5bcCleanupRequest({ request: cleanupRequest(inspectBody), env: ENV }, { createStore });
  const inspectedPayload = await inspected.json();
  assert.equal(inspected.status, 200);
  assert.equal(inspectedPayload.data.cleanupOnly, true);
  assert.equal(inspectedPayload.data.totalObjectCount, 3);

  const executeBody = {
    schemaVersion: 1,
    action: 'execute',
    confirmation: STAGE5BC_CLEANUP_CONFIRMATION,
    expectedPublicKeySetDigest: inspectedPayload.data.publicKeySetDigest,
    expectedAdminKeySetDigest: inspectedPayload.data.adminKeySetDigest,
  };
  const executed = await handleStage5bcCleanupRequest({ request: cleanupRequest(executeBody), env: ENV }, { createStore });
  const executedPayload = await executed.json();
  assert.equal(executed.status, 200);
  assert.equal(executedPayload.data.remainingObjectCount, 0);
  assert.equal(executedPayload.data.publicMutationAllowed, false);
  assert.equal(executedPayload.data.reviewMutationAllowed, false);
});
