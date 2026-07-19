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
check('Stage5G source contains no browser persistence or embedded secrets', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test([policy, acceptance, runtime, publicEngine].join('\n'))
  && !/(?:password|secret|token)\s*[:=]\s*['"][^'"]{12,}/i.test([policy, acceptance, runtime, publicEngine].join('\n')));
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
