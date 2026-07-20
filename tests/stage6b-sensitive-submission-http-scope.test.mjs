import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSensitiveSubmissionRequest } from '../src/server/sensitive_submission_http_v1.js';

const PREVIEW_SECRET = 'P'.repeat(32);
const RATE_SECRET = 'R'.repeat(32);

function env(overrides = {}) {
  return {
    CLOUD_WRITE_PREVIEW_ENABLED: '1',
    CLOUD_WRITE_PREVIEW_KEY: PREVIEW_SECRET,
    CLOUD_RATE_LIMIT_SALT: RATE_SECRET,
    CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
    CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
    CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
    ...overrides,
  };
}

function request() {
  return new Request('https://example.test/api/preview/sensitive-submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Preview-Key': PREVIEW_SECRET,
      Authorization: 'Bearer demo',
    },
    body: JSON.stringify({
      groupId: 'group_fixture',
      libraryId: 'lib_receive_fixture',
      dataType: 'rank_range_rule',
      operation: 'upsert',
    }),
  });
}

class MemoryStore {}

test('敏感候选HTTP接受同一Blob和fixture作用域', async () => {
  let observedStoreName = null;
  let accepted = 0;
  const response = await handleSensitiveSubmissionRequest({ request: request(), env: env() }, {
    createStore: runtimeEnv => {
      observedStoreName = runtimeEnv.CLOUD_BLOB_STORE_NAME;
      return new MemoryStore();
    },
    buildSnapshot: async () => ({ records: [] }),
    accept: async ({ authorization, rawSubmission }) => {
      accepted += 1;
      assert.equal(authorization, 'Bearer demo');
      assert.equal(rawSubmission.groupId, 'group_fixture');
      assert.equal(rawSubmission.libraryId, 'lib_receive_fixture');
      return {
        status: 'pending_review',
        decision: 'pending_review',
        reason: 'rank_range_rule_manual_review',
        duplicate: false,
      };
    },
    now: () => 1_785_000_000_000,
  });

  assert.equal(response.status, 202);
  assert.equal(observedStoreName, 'cloud-collab-preview-v1');
  assert.equal(accepted, 1);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.decision, 'pending_review');
  assert.equal(payload.data.autoApprovalEnabled, false);
});

test('敏感候选HTTP在公共Blob绑定与敏感Blob不一致时失败关闭', async () => {
  let storeCreated = 0;
  const response = await handleSensitiveSubmissionRequest({
    request: request(),
    env: env({ CLOUD_BLOB_STORE_NAME: 'wrong-store' }),
  }, {
    createStore: () => { storeCreated += 1; return new MemoryStore(); },
  });

  assert.equal(response.status, 503);
  assert.equal(storeCreated, 0);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'SENSITIVE_SUBMISSION_SCOPE_INVALID');
});
