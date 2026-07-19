import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPublicLibrary } from '../edge-functions/api/_shared/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', '码单器8.2.26_公共协作本地候选版.html');
const outputPath = path.join(root, 'dist', 'index.html');
const source = fs.readFileSync(sourcePath, 'utf8');
const output = fs.readFileSync(outputPath, 'utf8');
const expectedSourceSha = 'd8c6f537885d423fecb84aaa82a8e26e0ccaf0d83b5c499ee525ca6b07ab3eea';
const cloudKeys = ['cloudCollabMeta','cloudDeviceCredential','cloudLibraryBindings','cloudBossLinks','pendingCloudChanges','cloudSyncState'];
const checks = [];
function check(name, condition, details = null) { checks.push({ name, ok: Boolean(condition), details }); }
function sha(text) { return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex'); }
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(root, rel)); }
function extractClass(text, name) {
  const start = text.indexOf(`class ${name} `);
  if (start < 0) return '';
  const next = text.indexOf('\nclass ', start + 8);
  return text.slice(start, next < 0 ? text.length : next);
}

check('Stage2C source SHA remains frozen', sha(source) === expectedSourceSha, sha(source));
check('8.2.25 stable file is never a build source', !read('scripts/build.mjs').includes('码单器8.2.25'));
check('candidate is 8.2.28 Stage4C build', output.includes("const APP_VERSION = '8.2.28';") && output.includes('<title>码单器8.2.28（公共协作候选派发客户端）</title>'));
check('legacy schema versions unchanged', [
  'const LOCAL_DATA_SCHEMA_VERSION = 5;',
  'const PRICE_LIBRARY_SCHEMA_VERSION = 3;',
  'const BACKUP_SCHEMA_VERSION = 4;',
  'const ORDER_PROJECT_SCHEMA_VERSION = 2;',
].every(token => output.includes(token)));
check('single inline script retained', (output.match(/<script(?:\s[^>]*)?>/gi) || []).length === 1);
const scriptMatch = output.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i);
const temp = path.join(os.tmpdir(), `stage4c-${process.pid}.js`);
fs.writeFileSync(temp, scriptMatch?.[1] || '', 'utf8');
const syntax = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
fs.rmSync(temp, { force: true });
check('candidate JavaScript syntax passes', syntax.status === 0, syntax.stderr.trim());
for (const className of ['LocalDataSchemaManager','BossDirectory','PriceLibraryStore','OrderFlowFeature','DataPortabilityFeature']) {
  check(`${className} unchanged from frozen source`, extractClass(source, className) === extractClass(output, className));
}

const submissionClient = read('src/cloud_collab_submission_client.js');
const submissionFeature = read('src/cloud_collab_submission_feature_methods.fragment.js');
const previewRuntime = read('src/server/preview_write_runtime_v1.js');
const previewHttp = read('src/server/preview_write_http_v1.js');
const acceptance = read('src/server/submission_acceptance_v1.js');
const deviceRegistration = read('src/server/device_registration_v1.js');
const previewAutoApproval = read('src/server/preview_auto_approval_runtime_v1.js');
const envExample = read('.env.example');
const workflow = read('.github/workflows/ci.yml');
const adminMutation = read('src/server/admin_review_mutation_v1.js');
const adminMutationHttp = read('src/server/admin_review_mutation_http_v1.js');
const adminMutationPage = read('dist/admin-review-actions-preview.html');
const deviceGovernance = read('src/server/device_governance_v1.js');
const deviceGovernanceHttp = read('src/server/device_governance_http_v1.js');
const deviceGovernancePage = read('dist/admin-device-governance-preview.html');
const adminRollback = read('src/server/admin_rollback_v1.js');
const adminRollbackHttp = read('src/server/admin_rollback_http_v1.js');
const adminRollbackPage = read('dist/admin-rollback-preview.html');

check('receive and submission clients are both embedded', output.includes('只读API客户端（阶段3B）') && output.includes('隔离候选提交客户端（阶段4C）'));
check('submission client uses only existing preview routes', submissionClient.includes("'/api/device/register'") && submissionClient.includes("'/api/submissions/create'") && !submissionClient.includes('/api/admin'));
check('client hard-locks synthetic preview scope', submissionClient.includes("PREVIEW_ALLOWED_GROUP_ID = 'group_fixture'") && submissionClient.includes("PREVIEW_ALLOWED_LIBRARY_ID = 'lib_receive_fixture'") && submissionClient.includes('PREVIEW_SCOPE_CLIENT_BLOCKED'));
check('dispatcher requires collaborate binding', submissionClient.includes("binding?.mode === 'collaborate'") && submissionClient.includes('hasCollaborativeBinding'));
check('initial and user candidates remain fixture-only', submissionFeature.includes('isPreviewCollaborativeBinding') && submissionFeature.includes('preview_scope_only'));
check('successful user exact-price save queues only after local persistence', output.includes('this.showSuccess(message);\n const cloudLocalLibraryId = workingActive?.id') && output.includes('enqueueExactPriceUserChange?.(cloudLocalLibraryId, record)') && output.indexOf('this.showSuccess(message);\n const cloudLocalLibraryId = workingActive?.id') < output.indexOf('enqueueExactPriceUserChange?.(cloudLocalLibraryId, record)'));
check('page accepts no secret input and runtime gate is not persisted', !output.includes('cloudPreviewAccessInput') && output.includes('CloudCollabPreviewRuntime?.getWriteAccess') && !submissionClient.includes('localStorage') && !submissionClient.includes('sessionStorage'));
check('device token is sent only as Authorization', submissionClient.includes('headers.Authorization = `Bearer ${token}`') && !submissionClient.includes('deviceToken: token'));
check('device credential uses dedicated local store', output.includes('credentialStore: this.cloudCollabStores.credentialStore') && deviceRegistration.includes('deviceToken,') && !deviceRegistration.includes('profile.deviceToken'));
check('queue state writeback paths exist', ['markSending','markAcknowledged','markRetry','markBlocked','completed_with_retry'].every(token => submissionClient.includes(token)));
check('unsafe server capabilities are rejected', submissionClient.includes('UNSAFE_SERVER_CAPABILITY') && acceptance.includes('publicMutationAllowed: false') && acceptance.includes('autoApprovalEnabled: false'));
check('runtime write gate defaults closed and server remains fixture-only', submissionClient.includes('WRITE_GATE_CLOSED') && submissionClient.includes('hasWriteAccess') && envExample.includes('CLOUD_WRITE_PREVIEW_ENABLED=0') && previewRuntime.includes('PREVIEW_SCOPE_MISCONFIGURED') && previewHttp.includes("writeScope: 'fixture_only'"));
check('formal public mutation and auto approval remain disabled', acceptance.includes('publicMutationAllowed: false') && acceptance.includes('autoApprovalEnabled: false'));
check('one-time cleanup route is absent from final branch', !exists('cloud-functions/api/system/cleanup-preview-fixtures-once.js') && !exists('src/server/preview_fixture_cleanup_once_v1.js') && !output.includes('cleanup-preview-fixtures'));
check('CI runs unit, static, core and browser checks', workflow.includes('npm run ci') && workflow.includes('tests/core_compare.py') && workflow.includes('tests/browser_integration.py'));
check('Stage5C mutation gate defaults closed', envExample.includes('CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED=0'));
check('Stage5C mutation scope remains synthetic-only', adminMutation.includes("ADMIN_REVIEW_ALLOWED_GROUP_ID") && adminMutation.includes("ADMIN_REVIEW_ALLOWED_LIBRARY_ID") && adminMutation.includes("ADMIN_REVIEW_PREVIEW_STORE_NAME"));
check('Stage5C admin writes require same-origin authenticated POST', adminMutationHttp.includes('requireOrigin: true') && adminMutationHttp.includes("method !== 'POST'") && adminMutationHttp.includes('verifyAdminSessionToken'));
check('Stage5C mutation page stores no secret or browser state', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(adminMutationPage) && !/CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT)/.test(adminMutationPage));
check('Stage5C routes stay outside ordinary user build', !output.includes('admin-review-actions-preview') && !output.includes('/api/admin/reviews/approve') && !submissionClient.includes('/api/admin'));
check('CI includes Stage5C browser mutation regression', workflow.includes('tests/stage5c_browser_admin_review_mutations.py'));

check('Stage5D governance gate defaults closed and store stays synthetic-only', envExample.includes('CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED=0') && envExample.includes('CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME=cloud-collab-preview-v1') && deviceGovernance.includes("DEVICE_GOVERNANCE_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1'"));
check('Stage5D uses irreversible refs and immutable governance records', deviceGovernance.includes('devref_v1_') && deviceGovernance.includes('devices/governance/events/') && deviceGovernance.includes('devices/governance/transitions/') && deviceGovernance.includes('devices/governance/requests/'));
check('Stage5D block revokes trust and unblock never restores it', deviceGovernance.includes("if (action === 'block')") && deviceGovernance.includes('return { trusted: false, blocked: true }') && deviceGovernance.includes('return { trusted: false, blocked: false }'));
check('Stage5D device authentication fails closed for blocked devices', deviceRegistration.includes("error.code === 'DEVICE_BLOCKED'") || (deviceRegistration.includes("'DEVICE_BLOCKED'") && deviceRegistration.includes('governance.blocked')));
check('Stage5D auto approval reads effective governance trust', previewAutoApproval.includes('governanceTrustedDeviceResolver') && previewAutoApproval.includes('state.trusted === true && state.blocked === false'));
check('Stage5D writes require authenticated same-origin POST with public origin forwarding', deviceGovernanceHttp.includes('requireOrigin: true') && deviceGovernanceHttp.includes('publicOrigin: authConfig.publicOrigin') && deviceGovernanceHttp.includes('verifyAdminSessionToken'));
check('Stage5D projection forbids raw device and storage identity', deviceGovernance.includes("'deviceId', 'deviceToken', 'tokenHash'") && deviceGovernance.includes("'eventKey'") && deviceGovernance.includes("'blobKey'"));
check('Stage5D page persists no credentials or governance state', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(deviceGovernancePage) && !/CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT|DEVICE_REF_SALT)/.test(deviceGovernancePage));
check('Stage5D admin controls have exact unique accessible labels', ['设为可信','撤销可信','封禁设备','解除封禁'].every(label => (deviceGovernancePage.match(new RegExp(`>${label}<`, 'g')) || []).length === 1));
check('Stage5D routes and page stay outside ordinary user build', !output.includes('admin-device-governance-preview') && !output.includes('/api/admin/devices') && !submissionClient.includes('/api/admin'));
check('CI includes Stage5D browser governance regression', workflow.includes('tests/stage5d_browser_device_governance.py'));

check('Stage5E rollback gate defaults closed and scope stays fixture-only', envExample.includes('CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED=0') && envExample.includes('CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME=cloud-collab-preview-v1') && envExample.includes('CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID=group_fixture') && envExample.includes('CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID=lib_receive_fixture'));
check('Stage5E uses irreversible refs and immutable request, decision, transition and audit records', adminRollback.includes('rbref_v1_') && adminRollback.includes('/requests/') && adminRollback.includes('/rollbacks/') && adminRollback.includes('transitionIndexKey') && adminRollback.includes('rollbackAuditKey'));
check('Stage5E appends a compensating event without deleting history', adminRollback.includes('reserveRollbackEvent') && adminRollback.includes('putJSONOnlyIfNew') && adminRollback.includes('payload: previous.payload') && adminRollback.includes('approvedVersion: current.version') && !adminRollback.includes('deleteBlob'));
check('Stage5E rebuilds and verifies the latest public snapshot', adminRollback.includes('buildPublicSnapshot') && adminRollback.includes('ADMIN_ROLLBACK_SNAPSHOT_MISMATCH'));
check('Stage5E writes require authenticated same-origin POST with public origin forwarding', adminRollbackHttp.includes('requireOrigin: true') && adminRollbackHttp.includes('publicOrigin: authConfig.publicOrigin') && adminRollbackHttp.includes('verifyAdminSessionToken'));
check('Stage5E projection forbids public storage and request identity', adminRollback.includes("'businessKey', 'contentHash'") && adminRollback.includes("'eventKey', 'snapshotKey'") && adminRollback.includes("'approvalId', 'requestHash', 'requestId'"));
check('Stage5E page persists no credentials or rollback state', !/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)/.test(adminRollbackPage) && !/CLOUD_ADMIN_(?:PASSWORD|SESSION_SECRET|RATE_LIMIT_SALT|ROLLBACK_REF_SALT)/.test(adminRollbackPage));
check('Stage5E rollback control has an exact unique accessible label', (adminRollbackPage.match(/>回滚到上一批准值</g) || []).length === 1);
check('Stage5E routes and page stay outside ordinary user build', !output.includes('admin-rollback-preview') && !output.includes('/api/admin/rollbacks') && !submissionClient.includes('/api/admin'));
check('CI includes Stage5E browser rollback regression', workflow.includes('tests/stage5e_browser_admin_rollback.py'));

const backupBlock = output.match(/getModuleConfigs\(\) \{\s*return \[([\s\S]*?)\];\s*\}/)?.[1] || '';
check('cloud keys remain excluded from standard backup', cloudKeys.every(key => !backupBlock.includes(key)));
const modelBlock = output.match(/const LOCAL_DATA_MODEL_VERSIONS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
check('cloud keys remain outside legacy migrations', cloudKeys.every(key => !modelBlock.includes(key)));
const outboundBlock = submissionClient.slice(submissionClient.indexOf('async function buildExactPriceSubmission'), submissionClient.indexOf('class SubmissionDispatcher'));
check('outbound builder contains no private fields', ['history','orders','rawChat','chat','note','modeRatios','layoutTemplates','usageCount','lastUsed','original'].every(term => !outboundBlock.includes(term)));
check('no hardcoded credential', !/(?:Bearer\s+[A-Za-z0-9._-]{16,}|(?:secret|password)\s*[:=]\s*['"][^'"]{12,})/i.test([output, submissionClient, submissionFeature, envExample].join('\n')));
const official = findPublicLibrary('group_xiacijian', 'lib_xiacijian_regular');
check('official public library remains version 0 and empty', official?.publicVersion === 0 && official?.snapshot === null && official?.events?.length === 0);
const fixture = findPublicLibrary('group_fixture', 'lib_receive_fixture');
check('fixture library remains isolated and synthetic', fixture?.fixtureOnly === true);

const before = sha(output);
const rebuild = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
const after = rebuild.status === 0 ? sha(fs.readFileSync(outputPath, 'utf8')) : null;
check('build is reproducible', rebuild.status === 0 && before === after, { before, after, stderr: rebuild.stderr.trim() });
const failed = checks.filter(item => !item.ok);
const result = { stage: '4C', candidateVersion: '8.2.28', candidateSha256: after, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段4C_静态与隐私边界验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed, candidateSha256: result.candidateSha256 }, null, 2));
process.exit(failed.length ? 1 : 0);
