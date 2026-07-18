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
check('candidate is 8.2.27 receive-sync build', output.includes("const APP_VERSION = '8.2.27';") && output.includes('<title>码单器8.2.27（公共协作只接收同步候选）</title>'));
check('legacy schema versions unchanged', [
  'const LOCAL_DATA_SCHEMA_VERSION = 5;',
  'const PRICE_LIBRARY_SCHEMA_VERSION = 3;',
  'const BACKUP_SCHEMA_VERSION = 4;',
  'const ORDER_PROJECT_SCHEMA_VERSION = 2;',
].every(token => output.includes(token)));
check('single inline script retained', (output.match(/<script(?:\s[^>]*)?>/gi) || []).length === 1);

const scriptMatch = output.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i);
const temp = path.join(os.tmpdir(), `stage3b-${process.pid}.js`);
fs.writeFileSync(temp, scriptMatch?.[1] || '', 'utf8');
const syntax = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
fs.rmSync(temp, { force: true });
check('candidate JavaScript syntax passes', syntax.status === 0, syntax.stderr.trim());

for (const className of ['LocalDataSchemaManager','BossDirectory','PriceLibraryStore','OrderFlowFeature','DataPortabilityFeature']) {
  check(`${className} unchanged from Stage2C`, extractClass(source, className) === extractClass(output, className));
}
check('API base is build-time meta config', output.includes('<meta name="cloud-collab-api-base" content="">'));
check('startup check is asynchronous and not awaited', output.includes('this.cloudCollabFeature.scheduleReadonlyCheck();') && output.includes('setTimeout(async () =>'));
check('five-minute visible-page polling is configured', output.includes('}, 300000);') && output.includes("document.visibilityState === 'hidden'"));
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
check('protocol advertises read abilities and no public writes', apiSource.includes('snapshotRead: true') && apiSource.includes('incrementalRead: true') && apiSource.includes('exactPriceReceive: true') && apiSource.includes('submission: false') && apiSource.includes('adminReview: false'));
check('CORS allows credential-free local HTML reads', read('edge-functions/api/_shared/http.js').includes("'Access-Control-Allow-Origin': '*'"));
check('snapshot and changes endpoints impose read bounds', read('edge-functions/api/public-changes.js').includes('limit > 100') && read('edge-functions/api/public-snapshot.js').includes('ifVersion'));

const writeRoutes = listJsRecursive('cloud-functions/api');
const expectedWriteRoutes = ['device/register.js','submissions/create.js'];
check('only two isolated Cloud write routes exist', JSON.stringify(writeRoutes) === JSON.stringify(expectedWriteRoutes), writeRoutes);
const writeRouteSource = expectedWriteRoutes.map(rel => read(`cloud-functions/api/${rel}`)).join('\n');
check('Cloud write routes are thin shared-handler adapters', writeRouteSource.includes('handleDeviceRegisterRequest') && writeRouteSource.includes('handleSubmissionCreateRequest') && (writeRouteSource.match(/export default async function onRequest/g) || []).length === 2);

const previewRuntime = read('src/server/preview_write_runtime_v1.js');
const previewHttp = read('src/server/preview_write_http_v1.js');
const edgeOneBlobRuntime = read('src/server/edgeone_blob_runtime_v1.js');
const blobRepository = read('src/server/blob_repository_v1.js');
const deviceRegistration = read('src/server/device_registration_v1.js');
const submissionAcceptance = read('src/server/submission_acceptance_v1.js');
const packageJson = JSON.parse(read('package.json'));
const envExample = read('.env.example');
check('Blob SDK version is pinned', packageJson.dependencies?.['@edgeone/pages-blob'] === '0.0.14');
check('preview write defaults disabled in env example', envExample.includes('CLOUD_WRITE_PREVIEW_ENABLED=0'));
check('preview write requires explicit feature flag and fixture scope env', ['CLOUD_WRITE_PREVIEW_ENABLED','CLOUD_WRITE_ALLOWED_GROUP_ID','CLOUD_WRITE_ALLOWED_LIBRARY_ID','CLOUD_RATE_LIMIT_SALT'].every(token => previewRuntime.includes(token)));
check('HTTP handlers fail closed before Blob initialization', previewHttp.indexOf('readPreviewWriteConfig(env);') < previewHttp.indexOf('createStore(env)'));
check('write HTTP CORS allows only POST/OPTIONS and explicit Authorization', previewHttp.includes("'Access-Control-Allow-Methods': 'POST, OPTIONS'") && previewHttp.includes('Accept, Content-Type, Authorization'));
check('registration and submission request limits are present', previewHttp.includes('MAX_REGISTRATION_BYTES = 4 * 1024') && previewHttp.includes('MAX_SUBMISSION_BYTES'));
check('Blob runtime uses strong consistency', edgeOneBlobRuntime.includes("getStore({ name, consistency: 'strong' })"));
check('immutable Blob writes remain only-if-new', blobRepository.includes("{ onlyIfNew: true }"));
check('device token plaintext is returned once but only hash is persisted', deviceRegistration.includes('deviceToken,') && deviceRegistration.includes('tokenHash,') && !deviceRegistration.includes('profile.deviceToken'));
check('submission rate gate preserves existing idempotent candidates', previewRuntime.includes('pendingSubmissionKey') && previewRuntime.includes('if (!existingCandidate)'));
check('candidate acceptance cannot mutate public data', submissionAcceptance.includes('publicMutationAllowed: false') && submissionAcceptance.includes('autoApprovalEnabled: false'));
check('8.2.27 page still has no upload dispatcher', !output.includes('/api/device/register') && !output.includes('/api/submissions/create'));

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
check('no network cache key added to localStorage', !['cloudApiConfig','cloudServerState','cloudPublicSnapshot','cloudPublicVersionCache'].some(key => output.includes(`'${key}'`) || output.includes(`"${key}"`)));
check('no WebSocket/XHR/EventSource added', !/(new\s+WebSocket|XMLHttpRequest|new\s+EventSource)/.test(output));

const forbiddenSecretPatterns = [/(?:api[_-]?token|secret[_-]?key|admin[_-]?password)\s*[:=]\s*['"][^'"]+/i, /Bearer\s+[A-Za-z0-9._-]{12,}/];
const productionFiles = [
  output,
  apiSource,
  writeRouteSource,
  previewRuntime,
  previewHttp,
  edgeOneBlobRuntime,
  blobRepository,
  deviceRegistration,
  submissionAcceptance,
  read('src/server/submission_policy_v1.js'),
  read('src/cloud_collab_readonly_client.js'),
  read('src/cloud_collab_snapshot_sync.js'),
];
check('no credential is hardcoded', forbiddenSecretPatterns.every(pattern => productionFiles.every(text => !pattern.test(text))));

const before = sha(output);
const rebuild = spawnSync(process.execPath, [path.join(root,'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
const after = sha(fs.readFileSync(outputPath,'utf8'));
check('build is reproducible', rebuild.status === 0 && before === after, { before, after, stderr: rebuild.stderr.trim() });

const failed = checks.filter(item => !item.ok);
const result = { stage: '4B.2', candidateSha256: after, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root,'test-results'), { recursive: true });
fs.writeFileSync(path.join(root,'test-results','阶段4B2_静态与边界验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed, candidateSha256: result.candidateSha256 }, null, 2));
process.exit(failed.length ? 1 : 0);
