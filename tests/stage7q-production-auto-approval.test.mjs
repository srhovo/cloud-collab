import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  listValidPublicEvents,
  trustedDeviceKey,
} from '../src/server/auto_approval_v1.js';
import { pendingSubmissionKey } from '../src/server/blob_repository_v1.js';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';
import {
  ProductionWriteRuntimeError,
  acceptProductionExactSubmission,
} from '../src/server/production_write_runtime_v1.js';
import { handleProductionSubmissionCreateRequest } from '../src/server/production_write_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_590_000_000;
const ACCESS_KEY = 'stage7q-production-access-key-0123456789abcdef';
const RATE_SALT = 'stage7q-production-rate-salt-0123456789abcdef';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: ACCESS_KEY,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: RATE_SALT,
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

class MemoryStore {
  constructor() {
    this.items = new Map();
    this.reads = [];
    this.writes = [];
    this.lists = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key, options = {}) {
    this.reads.push({ key, options: this.clone(options) });
    return this.items.has(key) ? this.clone(this.items.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: this.clone(options) });
    if (options.onlyIfNew && this.items.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.items.set(key, this.clone(value));
  }

  async delete(key) {
    this.items.delete(key);
  }

  async list(options = {}) {
    this.lists.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.items.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key, etag: `etag-${key.length}` })),
    };
  }
}

function makeSubmission({
  deviceId = DEVICE_A,
  submissionId = SUBMISSION_A,
  serviceName = '测试服务A',
  unitPrice = 100,
} = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_see',
    libraryId: 'lib_see_cz',
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: NOW,
    businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
    contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload: { serviceName, settleType: 'round', unitPrice },
    clientContext: { appVersion: '8.2.31', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const hashes = computeSubmissionHashes(value);
  value.businessKey = hashes.businessKey;
  value.contentHash = hashes.contentHash;
  value.idempotencyKey = hashes.idempotencyKey;
  return value;
}

function identityFor(submission) {
  return async () => ({ deviceId: submission.deviceId, tokenVersion: 1 });
}

function post(submission) {
  return new Request('https://app.example.invalid/api/submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Access-Key': ACCESS_KEY,
      Authorization: 'Bearer dt_v1_production',
      Origin: 'https://app.example.invalid',
    },
    body: JSON.stringify(submission),
  });
}

async function trust(store, deviceId) {
  await store.setJSON(trustedDeviceKey(deviceId), {
    schemaVersion: 1,
    deviceId,
    trusted: true,
    trustedAt: NOW - 1000,
    revokedAt: null,
  });
}

test('正式自动审核复用不可变候选并让普通设备等待第二台确认', async () => {
  const store = new MemoryStore();
  const submission = makeSubmission();
  const result = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_production',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: identityFor(submission),
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.autoApprovalEnabled, true);
  assert.equal(result.publicMutationAllowed, true);
  assert.equal(result.publicMutationApplied, false);
  assert.equal(result.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(result.autoApprovalResult.reason, 'second_device_required');
  assert.equal(result.autoApprovalResult.matchingDistinctDeviceCount, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: submission.libraryId })).length, 0);
  assert.ok(await store.get(pendingSubmissionKey(submission.libraryId, submission.idempotencyKey)));
  assert.ok(store.lists.every(item => item.consistency === 'strong'));
});

test('可信设备在正式链自动批准一次，精确重放不创建第二个公共事件', async () => {
  const store = new MemoryStore();
  const submission = makeSubmission();
  await trust(store, submission.deviceId);

  const first = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_production',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: identityFor(submission),
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.autoApprovalResult.status, 'auto_approved');
  assert.equal(first.autoApprovalResult.approvalMode, 'trusted_device');
  assert.equal(first.publicMutationAllowed, true);
  assert.equal(first.publicMutationApplied, true);
  assert.equal(first.autoApprovalResult.eventVersion, 1);
  assert.equal((await listValidPublicEvents({ store, libraryId: submission.libraryId })).length, 1);

  const replay = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_production',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: identityFor(submission),
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.autoApprovalResult.status, 'auto_approved');
  assert.equal(replay.autoApprovalResult.decision, 'duplicate_noop');
  assert.equal(replay.publicMutationApplied, false);
  assert.equal((await listValidPublicEvents({ store, libraryId: submission.libraryId })).length, 1);
});

test('两个普通设备提交相同新值时第二台正式提交发布唯一公共事件', async () => {
  const store = new MemoryStore();
  const firstSubmission = makeSubmission({ deviceId: DEVICE_A, submissionId: SUBMISSION_A });
  const secondSubmission = makeSubmission({ deviceId: DEVICE_B, submissionId: SUBMISSION_B });

  const first = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_a',
    rawSubmission: firstSubmission,
    env: env(),
    now: NOW,
    authenticate: identityFor(firstSubmission),
  });
  const second = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_b',
    rawSubmission: secondSubmission,
    env: env(),
    now: NOW + 6000,
    authenticate: identityFor(secondSubmission),
  });

  assert.equal(first.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(second.autoApprovalResult.status, 'auto_approved');
  assert.equal(second.autoApprovalResult.approvalMode, 'two_devices_match');
  assert.equal(second.autoApprovalResult.matchingDistinctDeviceCount, 2);
  assert.equal(second.publicMutationApplied, true);
  const events = await listValidPublicEvents({ store, libraryId: firstSubmission.libraryId });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].approval.deviceIds, [DEVICE_A, DEVICE_B]);
});

test('审核暂时失败后候选仍可通过同一幂等请求恢复，不被既有限流槽阻断', async () => {
  const store = new MemoryStore();
  const submission = makeSubmission();
  await assert.rejects(
    () => acceptProductionExactSubmission({
      store,
      authorization: 'Bearer dt_v1_production',
      rawSubmission: submission,
      env: env(),
      now: NOW,
      authenticate: identityFor(submission),
      review: async () => {
        const error = new Error('temporary review outage');
        error.code = 'TEMPORARY_REVIEW_OUTAGE';
        error.status = 503;
        throw error;
      },
    }),
    error => error.code === 'TEMPORARY_REVIEW_OUTAGE',
  );
  assert.ok(await store.get(pendingSubmissionKey(submission.libraryId, submission.idempotencyKey)));

  const recovered = await acceptProductionExactSubmission({
    store,
    authorization: 'Bearer dt_v1_production',
    rawSubmission: submission,
    env: env(),
    now: NOW,
    authenticate: identityFor(submission),
  });
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.autoApprovalResult.status, 'waiting_confirmation');
  assert.equal(recovered.publicMutationApplied, false);
});

test('候选接收器未持久化对象时正式自动审核失败关闭', async () => {
  const store = new MemoryStore();
  const submission = makeSubmission();
  await assert.rejects(
    () => acceptProductionExactSubmission({
      store,
      authorization: 'Bearer dt_v1_production',
      rawSubmission: submission,
      env: env(),
      now: NOW,
      authenticate: identityFor(submission),
      accept: async () => ({ submissionId: submission.submissionId, duplicate: false }),
    }),
    error => error instanceof ProductionWriteRuntimeError
      && error.code === 'PRODUCTION_CANDIDATE_NOT_FOUND_AFTER_ACCEPT'
      && error.status === 503,
  );
});

test('正式HTTP在自动批准完成时返回200并明确是否发生公共修改', async () => {
  const submission = makeSubmission();
  const response = await handleProductionSubmissionCreateRequest({
    env: env(),
    request: post(submission),
  }, {
    createStore: () => new MemoryStore(),
    acceptProduction: async () => ({
      submissionId: submission.submissionId,
      duplicate: false,
      publicMutationAllowed: true,
      publicMutationApplied: true,
      autoApprovalEnabled: true,
      autoApprovalResult: { status: 'auto_approved', eventVersion: 1 },
      stablePromotionAuthorized: false,
    }),
    now: () => NOW,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  const body = await response.json();
  assert.equal(body.data.publicMutationAllowed, true);
  assert.equal(body.data.publicMutationApplied, true);
  assert.equal(body.data.autoApprovalEnabled, true);
  assert.equal(body.data.autoApprovalResult.eventVersion, 1);
  assert.equal(body.data.stablePromotionAuthorized, false);
});

test('阶段7Q只复用既有审核引擎且不引入稳定晋升或独立密钥', () => {
  const runtimeSource = fs.readFileSync(path.join(root, 'src/server/production_write_runtime_v1.js'), 'utf8');
  const httpSource = fs.readFileSync(path.join(root, 'src/server/production_write_http_v1.js'), 'utf8');
  assert.match(runtimeSource, /reviewExactPriceCandidate/u);
  assert.match(runtimeSource, /pendingSubmissionKey/u);
  assert.doesNotMatch(runtimeSource, /stablePromotionAuthorized:\s*true/u);
  assert.doesNotMatch(httpSource, /stablePromotionAuthorized:\s*true/u);
  assert.doesNotMatch(`${runtimeSource}\n${httpSource}`, /AUTO_APPROVAL_SECRET|AUTO_APPROVAL_PASSWORD/u);
  assert.doesNotMatch(httpSource, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/u);
});
