import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleSensitiveSubmissionRequest,
} from '../src/server/sensitive_submission_http_v1.js';

const PREVIEW_KEY = 'K'.repeat(32);
const BUSINESS_KEY = `bk_v1_${'B'.repeat(43)}`;
const CONTENT_HASH = `ch_v1_${'C'.repeat(43)}`;

const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: PREVIEW_KEY,
  CLOUD_RATE_LIMIT_SALT: 'S'.repeat(32),
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
  CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
});

function request() {
  return new Request('https://preview.example/api/preview/sensitive-submissions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloud-Collab-Preview-Key': PREVIEW_KEY,
    },
    body: JSON.stringify({
      groupId: 'group_fixture',
      libraryId: 'lib_receive_fixture',
    }),
  });
}

test('Stage6B敏感候选读取显式公共Blob配置并严格投影统一快照基线', async () => {
  let createdStoreName = null;
  let observedBaseline = null;

  const response = await handleSensitiveSubmissionRequest({
    request: request(),
    env: { ...ENV },
  }, {
    createStore: env => {
      createdStoreName = env.CLOUD_BLOB_STORE_NAME;
      return { synthetic: true };
    },
    buildSnapshot: async () => ({
      records: [{
        businessKey: BUSINESS_KEY,
        contentHash: CONTENT_HASH,
        dataType: 'surcharge_rule',
        operation: 'upsert',
        approvedVersion: 3,
        payload: {
          name: '联合验收教学',
          keywords: ['教学', '教学单'],
          prices: { round: 5, hour: 20 },
          enabled: true,
        },
      }],
      tombstones: [],
    }),
    accept: async ({ resolveExistingRecord }) => {
      observedBaseline = await resolveExistingRecord({ businessKey: BUSINESS_KEY });
      return {
        duplicate: false,
        status: 'pending_review',
        decision: 'pending_review',
      };
    },
    now: () => 1_784_555_000_000,
  });

  assert.equal(response.status, 202);
  assert.equal(createdStoreName, 'cloud-collab-preview-v1');
  assert.deepEqual(observedBaseline, {
    businessKey: BUSINESS_KEY,
    contentHash: CONTENT_HASH,
    dataType: 'surcharge_rule',
    bossId: null,
    payload: {
      name: '联合验收教学',
      keywords: ['教学', '教学单'],
      prices: { round: 5, hour: 20 },
      enabled: true,
    },
  });
  assert.deepEqual(
    Object.keys(observedBaseline).sort(),
    ['bossId', 'businessKey', 'contentHash', 'dataType', 'payload'],
  );
});

test('Stage6B敏感候选在公共Blob名称不一致时失败关闭且不创建Store', async () => {
  let stores = 0;
  const response = await handleSensitiveSubmissionRequest({
    request: request(),
    env: { ...ENV, CLOUD_BLOB_STORE_NAME: 'wrong-store' },
  }, {
    createStore: () => {
      stores += 1;
      return {};
    },
  });

  assert.equal(response.status, 503);
  assert.equal(stores, 0);
  const payload = JSON.parse(await response.text());
  assert.equal(payload.error.code, 'SENSITIVE_SUBMISSION_SCOPE_INVALID');
});
