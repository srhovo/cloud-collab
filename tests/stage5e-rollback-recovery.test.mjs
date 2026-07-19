import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ADMIN_ROLLBACK_ALLOWED_GROUP_ID,
  ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID,
  ADMIN_ROLLBACK_CONFIRMATION,
  ADMIN_ROLLBACK_PREVIEW_STORE_NAME,
  executeAdminRollback,
  listAdminRollbackCandidates,
  readAdminRollbackConfig,
} from '../src/server/admin_rollback_v1.js';
import {
  approvalIndexKey,
  buildPublicSnapshot,
  publicEventKey,
} from '../src/server/auto_approval_engine_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';

const NOW = 1_784_450_000_000;
const GROUP_ID = ADMIN_ROLLBACK_ALLOWED_GROUP_ID;
const LIBRARY_ID = ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID;
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';
const IDENTITY = Object.freeze({
  username: 'recovery-admin@example.test',
  sessionIdSuffix: '5ER1',
  expiresAt: NOW + 900_000,
});
const ENV = Object.freeze({
  CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME: ADMIN_ROLLBACK_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID: GROUP_ID,
  CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID: LIBRARY_ID,
  CLOUD_ADMIN_ROLLBACK_REF_SALT: 'stage5e-recovery-ref-salt-01234567890123',
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '0',
});

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.failAuditOnce = false;
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (this.failAuditOnce && key.startsWith('audit/')) {
      this.failAuditOnce = false;
      const error = new Error('synthetic audit interruption');
      error.code = 'SYNTHETIC_INTERRUPTION';
      throw error;
    }
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function digest(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hashes(payload) {
  const businessKey = `bk_v1_${digest(canonicalize({
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    normalizedServiceName: payload.serviceName.toLowerCase(),
    settleType: payload.settleType,
    ruleType: 'exact',
    variant: 'standard',
  }))}`;
  const contentHash = `ch_v1_${digest(canonicalize({
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
  }))}`;
  return { businessKey, contentHash };
}

async function putEvent(store, { version, payload, baseline, label, deviceId, submissionId }) {
  const { businessKey, contentHash } = hashes(payload);
  const approvalId = `ap_v1_${digest(label)}`;
  const eventKey = publicEventKey(LIBRARY_ID, version);
  const approvedAt = NOW + version * 1000;
  const event = {
    schemaVersion: 1,
    version,
    eventKey,
    approvalId,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    approvedAt: new Date(approvedAt).toISOString(),
    businessKey,
    contentHash,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
    baseline,
    approval: {
      mode: 'admin_approved',
      deviceIds: [deviceId],
      submissionIds: [submissionId],
    },
  };
  await store.setJSON(eventKey, event);
  await store.setJSON(approvalIndexKey(LIBRARY_ID, approvalId), {
    schemaVersion: 1,
    approvalId,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey,
    contentHash,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    version,
    eventKey,
    createdAt: approvedAt,
  });
  return event;
}

async function seed(store) {
  const firstPayload = { serviceName: '恢复测试', settleType: 'round', unitPrice: 100 };
  const secondPayload = { serviceName: '恢复测试', settleType: 'round', unitPrice: 120 };
  const first = await putEvent(store, {
    version: 1,
    payload: firstPayload,
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: 'recovery-first',
    deviceId: DEVICE_A,
    submissionId: SUBMISSION_A,
  });
  await putEvent(store, {
    version: 2,
    payload: secondPayload,
    baseline: { approvedVersion: 1, contentHash: first.contentHash, unitPrice: 100 },
    label: 'recovery-second',
    deviceId: DEVICE_B,
    submissionId: SUBMISSION_B,
  });
}

function command(rollbackRef, suffix) {
  return {
    schemaVersion: 1,
    rollbackRef,
    requestId: `rbrq_v1_${suffix.padEnd(22, 'A')}`,
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  };
}

function count(store, prefix) {
  return [...store.values.keys()].filter(key => key.startsWith(prefix)).length;
}

test('Stage5E concurrent identical claims converge to one effective immutable rollback chain', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  await seed(store);
  const listed = await listAdminRollbackCandidates({ store, config });
  const input = command(listed.candidates[0].rollbackRef, 'CONCURRENT');

  const results = await Promise.all([
    executeAdminRollback({ store, config, identity: IDENTITY, command: input, now: NOW + 5000 }),
    executeAdminRollback({ store, config, identity: IDENTITY, command: input, now: NOW + 5001 }),
  ]);

  assert.deepEqual(results.map(item => item.publicVersion), [3, 3]);
  assert.deepEqual(results.map(item => item.eventVersion), [3, 3]);
  const snapshot = await buildPublicSnapshot({ store, groupId: GROUP_ID, libraryId: LIBRARY_ID, now: NOW + 6000 });
  assert.equal(snapshot.publicVersion, 3);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].payload.unitPrice, 100);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/requests/`), 1);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/decisions/`), 1);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/completions/`), 1);
  assert.equal(count(store, 'audit/'), 1);
});

test('Stage5E resumes after public mutation when the private audit write is interrupted', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminRollbackConfig(ENV);
  await seed(store);
  const listed = await listAdminRollbackCandidates({ store, config });
  const input = command(listed.candidates[0].rollbackRef, 'INTERRUPTED');
  store.failAuditOnce = true;

  await assert.rejects(
    () => executeAdminRollback({ store, config, identity: IDENTITY, command: input, now: NOW + 5000 }),
  );
  assert.equal(count(store, `public/${LIBRARY_ID}/events/`), 3);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/requests/`), 1);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/decisions/`), 1);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/completions/`), 0);

  const recovered = await executeAdminRollback({
    store,
    config,
    identity: IDENTITY,
    command: input,
    now: NOW + 9000,
  });
  assert.equal(recovered.publicVersion, 3);
  assert.equal(recovered.eventVersion, 3);
  assert.equal(recovered.restoredUnitPrice, 100);
  assert.equal(count(store, `public/${LIBRARY_ID}/events/`), 3);
  assert.equal(count(store, 'audit/'), 1);
  assert.equal(count(store, `rollbacks/${LIBRARY_ID}/completions/`), 1);

  const replay = await executeAdminRollback({
    store,
    config,
    identity: IDENTITY,
    command: input,
    now: NOW + 10_000,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.publicVersion, 3);
});
