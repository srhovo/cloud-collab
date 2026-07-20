import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const checks = [];
const check = (name, ok, details = null) => checks.push({ name, ok: Boolean(ok), details });

const policy = read('src/server/ordinary_types_policy_v1.js');
const acceptance = read('src/server/ordinary_submission_acceptance_v1.js');
const runtime = read('src/server/ordinary_types_preview_runtime_v1.js');
const publicEngine = read('src/server/ordinary_public_engine_v1.js');
const adminProjection = read('src/server/admin_ordinary_review_projection_v1.js');
const adminHttp = read('src/server/admin_ordinary_review_http_v1.js');
const adminMutation = read('src/server/admin_ordinary_review_mutation_v1.js');
const adminMutationHttp = read('src/server/admin_ordinary_review_mutation_http_v1.js');
const queueRoute = read('cloud-functions/api/admin/ordinary-reviews.js');
const detailRoute = read('cloud-functions/api/admin/ordinary-reviews/detail.js');
const approveRoute = read('cloud-functions/api/admin/ordinary-reviews/approve.js');
const rejectRoute = read('cloud-functions/api/admin/ordinary-reviews/reject.js');
const editRoute = read('cloud-functions/api/admin/ordinary-reviews/edit-and-approve.js');
const env = read('.env.example');
const build = read('scripts/build.mjs');

check('Stage5G gate defaults closed', env.includes('CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED=0'));
check('Stage5G Blob and fixture scope are explicit', [
  'CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME=cloud-collab-preview-v1',
  'CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID=group_fixture',
  'CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID=lib_receive_fixture',
].every(token => env.includes(token)));
check('Stage5G policy delegates exact_price to the frozen policy', policy.includes("if (dataType === 'exact_price') return computeSubmissionHashes(rawSubmission)")
  && policy.includes("if (dataType === 'exact_price') return normalizeSubmission(input)"));
check('Stage5G only opens playable_name and boss_profile upserts', policy.includes("new Set(['playable_name', 'boss_profile'])")
  && policy.includes("if (operation !== 'upsert')"));
check('Stage5G playable payload is a strict one-field projection', policy.includes("['name']")
  && policy.includes('INVALID_PLAYABLE_NAME_FIELDS'));
check('Stage5G boss payload is a strict three-field projection', policy.includes("['bossName', 'paiDan', 'discount']")
  && policy.includes('INVALID_BOSS_PROFILE_FIELDS'));
check('Stage5G rejects private and source-context fields recursively', [
  'NEVER_UPLOAD_FIELDS.includes(key)',
  'sourceOrderId',
  'sourceMessageId',
  'correctionContext',
  'recentBoss',
].every(token => policy.includes(token)));
check('Stage5G only accepts explicit user and initial-binding origins', policy.includes("new Set(['user', 'initialBinding'])")
  && policy.includes('INVALID_SUBMISSION_ORIGIN'));
check('Stage5G boss discount stays within 0.8 to 1', policy.includes('MIN_BOSS_DISCOUNT = 0.8')
  && policy.includes('MAX_BOSS_DISCOUNT = 1'));
check('Stage5G direct-report changes and discount increases cannot auto approve', policy.includes('boss_direct_report_change_sensitive')
  && policy.includes('boss_discount_increase_sensitive'));
check('Stage5G immutable acceptance exposes no public mutation capability', acceptance.includes('putJSONOnlyIfNew')
  && acceptance.includes('publicMutationAllowed: false')
  && acceptance.includes('autoApprovalEnabled: false'));
check('Stage5G runtime requires ordinary and write configurations together', runtime.includes('readPreviewWriteConfig(env)')
  && runtime.includes('readOrdinaryTypesPreviewConfig(env)')
  && runtime.includes('ORDINARY_TYPES_STORE_MISMATCH'));
check('Stage5G mixed public engine retains schemaVersion 1 and immutable indexes', publicEngine.includes('ORDINARY_PUBLIC_EVENT_SCHEMA_VERSION = 1')
  && publicEngine.includes('approvalIndexKey')
  && publicEngine.includes('transitionIndexKey')
  && publicEngine.includes('putJSONOnlyIfNew'));
check('Stage5G admin projection uses ordinary validation and strong event chain', adminProjection.includes('normalizeOrdinarySubmission')
  && adminProjection.includes('listValidOrdinaryPublicEvents')
  && adminProjection.includes("consistency: 'strong'"));
check('Stage5G admin read routes remain authenticated and read-only', adminHttp.includes('verifyAdminSessionToken')
  && adminHttp.includes('handleAdminOrdinaryReviewQueueRequest')
  && adminHttp.includes('handleAdminOrdinaryReviewDetailRequest')
  && !adminHttp.includes('putJSONOnlyIfNew'));
check('Stage5G ordinary mutation uses immutable decisions and ordinary publisher', adminMutation.includes('putImmutableExact')
  && adminMutation.includes('publishAdminOrdinaryApproval')
  && adminMutation.includes('ADMIN_ORDINARY_REVIEW_STAGE6_REQUIRED'));
check('Stage5G mutation blocks exact_price and Stage6-sensitive changes', adminMutation.includes("if (submission.dataType === 'exact_price') return false")
  && adminMutation.includes('STAGE5G_RESOLVABLE_REASONS')
  && adminMutation.includes('stage6SensitiveChangesBlocked: true'));
check('Stage5G mutation HTTP requires same-origin POST JSON', adminMutationHttp.includes('requireOrigin: true')
  && adminMutationHttp.includes("Allow: 'POST'")
  && adminMutationHttp.includes('application/json'));
check('Stage5G ordinary review routes point only to dedicated handlers', [
  [queueRoute, 'handleAdminOrdinaryReviewQueueRequest'],
  [detailRoute, 'handleAdminOrdinaryReviewDetailRequest'],
  [approveRoute, 'handleAdminOrdinaryReviewApproveRequest'],
  [rejectRoute, 'handleAdminOrdinaryReviewRejectRequest'],
  [editRoute, 'handleAdminOrdinaryReviewEditAndApproveRequest'],
].every(([source, token]) => source.includes(token)));
check('Stage5G source contains no browser persistence or embedded secrets', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test([
  policy,
  acceptance,
  runtime,
  publicEngine,
  adminProjection,
  adminHttp,
  adminMutation,
  adminMutationHttp,
].join('\n'))
  && !/(?:password|secret|token)\s*[:=]\s*['"][^'"]{12,}/i.test([
    policy,
    acceptance,
    runtime,
    publicEngine,
    adminProjection,
    adminHttp,
    adminMutation,
    adminMutationHttp,
  ].join('\n')));
check('8.2.25 remains excluded from all build inputs', !build.includes('码单器8.2.25'));

const failed = checks.filter(item => !item.ok);
const result = {
  stage: '5G',
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段5G_静态隐私与兼容门禁.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed }, null, 2));
process.exit(failed.length ? 1 : 0);
