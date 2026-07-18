import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildIdempotencyKey,
  computeSubmissionHashes,
} from '../src/server/submission_policy_v1.js';
import {
  acceptAndReviewPreviewSubmission,
  readPreviewAutoApprovalConfig,
  readPreviewPublicEvents,
  readPreviewPublicSnapshot,
} from '../src/server/preview_auto_approval_runtime_v1.js';
import {
  handlePreviewAutoApprovalSubmissionRequest,
  handlePreviewPublicChangesRequest,
  handlePreviewPublicSnapshotRequest,
  handlePreviewPublicVersionRequest,
} from '../src/server/preview_auto_approval_http_v1.js';

const NOW = 1_784_400_000_000;
const PREVIEW_KEY = 'stage4e-preview-access-key-0123456789012345';
const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_RATE_LIMIT_SALT: 'stage4e-rate-limit-salt-0123456789012345',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
});

const DEVICE_1 = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_2 = 'dev_01JABCDEF0123456789XYZABCE';
const DEVICE_3 = 'dev_01JABCDEF0123456789XYZABCF';

class MemoryBlobStore {
  constructor() { this.items = new Map(); }
  async get(key) {
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.items.has(key)) throw new Error('already exists');
    this.items.set(key, structuredClone(value));
  }
  async delete(key) { this.items.delete(key); }
  async list({ prefix = '' } = {}) {
    return {
      blobs: [...this.items.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeSubmission({
  deviceId,
  submissionId,
  serviceName = '阶段4E测试服务',
  settleType = 'round',
  unitPrice,
  clientCreatedAt,
} = {}) {
  const value = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt,
    businessKey: 'bk_v1_0000000000000000000000000000000000000000000',
    contentHash: 'ch_v1_0000000000000000000000000000000000000000000',
    idempotencyKey: buildIdempotencyKey(deviceId, submissionId),
    payload: { serviceName, settleType, unitPrice },
    clientContext: { appVersion: '8.2.28', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  const hashes = computeSubmissionHashes(value);
  value.businessKey = hashes.businessKey;
  value.contentHash = hashes.contentHash;
  return value;
}

async function submit(store, submission, now) {
  return acceptAndReviewPreviewSubmission({
    store,
    authorization: `Bearer token-for-${submission.deviceId}`,
    rawSubmission: submission,
    env: ENV,
    now,
    authenticate: async () => ({ deviceId: submission.deviceId, tokenVersion: 1 }),
  });
}

function previewRequest(path, { method = 'GET', body = null, key = PREVIEW_KEY, authorization = '' } = {}) {
  const headers = { Accept: 'application/json' };
  if (key !== null) headers['X-Cloud-Collab-Preview-Key'] = key;
  if (authorization) headers.Authorization = authorization;
  if (body !== null) headers['Content-Type'] = 'application/json';
  return new Request(`https://preview.test${path}`, {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseBody(response) {
  return response.status === 204 ? null : response.json();
}

test('stage4E config is double-gated and remains hard-locked to the fixture scope', () => {
  assert.throws(
    () => readPreviewAutoApprovalConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '0' }),
    error => error.code === 'PREVIEW_WRITE_DISABLED',
  );
  assert.throws(
    () => readPreviewAutoApprovalConfig({ ...ENV, CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0' }),
    error => error.code === 'PREVIEW_AUTO_APPROVAL_DISABLED',
  );
  assert.throws(
    () => readPreviewAutoApprovalConfig({ ...ENV, CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_other' }),
    error => error.code === 'PREVIEW_SCOPE_MISCONFIGURED',
  );
  const config = readPreviewAutoApprovalConfig(ENV);
  assert.equal(config.allowedGroupId, 'group_fixture');
  assert.equal(config.allowedLibraryId, 'lib_receive_fixture');
  assert.equal(config.previewAutoApprovalEnabled, true);
});

test('two devices approve a new exact price, duplicate replay is a no-op, and dynamic reads expose only public projection', async () => {
  const store = new MemoryBlobStore();
  const first = makeSubmission({
    deviceId: DEVICE_1,
    submissionId: 'sub_01JABCDEF0123456789XYZABCD',
    unitPrice: 100,
    clientCreatedAt: NOW,
  });
  const second = makeSubmission({
    deviceId: DEVICE_2,
    submissionId: 'sub_01JABCDEF0123456789XYZABCE',
    unitPrice: 100,
    clientCreatedAt: NOW + 1,
  });

  const waiting = await submit(store, first, NOW);
  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(waiting.reason, 'second_device_required');
  assert.equal(waiting.matchingDistinctDeviceCount, 1);
  assert.equal(waiting.previewPublicVersion, 0);
  assert.equal(waiting.previewMutationApplied, false);
  assert.equal(waiting.publicMutationAllowed, false);
  assert.equal(waiting.autoApprovalEnabled, false);

  const approved = await submit(store, second, NOW + 1);
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.reason, 'two_devices_match');
  assert.equal(approved.matchingDistinctDeviceCount, 2);
  assert.equal(approved.previewPublicVersion, 1);
  assert.equal(approved.previewEventVersion, 1);
  assert.equal(approved.previewMutationApplied, true);
  assert.equal(approved.previewAutoApprovalEnabled, true);
  assert.equal(approved.publicMutationAllowed, false);
  assert.equal(approved.autoApprovalEnabled, false);

  const replay = await submit(store, first, NOW + 2);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'auto_approved');
  assert.equal(replay.reason, 'same_as_public');
  assert.equal(replay.previewPublicVersion, 1);
  assert.equal(replay.previewMutationApplied, false);
  assert.equal(replay.previewDuplicateApproval, true);

  const snapshot = await readPreviewPublicSnapshot({
    store,
    env: ENV,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    now: NOW + 3,
  });
  assert.equal(snapshot.publicVersion, 1);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].payload.unitPrice, 100);

  const events = await readPreviewPublicEvents({
    store,
    env: ENV,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].approval.mode, 'two_devices_match');
});

test('safe update needs two devices, over-limit update and conflicting candidates enter review without version mutation', async () => {
  const store = new MemoryBlobStore();
  const initial1 = makeSubmission({ deviceId: DEVICE_1, submissionId: 'sub_01JABCDEF0123456789XYZABCD', unitPrice: 100, clientCreatedAt: NOW });
  const initial2 = makeSubmission({ deviceId: DEVICE_2, submissionId: 'sub_01JABCDEF0123456789XYZABCE', unitPrice: 100, clientCreatedAt: NOW + 1 });
  await submit(store, initial1, NOW);
  await submit(store, initial2, NOW + 1);

  const safe1 = makeSubmission({ deviceId: DEVICE_1, submissionId: 'sub_01JABCDEF0123456789XYZABCG', unitPrice: 110, clientCreatedAt: NOW + 6000 });
  const safe2 = makeSubmission({ deviceId: DEVICE_2, submissionId: 'sub_01JABCDEF0123456789XYZABCH', unitPrice: 110, clientCreatedAt: NOW + 12000 });
  const waiting = await submit(store, safe1, NOW + 6000);
  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(waiting.reason, 'second_device_required_for_update');
  assert.equal(waiting.changeRatio, 0.1);
  assert.equal(waiting.previewPublicVersion, 1);

  const approved = await submit(store, safe2, NOW + 12000);
  assert.equal(approved.status, 'auto_approved');
  assert.equal(approved.reason, 'two_devices_safe_price_update');
  assert.equal(approved.previewPublicVersion, 2);
  assert.equal(approved.previewEventVersion, 2);
  assert.equal(approved.previewMutationApplied, true);

  const overLimit = makeSubmission({ deviceId: DEVICE_3, submissionId: 'sub_01JABCDEF0123456789XYZABCJ', unitPrice: 125, clientCreatedAt: NOW + 18000 });
  const reviewed = await submit(store, overLimit, NOW + 18000);
  assert.equal(reviewed.status, 'pending_review');
  assert.equal(reviewed.reason, 'price_change_exceeds_limit');
  assert.ok(reviewed.changeRatio > 0.1);
  assert.equal(reviewed.previewPublicVersion, 2);
  assert.equal(reviewed.previewMutationApplied, false);

  const candidateA = makeSubmission({
    deviceId: DEVICE_1,
    submissionId: 'sub_01JABCDEF0123456789XYZABCK',
    serviceName: '阶段4E冲突服务',
    unitPrice: 50,
    clientCreatedAt: NOW + 24000,
  });
  const candidateB = makeSubmission({
    deviceId: DEVICE_2,
    submissionId: 'sub_01JABCDEF0123456789XYZABCM',
    serviceName: '阶段4E冲突服务',
    unitPrice: 51,
    clientCreatedAt: NOW + 30000,
  });
  const candidateAResult = await submit(store, candidateA, NOW + 24000);
  assert.equal(candidateAResult.status, 'waiting_confirmation');
  const conflict = await submit(store, candidateB, NOW + 30000);
  assert.equal(conflict.status, 'pending_review');
  assert.equal(conflict.reason, 'candidate_conflict');
  assert.equal(conflict.conflictingCandidateCount, 1);
  assert.equal(conflict.previewPublicVersion, 2);

  const snapshot = await readPreviewPublicSnapshot({ store, env: ENV, groupId: 'group_fixture', libraryId: 'lib_receive_fixture', now: NOW + 30001 });
  assert.equal(snapshot.publicVersion, 2);
  assert.equal(snapshot.records[0].payload.unitPrice, 110);
});

test('preview HTTP reads expose dynamic version, snapshot and incremental changes with formal capability flags closed', async () => {
  const store = new MemoryBlobStore();
  const first = makeSubmission({ deviceId: DEVICE_1, submissionId: 'sub_01JABCDEF0123456789XYZABCD', unitPrice: 90, clientCreatedAt: NOW });
  const second = makeSubmission({ deviceId: DEVICE_2, submissionId: 'sub_01JABCDEF0123456789XYZABCE', unitPrice: 90, clientCreatedAt: NOW + 1 });
  await submit(store, first, NOW);
  await submit(store, second, NOW + 1);

  const dependencies = { createStore: () => store, now: () => NOW + 2 };
  const versionResponse = await handlePreviewPublicVersionRequest({
    env: ENV,
    request: previewRequest('/api/preview/public-version?groupId=group_fixture&libraryId=lib_receive_fixture'),
  }, dependencies);
  const versionBody = await responseBody(versionResponse);
  assert.equal(versionResponse.status, 200);
  assert.equal(versionBody.serviceId, 'cloud-collab-readonly');
  assert.equal(versionBody.data.publicVersion, 1);
  assert.equal(versionBody.data.recordCounts.exactPrice, 1);
  assert.equal(versionBody.data.publicMutationAllowed, false);
  assert.equal(versionBody.data.autoApprovalEnabled, false);
  assert.equal(versionBody.data.previewAutoApprovalEnabled, true);

  const snapshotResponse = await handlePreviewPublicSnapshotRequest({
    env: ENV,
    request: previewRequest('/api/preview/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture'),
  }, dependencies);
  const snapshotBody = await responseBody(snapshotResponse);
  assert.equal(snapshotBody.data.status, 'snapshot');
  assert.equal(snapshotBody.data.snapshot.records[0].payload.unitPrice, 90);

  const notModifiedResponse = await handlePreviewPublicSnapshotRequest({
    env: ENV,
    request: previewRequest('/api/preview/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture&ifVersion=1'),
  }, dependencies);
  const notModifiedBody = await responseBody(notModifiedResponse);
  assert.equal(notModifiedBody.data.status, 'not_modified');
  assert.equal(notModifiedBody.data.snapshot, null);

  const changesResponse = await handlePreviewPublicChangesRequest({
    env: ENV,
    request: previewRequest('/api/preview/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=0&limit=100'),
  }, dependencies);
  const changesBody = await responseBody(changesResponse);
  assert.equal(changesBody.data.status, 'changes');
  assert.equal(changesBody.data.changes.length, 1);
  assert.deepEqual(Object.keys(changesBody.data.changes[0]).sort(), [
    'approvedAt', 'businessKey', 'contentHash', 'dataType', 'operation', 'payload', 'version',
  ]);
  assert.equal(JSON.stringify(changesBody).includes('approvalId'), false);
  assert.equal(JSON.stringify(changesBody).includes('deviceIds'), false);
});

test('preview access and auto-approval flags fail before Blob initialization', async () => {
  for (const scenario of [
    { env: { ...ENV, CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0' }, key: PREVIEW_KEY, expected: 'PREVIEW_AUTO_APPROVAL_DISABLED', status: 503 },
    { env: ENV, key: 'wrong-key', expected: 'PREVIEW_ACCESS_DENIED', status: 403 },
    { env: ENV, key: null, expected: 'PREVIEW_ACCESS_DENIED', status: 403 },
  ]) {
    let storeCalls = 0;
    const response = await handlePreviewPublicVersionRequest({
      env: scenario.env,
      request: previewRequest('/api/preview/public-version?groupId=group_fixture&libraryId=lib_receive_fixture', { key: scenario.key }),
    }, {
      createStore: () => { storeCalls += 1; return new MemoryBlobStore(); },
    });
    const body = await responseBody(response);
    assert.equal(response.status, scenario.status);
    assert.equal(body.error.code, scenario.expected);
    assert.equal(storeCalls, 0);
    assert.equal(JSON.stringify(body).includes(PREVIEW_KEY), false);
  }
});

test('submission HTTP response can report preview mutation while formal capabilities remain false', async () => {
  const submission = makeSubmission({ deviceId: DEVICE_1, submissionId: 'sub_01JABCDEF0123456789XYZABCD', unitPrice: 100, clientCreatedAt: NOW });
  const response = await handlePreviewAutoApprovalSubmissionRequest({
    env: ENV,
    request: previewRequest('/api/preview/submissions/create', {
      method: 'POST',
      body: submission,
      authorization: 'Bearer fixture',
    }),
  }, {
    createStore: () => new MemoryBlobStore(),
    now: () => NOW,
    acceptAndReview: async () => ({
      submissionId: submission.submissionId,
      idempotencyKey: submission.idempotencyKey,
      duplicate: false,
      status: 'auto_approved',
      previewMutationApplied: true,
      previewPublicVersion: 1,
      previewAutoApprovalEnabled: true,
      publicMutationAllowed: true,
      autoApprovalEnabled: true,
    }),
  });
  const body = await responseBody(response);
  assert.equal(response.status, 202);
  assert.equal(body.data.previewMutationApplied, true);
  assert.equal(body.data.previewAutoApprovalEnabled, true);
  assert.equal(body.data.publicMutationAllowed, false);
  assert.equal(body.data.autoApprovalEnabled, false);
  assert.equal(body.data.writeEnabled, false);
});

test('stage4E adds isolated preview routes without replacing current public or submission routes', () => {
  const currentSubmission = fs.readFileSync('cloud-functions/api/submissions/create.js', 'utf8');
  const currentPublicVersion = fs.readFileSync('edge-functions/api/public-version.js', 'utf8');
  const previewSubmission = fs.readFileSync('cloud-functions/api/preview/submissions/create.js', 'utf8');
  const previewVersion = fs.readFileSync('cloud-functions/api/preview/public-version.js', 'utf8');

  assert.match(currentSubmission, /handleSubmissionCreateRequest/);
  assert.doesNotMatch(currentSubmission, /handlePreviewAutoApprovalSubmissionRequest/);
  assert.match(currentPublicVersion, /findPublicLibrary/);
  assert.doesNotMatch(currentPublicVersion, /preview_auto_approval/);
  assert.match(previewSubmission, /handlePreviewAutoApprovalSubmissionRequest/);
  assert.match(previewVersion, /handlePreviewPublicVersionRequest/);
});
