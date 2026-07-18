import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPublicLibrary, cloneSnapshot, listChanges } from '../edge-functions/api/_shared/catalog.js';

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
function extractClass(text, name) {
  const start = text.indexOf(`class ${name} `);
  if (start < 0) return '';
  const next = text.indexOf('\nclass ', start + 8);
  return text.slice(start, next < 0 ? text.length : next);
}
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function listJsRecursive(rel, prefix = '') {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listJsRecursive(path.join(rel, entry.name), nextPrefix));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(nextPrefix);
  }
  return result.sort();
}

check('Stage2C source SHA is frozen', sha(source) === expectedSourceSha, sha(source));
check('candidate is 8.2.28 submission-client build', output.includes("const APP_VERSION = '8.2.28';") && output.includes('<title>码单器8.2.28（公共协作候选派发客户端）</title>'));
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
  check(`${className} unchanged from Stage2C`, extractClass(source, className) === extractClass(output, className));
}
check('API base is build-time meta config', output.includes('<meta name="cloud-collab-api-base" content="">'));
check('startup receive and submission work are asynchronous', output.includes('this.cloudCollabFeature.scheduleReadonlyCheck();') && output.includes('this.cloudCollabFeature.scheduleSubmissionDispatch();') && output.includes('setTimeout(async () =>'));
check('five-minute receive polling is retained', output.includes('}, 300000);') && output.includes("document.visibilityState === 'hidden'"));
check('readonly client omits credentials', output.includes("credentials: 'omit'") && output.includes("method: 'GET'"));
const readonlyClientBlock = output.slice(output.indexOf('// ===== 公共协作数据库：只读API客户端（阶段3B）'), output.indexOf('// ===== 公共协作数据库：只读API客户端结束 ====='));
check('readonly client sends no Authorization header', !readonlyClientBlock.includes('Authorization'));
check('snapshot module uses SHA-256 with Web Crypto preference and local fallback', output.includes("subtle.digest('SHA-256'") && output.includes('sha256Fallback') && output.includes('SNAPSHOT_HASH_MISMATCH'));
check('three-way merge branches are present', ['localHash === baseHash','remoteHash === baseHash','result.conflicts.push'].every(token => output.includes(token)));
check('client applies only exact_price records', output.includes("value.dataType !== 'exact_price'") && output.includes('当前客户端只支持接收普通精确价格'));
check('receive commit uses PriceLibraryStore persistence boundary', output.includes('priceStore.persist(working.data') && output.includes('priceStore.restoreSnapshot(oldCanonical, oldLegacy)'));
check('receive metadata uses rollback transaction', output.includes('commitSyncMetadata(binding') && output.includes('transaction.run(steps)'));
check('incomplete rollback disables cloud feature', output.includes("error?.code === 'SYNC_ROLLBACK_INCOMPLETE'") && output.includes('this.lastError = error'));
check('cloud pull never enqueues submission', !output.slice(output.indexOf('async syncBinding'), output.indexOf('getModeLabel(mode)')).includes('enqueueSubmission'));

const apiDir = path.join(root,'edge-functions','api');
const apiEntries = fs.readdirSync(apiDir).filter(name => name.endsWith('.js')).sort();
check('five public read API routes exist', JSON.stringify(apiEntries) === JSON.stringify(['health.js','protocol.js','public-changes.js','public-snapshot.js','public-version.js']), apiEntries);
const apiSource = apiEntries.map(name => fs.readFileSync(path.join(apiDir,name),'utf8')).join('\n');
check('all edge routes use method gate', apiEntries.every(name => fs.readFileSync(path.join(apiDir,name),'utf8').includes('methodNotAllowed')));
check('edge routes expose no POST handler', !apiSource.includes('onRequestPost') && !apiSource.includes('writeEnabled: true'));
check('protocol advertises read abilities and no formal writes', apiSource.includes('snapshotRead: true') && apiSource.includes('incrementalRead: true') && apiSource.includes('exactPriceReceive: true') && apiSource.includes('submission: false') && apiSource.includes('adminReview: false'));
check('CORS allows credential-free local HTML reads', read('edge-functions/api/_shared/http.js').includes("'Access-Control-Allow-Origin': '*'"));
check('snapshot and changes endpoints impose read bounds', read('edge-functions/api/public-changes.js').includes('limit > 100') && read('edge-functions/api/public-snapshot.js').includes('ifVersion'));

const writeRoutes = listJsRecursive('cloud-functions/api');
const expectedWriteRoutes = ['device/register.js','submissions/create.js','system/cleanup-preview-fixtures-once.js'];
check('only two preview write routes plus one temporary cleanup route exist', JSON.stringify(writeRoutes) === JSON.stringify(expectedWriteRoutes), writeRoutes);
const previewWriteRouteSource = ['device/register.js','submissions/create.js'].map(rel => read(`cloud-functions/api/${rel}`)).join('\n');
check('preview write routes remain thin shared-handler adapters', previewWriteRouteSource.includes('handleDeviceRegisterRequest') && previewWriteRouteSource.includes('handleSubmissionCreateRequest') && (previewWriteRouteSource.match(/export default async function onRequest/g) || []).length === 2);
const cleanupRoute = read('cloud-functions/api/system/cleanup-preview-fixtures-once.js');
check('temporary cleanup route is a thin isolated adapter', cleanupRoute.includes('handlePreviewFixtureCleanupRequest') && cleanupRoute.includes('resolveCloudFunctionContext'));

const previewRuntime = read('src/server/preview_write_runtime_v1.js');
const previewHttp = read('src/server/preview_write_http_v1.js');
const edgeOneBlobRuntime = read('src/server/edgeone_blob_runtime_v1.js');
const blobRepository = read('src/server/blob_repository_v1.js');
const deviceRegistration = read('src/server/device_registration_v1.js');
const submissionAcceptance = read('src/server/submission_acceptance_v1.js');
const submissionClient = read('src/cloud_collab_submission_client.js');
const submissionFeature = read('src/cloud_collab_submission_feature_methods.fragment.js');
const cleanupRuntime = read('src/server/preview_fixture_cleanup_once_v1.js');
const cleanupHttp = read('src/server/preview_fixture_cleanup_http_v1.js');
const packageJson = JSON.parse(read('package.json'));
const envExample = read('.env.example');
check('Blob SDK version is pinned', packageJson.dependencies?.['@edgeone/pages-blob'] === '0.0.14');
check('preview write and cleanup default disabled in env example', envExample.includes('CLOUD_WRITE_PREVIEW_ENABLED=0') && envExample.includes('CLOUD_PREVIEW_CLEANUP_ENABLED=0'));
check('all preview secrets remain blank in env example', /CLOUD_WRITE_PREVIEW_KEY=\s*(?:\r?\n|$)/.test(envExample) && /CLOUD_RATE_LIMIT_SALT=\s*(?:\r?\n|$)/.test(envExample) && /CLOUD_PREVIEW_CLEANUP_KEY=\s*(?:\r?\n|$)/.test(envExample));
check('preview write requires feature flag, access key, fixed scope and rate salt', ['CLOUD_WRITE_PREVIEW_ENABLED','CLOUD_WRITE_PREVIEW_KEY','CLOUD_WRITE_ALLOWED_GROUP_ID','CLOUD_WRITE_ALLOWED_LIBRARY_ID','CLOUD_RATE_LIMIT_SALT'].every(token => previewRuntime.includes(token)));
check('preview scope is hard-coded to fixture IDs', previewRuntime.includes("PREVIEW_ALLOWED_GROUP_ID = 'group_fixture'") && previewRuntime.includes("PREVIEW_ALLOWED_LIBRARY_ID = 'lib_receive_fixture'") && previewRuntime.includes('PREVIEW_SCOPE_MISCONFIGURED'));
check('preview access key uses timing-safe comparison', previewRuntime.includes('timingSafeEqual') && previewRuntime.includes('assertPreviewRequestAccess'));
const accessGateIndex = previewHttp.indexOf('assertPreviewRequestAccess(context.request, config);');
const bodyReadIndex = previewHttp.indexOf('readJsonBody(context.request');
const storeCreateIndex = previewHttp.indexOf('createStore(env)');
check('HTTP handlers reject bad preview access before body and Blob', accessGateIndex >= 0 && accessGateIndex < bodyReadIndex && accessGateIndex < storeCreateIndex);
check('registration response cannot imply mutation rights', previewHttp.includes('submissionEnabled: false') && previewHttp.includes('publicMutationAllowed: false') && previewHttp.includes('autoApprovalEnabled: false'));
check('Blob runtime uses strong consistency', edgeOneBlobRuntime.includes("getStore({ name, consistency: 'strong' })"));
check('immutable Blob writes remain only-if-new', blobRepository.includes('{ onlyIfNew: true }'));
check('device token plaintext is returned once but only hash is persisted', deviceRegistration.includes('deviceToken,') && deviceRegistration.includes('tokenHash,') && !deviceRegistration.includes('profile.deviceToken'));
check('candidate acceptance cannot mutate public data', submissionAcceptance.includes('publicMutationAllowed: false') && submissionAcceptance.includes('autoApprovalEnabled: false'));

check('8.2.28 client uses current preview routes', submissionClient.includes("'/api/device/register'") && submissionClient.includes("'/api/submissions/create'"));
check('preview access is supplied by a session provider and not embedded', submissionClient.includes('previewAccessKeyProvider') && output.includes('cloudCollabPreviewSession = { accessKey: \'\' }') && !output.includes('CLOUD_WRITE_PREVIEW_KEY'));
check('device token is only placed in Authorization and omitted from request body', submissionClient.includes('headers.Authorization = `Bearer ${token}`') && submissionClient.includes('body: JSON.stringify(body)'));
check('client classifies 401 403 409 429 and 5xx', ['status === 401','status === 403','status === 409','status === 429','status >= 500'].every(token => submissionClient.includes(token)));
check('dispatcher writes queue terminal/retry states', ['markAcknowledged','markRetry','markBlocked'].every(token => submissionClient.includes(token)));
check('offline dispatcher leaves queue untouched', submissionClient.includes('if (!this.isOnline())') && submissionClient.includes("status: 'offline'"));
check('initial binding only projects exact round/hour prices', submissionClient.includes("!['round', 'hour'].includes(settleType)") && submissionFeature.includes("binding.mode !== 'collaborate'"));
check('only collaboration binding enqueues and receive mode remains read-only', submissionFeature.includes('enqueueInitialBindingSubmissions') && output.includes("if (mode === 'collaborate') await this.enqueueInitialBindingSubmissions(localLibraryId)"));
check('preview key UI is password and explicitly session-only', output.includes('id="cloudPreviewAccessInput" type="password"') && output.includes('只保留在本次页面内'));

check('cleanup hard-locks the exact preview namespace', cleanupRuntime.includes("PREVIEW_FIXTURE_STORE = 'cloud-collab-preview-v1'") && cleanupRuntime.includes('PREVIEW_CLEANUP_STORE_MISMATCH'));
check('cleanup requires preview writes off and independent key', cleanupRuntime.includes('PREVIEW_WRITE_MUST_BE_DISABLED') && cleanupRuntime.includes('PREVIEW_CLEANUP_KEY_REUSED') && cleanupRuntime.includes('timingSafeEqual'));
check('cleanup is inspect-then-execute with manifest digest', cleanupRuntime.includes('manifestDigest') && cleanupRuntime.includes('PREVIEW_CLEANUP_MANIFEST_CHANGED') && cleanupHttp.includes("body.action === 'inspect'") && cleanupHttp.includes("body.action === 'execute'"));
check('cleanup aborts on unknown keys and verifies empty', cleanupRuntime.includes('PREVIEW_CLEANUP_UNKNOWN_KEY') && cleanupRuntime.includes('PREVIEW_CLEANUP_VERIFY_FAILED'));
check('cleanup has no browser wildcard CORS', !cleanupHttp.includes('Access-Control-Allow-Origin'));

const official = findPublicLibrary('group_xiacijian', 'lib_xiacijian_regular');
const fixture = findPublicLibrary('group_fixture', 'lib_receive_fixture');
check('official initial scope stays empty', official?.publicVersion === 0 && official?.snapshot === null && official?.events?.length === 0);
check('fixture scope is isolated and synthetic', fixture?.fixtureOnly === true && fixture?.publicVersion === 3 && cloneSnapshot(fixture)?.records?.length === 2);
check('incremental fixture is ordered and immutable', listChanges(fixture, 0, 100).changes.map(item => item.version).join(',') === '1,2,3');
check('catalog contains no private local fields', !['usageCount','lastUsed','original','timestamp','deviceToken','bossMemory','history'].some(token => read('edge-functions/api/_shared/catalog.js').includes(token)));

const backupBlock = output.match(/getModuleConfigs\(\) \{\s*return \[([\s\S]*?)\];\s*\}/)?.[1] || '';
check('cloud keys remain excluded from standard backup', cloudKeys.every(key => !backupBlock.includes(key)));
const modelBlock = output.match(/const LOCAL_DATA_MODEL_VERSIONS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
check('cloud keys remain outside legacy schema migration', cloudKeys.every(key => !modelBlock.includes(key)));
check('no preview key storage key was added', !['cloudPreviewAccessKey','cloudWritePreviewKey','cloudCleanupKey'].some(key => output.includes(`'${key}'`) || output.includes(`"${key}"`)));
check('no WebSocket/XHR/EventSource added', !/(new\s+WebSocket|XMLHttpRequest|new\s+EventSource)/.test(output));

const forbiddenPrivatePayloadTokens = ['history','orderContent','rawChat','originalChat','notes','recentBosses','layoutTemplates','customRatios','usageCount','lastUsed'];
const submitProjectionBlock = submissionClient.slice(submissionClient.indexOf('async function buildExactPriceSubmission'), submissionClient.indexOf('function shouldRetry'));
check('submission projection contains none of the private payload fields', forbiddenPrivatePayloadTokens.every(token => !submitProjectionBlock.includes(token)));

const forbiddenSecretPatterns = [/(?:api[_-]?token|secret[_-]?key|admin[_-]?password)\s*[:=]\s*['"][^'"]+/i, /Bearer\s+[A-Za-z0-9._-]{12,}/];
const productionFiles = [
  output, apiSource, previewWriteRouteSource, cleanupRoute, previewRuntime, previewHttp, edgeOneBlobRuntime,
  blobRepository, deviceRegistration, submissionAcceptance, read('src/server/submission_policy_v1.js'),
  read('src/cloud_collab_readonly_client.js'), read('src/cloud_collab_snapshot_sync.js'), submissionClient,
  submissionFeature, cleanupRuntime, cleanupHttp, envExample,
];
check('no credential is hardcoded', forbiddenSecretPatterns.every(pattern => productionFiles.every(text => !pattern.test(text))));

const before = sha(output);
const rebuild = spawnSync(process.execPath, [path.join(root,'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
const after = sha(fs.readFileSync(outputPath,'utf8'));
check('build is reproducible', rebuild.status === 0 && before === after, { before, after, stderr: rebuild.stderr.trim() });

const failed = checks.filter(item => !item.ok);
const result = { stage: '4C-client-and-cleanup-gate', candidateSha256: after, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root,'test-results'), { recursive: true });
fs.writeFileSync(path.join(root,'test-results','阶段4C_静态与边界验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed, candidateSha256: result.candidateSha256 }, null, 2));
process.exit(failed.length ? 1 : 0);
