import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const checks = [];
const check = (name, ok, details = null) => checks.push({ name, ok: Boolean(ok), details });

const policy = read('src/server/sensitive_rules_policy_v1.js');
const ordinary = read('src/server/ordinary_types_policy_v1.js');
const tests = read('tests/stage6a-sensitive-rules-policy.test.mjs');
const env = read('.env.example');
const build = read('scripts/build-stage5g.mjs');
const packageJson = read('package.json');
const scope = read('docs/阶段6A_敏感规则协议范围冻结.md');

check('Stage6A gate defaults closed', env.includes('CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED=0'));
check('Stage6A Blob and fixture scope are explicit', [
  'CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME=cloud-collab-preview-v1',
  'CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID=group_fixture',
  'CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID=lib_receive_fixture',
].every(token => env.includes(token)));
check('Stage6A policy hard-locks synthetic store and scope', [
  "SENSITIVE_RULES_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1'",
  "SENSITIVE_RULES_ALLOWED_GROUP_ID = 'group_fixture'",
  "SENSITIVE_RULES_ALLOWED_LIBRARY_ID = 'lib_receive_fixture'",
  'SENSITIVE_RULES_SCOPE_INVALID',
].every(token => policy.includes(token)));
check('Stage6A only opens range surcharge and gift rule upserts', policy.includes("new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule'])")
  && policy.includes('UNSUPPORTED_SENSITIVE_DATA_TYPE'));
check('Stage6A explicit delete types are enumerated', [
  "'exact_price'",
  "'playable_name'",
  "'boss_profile'",
  "'rank_range_rule'",
  "'surcharge_rule'",
  "'gift_rule'",
  'DELETE_PAYLOAD_MUST_BE_NULL',
].every(token => policy.includes(token)));
check('Stage6A rank payload uses actual 8.2 model', [
  "['rangeLabel', 'alias', 'rankType', 'minStar', 'maxStar', 'namedRanks', 'prices']",
  "['star', 'namedTier', 'lowerTier']",
  "['normal', 'carry', 'starGuarantee']",
  "['round', 'hour']",
].every(token => policy.includes(token)));
check('Stage6A surcharge projection is strict', policy.includes("['name', 'keywords', 'prices', 'enabled']")
  && policy.includes('MAX_SURCHARGE_KEYWORDS = 12'));
check('Stage6A gift fixed and variable semantics are explicit', policy.includes("['serviceName', 'mode', 'unitPrice']")
  && policy.includes('VARIABLE_GIFT_PRICE_MUST_BE_NULL'));
check('Stage6A recursively blocks private and local fields', [
  'NEVER_UPLOAD_FIELDS.includes(key)',
  'EXTRA_FORBIDDEN_FIELDS.includes(key)',
  "'ruleId'",
  "'sourceOrderId'",
  "'usageCount'",
  "'backupMeta'",
].every(token => policy.includes(token)));
check('Stage6A only accepts explicit user and initial binding origins', policy.includes("new Set(['user', 'initialBinding'])")
  && policy.includes('INVALID_SUBMISSION_ORIGIN'));
check('Stage6A rejects contact details and control characters', policy.includes('SENSITIVE_CONTACT_INFO_FORBIDDEN')
  && policy.includes('SENSITIVE_TEXT_CONTROL_CHARACTER'));
check('Stage6A retains the frozen request size cap', policy.includes('assertSubmissionRequestBytes(input, MAX_SUBMISSION_BYTES)'));
check('Stage6A server recomputes rule business keys and content hashes', policy.includes("`bk_v1_${sha256Base64Url(canonicalize(buildRuleIdentity(submission)))}`")
  && policy.includes("`ch_v1_${sha256Base64Url(canonicalize(buildSensitiveContent(contentSubmission)))}`"));
check('Stage6A server recomputes idempotency keys', policy.includes('buildIdempotencyKey(submission.deviceId, submission.submissionId)')
  && policy.includes('IDEMPOTENCY_KEY_MISMATCH'));
check('Stage6A delete business keys require an existing public baseline', policy.includes('businessKeyRequiresExistingVerification: submission.operation ===')
  && policy.includes('DELETE_TARGET_NOT_FOUND')
  && policy.includes('EXISTING_BUSINESS_KEY_MISMATCH'));
check('Stage6A sensitive decisions cannot bypass manual review', [
  "decision: 'pending_review'",
  'publicMutationAllowed: false',
  'autoApprovalEnabled: false',
  'trustedDeviceBypassAllowed: false',
  'twoDeviceBypassAllowed: false',
].every(token => policy.includes(token)));
check('Stage6A boss-sensitive reasons are delegated to frozen Stage5G logic', policy.includes('evaluateOrdinaryCandidate({')
  && policy.includes('NOT_SENSITIVE_BOSS_CHANGE')
  && policy.includes('MAX_AUTOMATIC_DISCOUNT_DROP'));
check('Stage6A does not replace the Stage5G ordinary policy', ordinary.includes('eligible_auto_approval')
  && ordinary.includes('two_devices_match')
  && ordinary.includes('trusted_device'));
check('Stage6A tests prove Stage5G ordinary compatibility', tests.includes('preserves Stage5G ordinary boss decisions')
  && tests.includes("decision.decision, 'eligible_auto_approval'"));
check('Stage6A tests cover all sensitive rule classes', [
  "draft('rank_range_rule'",
  "draft('surcharge_rule'",
  "draft('gift_rule'",
  "operation: 'delete'",
  'boss_direct_report_change_sensitive',
  'boss_discount_increase_sensitive',
  'boss_discount_drop_abnormal',
].every(token => tests.includes(token)));
check('Stage6A tests cover trusted and multi-device non-bypass', tests.includes('matchingDistinctDeviceCount: 99')
  && tests.includes('trustedDevice: true')
  && tests.includes("decision.decision, 'pending_review'"));
check('Stage6A tests cover tamper-resistant hashes and idempotency', tests.includes('CONTENT_HASH_MISMATCH')
  && tests.includes('completed.idempotencyKey, other.idempotencyKey'));
check('Stage6A scope explicitly excludes client and EdgeOne work', scope.includes('普通用户页面的敏感规则保存监听和上传入口')
  && scope.includes('EdgeOne真实部署或验收'));
check('Stage6A does not modify the Stage5G build inputs', !build.includes('sensitive_rules_policy_v1.js'));
check('Stable 8.2.25 remains excluded from build inputs', !build.includes('码单器8.2.25'));
check('Stage6A validator is included in package validation', packageJson.includes('validate-stage6a.mjs'));
check('Stage6A source contains no browser credential persistence or embedded secret', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(policy)
  && !/(?:password|secret|token)\s*[:=]\s*['"][^'"]{12,}/i.test(policy));

const failed = checks.filter(item => !item.ok);
const result = {
  stage: '6A',
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段6A_静态隐私与兼容门禁.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed }, null, 2));
process.exit(failed.length ? 1 : 0);
