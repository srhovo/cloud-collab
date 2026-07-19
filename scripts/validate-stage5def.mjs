import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const check = (name, ok, details = null) => checks.push({ name, ok: Boolean(ok), details });

const env = read('.env.example');
const core = read('src/server/stage5def_acceptance_v1.js');
const http = read('src/server/stage5def_acceptance_http_v1.js');
const cleanup = read('src/server/stage5def_cleanup_v1.js');
const cleanupHttp = read('src/server/stage5def_cleanup_http_v1.js');
const adminPage = read('dist/stage5def-admin-acceptance.html');
const cleanupPage = read('dist/stage5def-cleanup.html');
const ordinary = read('dist/index.html');
const submissionClient = read('src/cloud_collab_submission_client.js');
const workflow = read('.github/workflows/ci.yml');
const doc = read('docs/阶段5DEF_管理员能力联合EdgeOne验收与销毁.md');
const packageJson = read('package.json');

check('Stage5DEF acceptance and cleanup gates default closed', [
  'CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED=0',
  'CLOUD_STAGE5DEF_CLEANUP_ENABLED=0',
].every(token => env.includes(token)));
check('Stage5DEF secrets are declared separately', [
  'CLOUD_STAGE5DEF_ACCEPTANCE_KEY=',
  'CLOUD_STAGE5DEF_CLEANUP_KEY=',
  'CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION=',
].every(token => env.includes(token)));
check('Stage5DEF fixture scope and two Blob stores are hard locked', [
  "STAGE5DEF_PUBLIC_STORE_NAME = 'cloud-collab-preview-v1'",
  "STAGE5DEF_ADMIN_STORE_NAME = 'cloud-collab-admin-preview-v1'",
  "STAGE5DEF_GROUP_ID = 'group_fixture'",
  "STAGE5DEF_LIBRARY_ID = 'lib_receive_fixture'",
].every(token => core.includes(token)));
check('Stage5DEF acceptance keeps ordinary mutations closed', [
  'CLOUD_WRITE_PREVIEW_ENABLED',
  'CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED',
  'CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED',
].every(token => core.includes(token)));
check('Stage5DEF creates deterministic fixture devices without projecting raw credentials', core.includes('registerDevice')
  && core.includes('deterministicToken')
  && core.includes('isStage5defAcceptanceProjectionSafe')
  && ['deviceId','deviceToken','tokenHash','submissionId','approvalId','eventKey','requestHash'].every(key => core.includes(`'${key}'`)));
check('Stage5DEF seed uses proven public publisher and fixed 100 to 120 values', core.includes('publishAdminReviewApproval')
  && core.includes('STAGE5DEF_FIRST_PRICE = 100')
  && core.includes('STAGE5DEF_SECOND_PRICE = 120'));
check('Stage5DEF acceptance routes require same-project origin and independent key', http.includes('assertStage5defAcceptanceAccess')
  && core.includes('assertAdminSameOriginRequest')
  && core.includes('x-cloud-stage5def-acceptance-key'));
check('Stage5DEF route bodies use fixed confirmations and exact schemas', core.includes("STAGE5DEF_SEED_CONFIRMATION = 'SEED_STAGE5DEF_SYNTHETIC_V1'")
  && http.includes('STAGE5DEF_SEED_CONFIRMATION')
  && http.includes("Object.keys(body).sort().join(',') !== 'confirmation,schemaVersion'"));
check('Stage5DEF cleanup requires every capability closed', [
  'CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED',
  'CLOUD_ADMIN_PREVIEW_ENABLED',
  'CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED',
  'CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED',
  'CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED',
].every(token => cleanup.includes(token)));
check('Stage5DEF cleanup is inspect-then-digest-bound-delete', cleanup.includes('inspectStage5defObjects')
  && cleanup.includes('expectedPublicKeySetDigest')
  && cleanup.includes('expectedAdminKeySetDigest')
  && cleanup.includes('STAGE5DEF_CLEANUP_KEYSET_CHANGED'));
check('Stage5DEF cleanup fails closed on unknown objects', cleanup.includes('STAGE5DEF_CLEANUP_UNSAFE_OBJECTS')
  && cleanup.includes('assertSafeKeys')
  && cleanup.includes('PUBLIC_PATTERNS')
  && cleanup.includes('ADMIN_PATTERNS'));
check('Stage5DEF cleanup HTTP requires origin, key and fixed confirmation', cleanupHttp.includes('assertStage5defCleanupAccess')
  && cleanup.includes('assertAdminSameOriginRequest')
  && cleanup.includes('x-cloud-stage5def-cleanup-key')
  && cleanup.includes("STAGE5DEF_CLEANUP_CONFIRMATION = 'DELETE_STAGE5DEF_SYNTHETIC_PREVIEW_V1'")
  && cleanupHttp.includes('STAGE5DEF_CLEANUP_CONFIRMATION'));
check('Stage5DEF pages forward EdgeOne preview query parameters', [adminPage, cleanupPage].every(page => page.includes("['eo_token','eo_time']")));
check('Stage5DEF pages persist no credential or acceptance state', [adminPage, cleanupPage].every(page => !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(page)));
check('Stage5DEF administrator page has exact unique primary controls', [
  '创建并核验合成种子',
  '管理员安全登录',
  '运行设备治理、回滚与导出联合验收',
  '读取强一致验收状态',
  '退出并清除页面状态',
].every(label => (adminPage.match(new RegExp(`>${label}<`, 'g')) || []).length === 1));
check('Stage5DEF cleanup page requires inspect before delete and two zero checks', cleanupPage.includes('强一致检查两套Blob')
  && cleanupPage.includes('按检查摘要执行删除')
  && cleanupPage.includes('state.verifyCount>=2')
  && cleanupPage.includes('两次复查均为0'));
check('Stage5DEF routes and pages stay outside ordinary user build', !ordinary.includes('stage5def-admin-acceptance')
  && !ordinary.includes('/api/stage5def')
  && !submissionClient.includes('/api/stage5def'));
check('Stage5DEF branch is permanently DO NOT MERGE', doc.includes('DO NOT MERGE')
  && doc.includes('必须始终保持 Draft')
  && doc.includes('绝不合并'));
check('Stage5DEF CI includes both joint and cleanup browser regressions', workflow.includes('tests/stage5def_browser_joint_acceptance.py')
  && workflow.includes('tests/stage5def_browser_cleanup.py'));
check('Stage5DEF static validator is wired into npm validation', packageJson.includes('validate-stage5def.mjs'));

const syntaxFiles = [
  'src/server/stage5def_acceptance_v1.js',
  'src/server/stage5def_acceptance_http_v1.js',
  'src/server/stage5def_cleanup_v1.js',
  'src/server/stage5def_cleanup_http_v1.js',
  'cloud-functions/api/stage5def/acceptance/seed.js',
  'cloud-functions/api/stage5def/acceptance/status.js',
  'cloud-functions/api/stage5def/acceptance/device-auth.js',
  'cloud-functions/api/stage5def/cleanup.js',
];
for (const rel of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
  check(`${rel} syntax passes`, result.status === 0, result.stderr.trim());
}
for (const [label, page] of [['admin page', adminPage], ['cleanup page', cleanupPage]]) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || '';
  const temp = path.join(os.tmpdir(), `stage5def-${label.replace(/\s+/g, '-')}-${process.pid}.js`);
  fs.writeFileSync(temp, script, 'utf8');
  const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
  fs.rmSync(temp, { force: true });
  check(`Stage5DEF ${label} inline script syntax passes`, result.status === 0, result.stderr.trim());
}

const failed = checks.filter(item => !item.ok);
console.log(JSON.stringify({
  stage: '5DEF',
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
}, null, 2));
process.exit(failed.length ? 1 : 0);
