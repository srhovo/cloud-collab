import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

check('Stage2C source SHA is frozen', sha(source) === expectedSourceSha, sha(source));
check('candidate is 8.2.27', output.includes("const APP_VERSION = '8.2.27';") && output.includes('<title>码单器8.2.27（公共协作只读联调候选）</title>'));
check('legacy schema versions unchanged', [
  'const LOCAL_DATA_SCHEMA_VERSION = 5;',
  'const PRICE_LIBRARY_SCHEMA_VERSION = 3;',
  'const BACKUP_SCHEMA_VERSION = 4;',
  'const ORDER_PROJECT_SCHEMA_VERSION = 2;',
].every(token => output.includes(token)));
check('single inline script retained', (output.match(/<script(?:\s[^>]*)?>/gi) || []).length === 1);

const scriptMatch = output.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i);
const temp = path.join(os.tmpdir(), `stage3a-${process.pid}.js`);
fs.writeFileSync(temp, scriptMatch?.[1] || '', 'utf8');
const syntax = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
fs.rmSync(temp, { force: true });
check('candidate JavaScript syntax passes', syntax.status === 0, syntax.stderr.trim());

for (const className of ['LocalDataSchemaManager','BossDirectory','PriceLibraryStore','OrderFlowFeature','DataPortabilityFeature']) {
  check(`${className} unchanged from Stage2C`, extractClass(source, className) === extractClass(output, className));
}
check('API base is build-time meta config', output.includes('<meta name="cloud-collab-api-base" content="">'));
check('startup schedules readonly check without await', output.includes('this.cloudCollabFeature.scheduleReadonlyCheck();') && output.includes('setTimeout(() => this.checkServer({ interactive: false }), 0);'));
check('readonly client omits credentials', output.includes("credentials: 'omit'") && output.includes("method: 'GET'"));
check('readonly client sends no Authorization header', !output.slice(output.indexOf('class CloudCollabReadonlyApi'), output.indexOf('class CloudCollabFeature')).includes('Authorization'));
check('readonly API response is not persisted', !output.slice(output.indexOf('async checkServer'), output.indexOf('getModeLabel(mode)')).includes('setPersistent('));
check('public-version response is transient', output.includes('this.lastPublicVersion = data;') && !output.includes('lastPublicVersionStore'));
check('no submission/admin endpoint exists', !fs.existsSync(path.join(root,'edge-functions','api','submit.js')) && !fs.existsSync(path.join(root,'edge-functions','api','admin')));

const apiEntries = fs.readdirSync(path.join(root,'edge-functions','api')).filter(name => name.endsWith('.js')).sort();
check('only three public API routes exist', JSON.stringify(apiEntries) === JSON.stringify(['health.js','protocol.js','public-version.js']), apiEntries);
const apiSource = apiEntries.map(name => fs.readFileSync(path.join(root,'edge-functions','api',name),'utf8')).join('\n');
check('edge routes use read-only method gate', apiEntries.every(name => fs.readFileSync(path.join(root,'edge-functions','api',name),'utf8').includes('methodNotAllowed')));
check('edge routes expose no write capability', !apiSource.includes('writeEnabled: true') && !apiSource.includes('onRequestPost'));
check('CORS allows credential-free local HTML reads', fs.readFileSync(path.join(root,'edge-functions','api','_shared','http.js'),'utf8').includes("'Access-Control-Allow-Origin': '*'"));
check('test catalog contains no business records', fs.readFileSync(path.join(root,'edge-functions','api','_shared','catalog.js'),'utf8').includes("publicVersion: 0") && !fs.readFileSync(path.join(root,'edge-functions','api','_shared','catalog.js'),'utf8').includes('unitPrice'));

const backupBlock = output.match(/getModuleConfigs\(\) \{\s*return \[([\s\S]*?)\];\s*\}/)?.[1] || '';
check('cloud keys remain excluded from standard backup', cloudKeys.every(key => !backupBlock.includes(key)));
const modelBlock = output.match(/const LOCAL_DATA_MODEL_VERSIONS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
check('cloud keys remain outside legacy schema migration', cloudKeys.every(key => !modelBlock.includes(key)));
check('no new cloud persistence key added', !['cloudApiConfig','cloudServerState','cloudPublicVersionCache'].some(key => output.includes(`'${key}'`) || output.includes(`"${key}"`)));

const forbiddenSecretPatterns = [/(?:api[_-]?token|secret[_-]?key|admin[_-]?password)\s*[:=]\s*['"][^'"]+/i, /Bearer\s+[A-Za-z0-9._-]{12,}/];
const productionFiles = [output, apiSource, fs.readFileSync(path.join(root,'src','cloud_collab_readonly_client.js'),'utf8')];
check('no credential is hardcoded', forbiddenSecretPatterns.every(pattern => productionFiles.every(text => !pattern.test(text))));

const before = sha(output);
const rebuild = spawnSync(process.execPath, [path.join(root,'scripts','build.mjs')], { cwd: root, encoding: 'utf8' });
const after = sha(fs.readFileSync(outputPath,'utf8'));
check('build is reproducible', rebuild.status === 0 && before === after, { before, after, stderr: rebuild.stderr.trim() });

const failed = checks.filter(item => !item.ok);
const result = { stage: '3A', candidateSha256: after, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root,'test-results'), { recursive: true });
fs.writeFileSync(path.join(root,'test-results','阶段3A_静态与边界验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ total: result.total, passed: result.passed, failed: result.failed, candidateSha256: result.candidateSha256 }, null, 2));
process.exit(failed.length ? 1 : 0);
