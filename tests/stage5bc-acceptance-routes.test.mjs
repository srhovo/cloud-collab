import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleStage5bcDeviceRegisterRequest,
  handleStage5bcPublicChangesRequest,
  handleStage5bcPublicSnapshotRequest,
  handleStage5bcPublicVersionRequest,
  handleStage5bcSubmissionCreateRequest,
  readStage5bcAcceptanceConfig,
} from '../src/server/stage5bc_acceptance_http_v1.js';
import { handlePreviewAutoApprovalSubmissionRequest } from '../src/server/preview_auto_approval_http_v1.js';

const PREVIEW_KEY = 'stage5bc-preview-key-012345678901234';
const ENV = Object.freeze({
  CLOUD_STAGE5BC_ACCEPTANCE_ENABLED: '1',
  CLOUD_STAGE5BC_CLEANUP_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_RATE_LIMIT_SALT: 'stage5bc-public-rate-salt-01234567890',
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://cloud-collab-stage5bc-test-dpxqrhy0935t.edgeone.cool',
  CLOUD_ADMIN_USERNAME: 'stage5bc-admin@example.test',
  CLOUD_ADMIN_PASSWORD: 'stage5bc-admin-password-12345',
  CLOUD_ADMIN_SESSION_SECRET: 'stage5bc-admin-session-secret-0123456',
  CLOUD_ADMIN_RATE_LIMIT_SALT: 'stage5bc-admin-rate-salt-01234567890',
  CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
  CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED: '1',
});

function request(path, { method = 'GET', body = null, key = PREVIEW_KEY } = {}) {
  return new Request(`https://stage5bc.test${path}`, {
    method,
    headers: {
      ...(key ? { 'X-Cloud-Collab-Preview-Key': key } : {}),
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

function context(path, options = {}, env = ENV) {
  return { request: request(path, options), env };
}

async function payload(response) {
  return response.json();
}

test('Stage5BC acceptance gate is default-off, requires standard public routes closed, and hard-locks both synthetic stores', () => {
  assert.throws(() => readStage5bcAcceptanceConfig({}), error => error.code === 'STAGE5BC_ACCEPTANCE_DISABLED');
  assert.throws(
    () => readStage5bcAcceptanceConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'STAGE5BC_FORMAL_PREVIEW_ROUTES_MUST_STAY_CLOSED',
  );
  assert.throws(
    () => readStage5bcAcceptanceConfig({ ...ENV, CLOUD_STAGE5BC_CLEANUP_ENABLED: '1' }),
    error => error.code === 'STAGE5BC_ACCEPTANCE_CLEANUP_CONFLICT',
  );
  assert.throws(
    () => readStage5bcAcceptanceConfig({ ...ENV, CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME: 'formal-prices' }),
    error => error.code === 'STAGE5BC_ACCEPTANCE_CONFIG_INVALID',
  );
  assert.throws(
    () => readStage5bcAcceptanceConfig({ ...ENV, CLOUD_ADMIN_SESSION_SECRET: PREVIEW_KEY }),
    error => error.code === 'STAGE5BC_ACCEPTANCE_SECRETS_REUSED',
  );
  const config = readStage5bcAcceptanceConfig(ENV);
  assert.equal(config.publicStoreName, 'cloud-collab-preview-v1');
  assert.equal(config.adminStoreName, 'cloud-collab-admin-preview-v1');
  assert.equal(config.groupId, 'group_fixture');
  assert.equal(config.libraryId, 'lib_receive_fixture');
  assert.equal(config.previewEnv.CLOUD_WRITE_PREVIEW_ENABLED, '1');
  assert.equal(config.previewEnv.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED, '1');
  assert.equal(ENV.CLOUD_WRITE_PREVIEW_ENABLED, '0');
});

test('Stage5BC temporary device and submission routes forward only through an internal cloned preview environment', async () => {
  const createdEnvs = [];
  const createStore = env => {
    createdEnvs.push({ ...env });
    return {};
  };
  const registration = await handleStage5bcDeviceRegisterRequest(context('/api/stage5bc/acceptance/device-register', {
    method: 'POST',
    body: { schemaVersion: 1, deviceId: 'dev_01JABCDEF0123456789XYZABCD', nickname: '设备A', clientContext: { appVersion: '8.2.28' } },
  }), {
    createStore,
    registerPreview: async ({ env }) => {
      assert.equal(env.CLOUD_WRITE_PREVIEW_ENABLED, '1');
      return { schemaVersion: 1, deviceId: 'dev_01JABCDEF0123456789XYZABCD', deviceToken: `dt_v1_${'A'.repeat(43)}` };
    },
  });
  assert.equal(registration.status, 201);
  assert.equal((await payload(registration)).data.publicMutationAllowed, false);

  const submission = await handleStage5bcSubmissionCreateRequest(context('/api/stage5bc/acceptance/submissions-create', {
    method: 'POST',
    body: { synthetic: true },
  }), {
    createStore,
    acceptAndReview: async ({ env }) => {
      assert.equal(env.CLOUD_WRITE_PREVIEW_ENABLED, '1');
      assert.equal(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED, '1');
      return {
        status: 'pending_review',
        decision: 'pending_review',
        reason: 'candidate_conflict',
        duplicate: false,
        previewPublicVersion: 0,
      };
    },
  });
  const submissionPayload = await payload(submission);
  assert.equal(submission.status, 202);
  assert.equal(submissionPayload.data.status, 'pending_review');
  assert.equal(submissionPayload.data.publicMutationAllowed, false);
  assert.equal(submissionPayload.data.autoApprovalEnabled, false);
  assert.equal(createdEnvs.every(env => env.CLOUD_WRITE_PREVIEW_ENABLED === '1'), true);
  assert.equal(ENV.CLOUD_WRITE_PREVIEW_ENABLED, '0');
});

test('Stage5BC temporary public reads keep dynamic version, snapshot and changes aligned', async () => {
  const snapshot = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    publicVersion: 1,
    snapshotVersion: 1,
    cursor: 'pv_1',
    generatedAt: '2026-07-19T12:00:00.000Z',
    records: [],
    tombstones: [],
  };
  const common = { createStore: () => ({}), readSnapshot: async () => snapshot };
  const version = await handleStage5bcPublicVersionRequest(context('/api/stage5bc/acceptance/public-version?groupId=group_fixture&libraryId=lib_receive_fixture'), common);
  const snapshotResponse = await handleStage5bcPublicSnapshotRequest(context('/api/stage5bc/acceptance/public-snapshot?groupId=group_fixture&libraryId=lib_receive_fixture'), common);
  const changes = await handleStage5bcPublicChangesRequest(context('/api/stage5bc/acceptance/public-changes?groupId=group_fixture&libraryId=lib_receive_fixture&sinceVersion=0&limit=100'), {
    createStore: () => ({}),
    readEvents: async () => [{
      version: 1,
      approvedAt: '2026-07-19T12:00:00.000Z',
      businessKey: `bk_v1_${'B'.repeat(43)}`,
      contentHash: `ch_v1_${'C'.repeat(43)}`,
      dataType: 'exact_price',
      operation: 'upsert',
      payload: { serviceName: '阶段5BC合成', settleType: 'round', unitPrice: 100 },
    }],
  });
  const [versionData, snapshotData, changesData] = await Promise.all([payload(version), payload(snapshotResponse), payload(changes)]);
  assert.equal(versionData.data.publicVersion, 1);
  assert.equal(snapshotData.data.publicVersion, 1);
  assert.equal(changesData.data.publicVersion, 1);
  assert.equal(changesData.data.nextVersion, 1);
  assert.equal(changesData.data.changes.length, 1);
  for (const data of [versionData.data, snapshotData.data, changesData.data]) {
    assert.equal(data.publicMutationAllowed, false);
    assert.equal(data.autoApprovalEnabled, false);
  }
});

test('Stage5BC does not open the standard preview route and rejects a missing acceptance preview key before store creation', async () => {
  let stores = 0;
  const standard = await handlePreviewAutoApprovalSubmissionRequest(context('/api/preview/submissions/create', {
    method: 'POST',
    body: {},
  }), { createStore: () => { stores += 1; return {}; } });
  assert.equal(standard.status, 503);
  assert.equal((await payload(standard)).error.code, 'PREVIEW_WRITE_DISABLED');

  const denied = await handleStage5bcDeviceRegisterRequest(context('/api/stage5bc/acceptance/device-register', {
    method: 'POST',
    body: {},
    key: '',
  }), { createStore: () => { stores += 1; return {}; } });
  assert.equal(denied.status, 403);
  assert.equal((await payload(denied)).error.code, 'PREVIEW_ACCESS_DENIED');
  assert.equal(stores, 0);
});
