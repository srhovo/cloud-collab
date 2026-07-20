import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptAndReviewPreviewSubmission,
  readPreviewAutoApprovalConfig,
} from '../src/server/preview_auto_approval_runtime_v1.js';

const ENV = Object.freeze({
  CLOUD_WRITE_PREVIEW_ENABLED: '1',
  CLOUD_WRITE_PREVIEW_KEY: 'K'.repeat(32),
  CLOUD_RATE_LIMIT_SALT: 'S'.repeat(32),
  CLOUD_WRITE_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_WRITE_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED: '1',
  CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED: '1',
  CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
  CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '1',
  CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
  CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID: 'group_fixture',
  CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID: 'lib_receive_fixture',
});

test('Stage6B敏感审核模式验证Blob与作用域并启用联合读取', () => {
  const config = readPreviewAutoApprovalConfig({ ...ENV });
  assert.equal(config.sensitiveReviewEnabled, true);
  assert.equal(config.ordinaryTypesEnabled, true);
  assert.equal(config.allowedGroupId, 'group_fixture');
  assert.equal(config.allowedLibraryId, 'lib_receive_fixture');

  assert.throws(
    () => readPreviewAutoApprovalConfig({ ...ENV, CLOUD_BLOB_STORE_NAME: 'wrong-store' }),
    error => error.code === 'PREVIEW_SENSITIVE_SCOPE_MISMATCH',
  );
});

test('Stage6B敏感审核模式在写入任何普通候选之前失败关闭', async () => {
  let accepted = 0;
  let reviewed = 0;
  await assert.rejects(
    () => acceptAndReviewPreviewSubmission({
      store: {},
      authorization: 'Bearer unused',
      rawSubmission: null,
      env: { ...ENV },
      accept: async () => { accepted += 1; },
      review: async () => { reviewed += 1; },
    }),
    error => error.code === 'PREVIEW_ORDINARY_MUTATION_LOCKED_BY_SENSITIVE_REVIEW'
      && error.status === 409
      && error.details?.ordinaryMutationAllowed === false,
  );
  assert.equal(accepted, 0);
  assert.equal(reviewed, 0);
});

test('Stage5G普通自动审核在敏感审核门禁关闭时保持原有路径', async () => {
  const env = { ...ENV, CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '0' };
  const config = readPreviewAutoApprovalConfig(env);
  assert.equal(config.sensitiveReviewEnabled, undefined);
  assert.equal(config.ordinaryTypesEnabled, true);
});
