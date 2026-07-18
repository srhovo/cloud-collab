import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const runtime = read('src/server/preview_cleanup_v1.js');
const http = read('src/server/preview_cleanup_http_v1.js');
const route = read('cloud-functions/one-shot/cleanup-preview.js');
const env = read('.env.example');
const checks = [];
const check = (name, ok, details = null) => checks.push({ name, ok: Boolean(ok), details });

check('cleanup route is isolated outside normal API routes',
  fs.existsSync(path.join(root, 'cloud-functions/one-shot/cleanup-preview.js'))
  && !fs.existsSync(path.join(root, 'cloud-functions/api/cleanup-preview.js')));
check('cleanup route is a thin shared-handler adapter',
  route.includes('handlePreviewCleanupRequest') && route.includes('resolveCloudFunctionContext'));
check('cleanup and preview writes default disabled',
  env.includes('CLOUD_PREVIEW_CLEANUP_ENABLED=0') && env.includes('CLOUD_WRITE_PREVIEW_ENABLED=0'));
check('cleanup secrets and confirmation examples stay blank',
  /CLOUD_PREVIEW_CLEANUP_KEY=\s*(?:\r?\n|$)/.test(env)
  && /CLOUD_PREVIEW_CLEANUP_CONFIRMATION=\s*(?:\r?\n|$)/.test(env));
check('cleanup uses a dedicated secret distinct from preview write access',
  runtime.includes('CLOUD_PREVIEW_CLEANUP_KEY')
  && runtime.includes('PREVIEW_CLEANUP_KEY_REUSED')
  && runtime.includes("x-cloud-collab-cleanup-key")
  && !runtime.includes("x-cloud-collab-preview-key"));
check('cleanup is hard-locked to preview namespace',
  runtime.includes("PREVIEW_CLEANUP_NAMESPACE = 'cloud-collab-preview-v1'")
  && runtime.includes('PREVIEW_CLEANUP_NAMESPACE_MISMATCH'));
check('cleanup requires preview writes to remain disabled',
  runtime.includes("CLOUD_WRITE_PREVIEW_ENABLED || '').trim() !== '0'")
  && runtime.includes('PREVIEW_WRITE_MUST_REMAIN_DISABLED'));
check('cleanup is hard-locked to fixture scope',
  runtime.includes("FIXTURE_GROUP_ID = 'group_fixture'")
  && runtime.includes("FIXTURE_LIBRARY_ID = 'lib_receive_fixture'")
  && runtime.includes('PREVIEW_CLEANUP_SCOPE_MISMATCH'));
check('cleanup access uses timing-safe comparison', runtime.includes('timingSafeEqual') && runtime.includes('assertPreviewCleanupAccess'));
check('cleanup exposes inspect before execute and requires exact digest',
  runtime.includes('inspectSyntheticPreviewObjects')
  && runtime.includes('expectedKeySetDigest')
  && runtime.includes('PREVIEW_CLEANUP_KEYSET_CHANGED')
  && http.includes("value.action === 'inspect'")
  && http.includes("value.action === 'execute'"));
check('cleanup enumerates strongly and re-lists after deletion',
  runtime.includes("store.list({ consistency: 'strong' })")
  && (runtime.match(/listKeysStrong\(store\)/g) || []).length >= 3
  && runtime.includes('await store.delete(key)'));
check('cleanup validates every key and digest before first delete',
  runtime.indexOf('assertAllSynthetic(before);') >= 0
  && runtime.indexOf('beforeDigest !== expectedDigest') >= 0
  && runtime.indexOf('beforeDigest !== expectedDigest') < runtime.indexOf('await store.delete(key)'));
check('cleanup allowlist covers only stage4B.2 object families',
  ['devices\\/profiles', 'devices\\/token-index', 'submissions\\/lib_receive_fixture\\/pending', 'preview-rate'].every(token => runtime.includes(token)));
check('unsafe keys abort without returning raw names',
  runtime.includes('PREVIEW_CLEANUP_UNSAFE_OBJECTS')
  && runtime.includes('unsafeKeySetDigest')
  && !http.includes('unsafeKeys'));
const configIndex = http.indexOf('readPreviewCleanupConfig(env)');
const accessIndex = http.indexOf('assertPreviewCleanupAccess(context.request, config)');
const bodyIndex = http.indexOf('readBody(context.request)');
const storeIndex = http.indexOf('createStore(env)');
check('HTTP gate runs config and secret before body and Blob access',
  configIndex >= 0 && configIndex < accessIndex && accessIndex < bodyIndex && bodyIndex < storeIndex);
check('HTTP route permits only POST and does not enable cross-origin browser calls',
  http.includes("method !== 'POST'")
  && http.includes("Allow: 'POST'")
  && !http.includes('Access-Control-Allow-Origin')
  && http.includes("'Cross-Origin-Resource-Policy': 'same-origin'"));
check('cleanup production code contains no production public scope IDs',
  ![runtime, http, route].some(text => /group_xiacijian|lib_xiacijian_regular/.test(text)));
check('no secret or bearer credential is hardcoded',
  ![runtime, http, route, env].some(text => /Bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_-]?token|secret[_-]?key|admin[_-]?password)\s*[:=]\s*['"][^'"]+/i.test(text)));

const failed = checks.filter(item => !item.ok);
const result = { stage: '4C-one-shot-preview-cleanup', total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段4C_一次性清理静态验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed }, null, 2));
process.exit(failed.length ? 1 : 0);
