import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const output = read('dist/index.html');
const namedOutput = read('dist/码单器8.2.28_云端协作候选版.html');
const manifest = JSON.parse(read('dist/build-manifest.json'));
const writeClient = read('src/cloud_collab_write_client.js');
const builder = read('src/cloud_collab_submission_builder.js');
const dispatcher = read('src/cloud_collab_queue_dispatcher.js');
const featureMethods = read('src/cloud_collab_write_feature_methods.fragment.js');
const build = read('scripts/build-stage4c.mjs');
const checks = [];
const check = (name, ok, details = null) => checks.push({ name, ok: Boolean(ok), details });
const sha = text => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');

check('candidate is 8.2.28 and has a named single-file output',
  output.includes("const APP_VERSION = '8.2.28';")
  && output.includes('<title>码单器8.2.28（云端协作上传基础候选）</title>')
  && output === namedOutput);
check('build manifest is fail-closed Stage4C',
  manifest.version === '8.2.28' && manifest.writeEnabled === false
  && manifest.stage === '4C-client-upload-foundation-fail-closed'
  && manifest.sha256 === sha(output));
check('single inline script remains', (output.match(/<script(?:\s[^>]*)?>/gi) || []).length === 1);
const script = output.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i)?.[1] || '';
const temp = path.join(os.tmpdir(), `stage4c-client-${process.pid}.js`);
fs.writeFileSync(temp, script, 'utf8');
const syntax = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
fs.rmSync(temp, { force: true });
check('8.2.28 inline JavaScript syntax passes', syntax.status === 0, syntax.stderr.trim());

check('write meta is hardcoded disabled',
  output.includes('<meta name="cloud-collab-write-enabled" content="0">')
  && !build.includes('CLOUD_COLLAB_WRITE_ENABLED'));
check('write client has only registration and candidate paths',
  writeClient.includes("REGISTER_PATH = '/api/device/register'")
  && writeClient.includes("SUBMIT_PATH = '/api/submissions/create'"));
check('write client never sends preview or admin secrets',
  !/x-cloud-collab-preview-key/i.test(writeClient)
  && !/admin(?:Token|Authorization|Password)/.test(writeClient));
check('network requests omit ambient credentials and use no cache',
  writeClient.includes("credentials: 'omit'") && writeClient.includes("cache: 'no-store'"));
check('device token is persisted only through dedicated credential store',
  writeClient.includes('credentialStore.save(credential)')
  && writeClient.includes('credentialStore.getRedacted')
  && !featureMethods.includes('deviceToken'));
check('write errors classify 429, 401, 403, 409 and 5xx',
  ['status === 429','status === 401','status === 403','status === 409','status >= 500'].every(token => writeClient.includes(token)));
check('dispatcher degrades safely while disabled, offline or hidden',
  dispatcher.includes("status: 'disabled'")
  && dispatcher.includes("status: 'offline'")
  && dispatcher.includes("status: 'hidden'"));
check('dispatcher requires collaborate binding before network submission',
  dispatcher.indexOf("binding.mode !== 'collaborate'") >= 0
  && dispatcher.indexOf("binding.mode !== 'collaborate'") < dispatcher.indexOf('ensureCredential()'));
check('dispatcher writes acknowledged, retry_wait and blocked states',
  dispatcher.includes("'retry_wait'")
  && dispatcher.includes('markAcknowledged')
  && dispatcher.includes('markBlocked'));
check('429 Retry-After can extend local backoff',
  writeClient.includes('parseRetryAfter')
  && dispatcher.includes('Math.max(base, serverDelay)'));
check('credential-invalid response clears only dedicated credential store',
  dispatcher.includes('this.credentialStore.clear()')
  && !dispatcher.includes('localStorage.clear'));
check('first-binding projection is exact-price upsert only',
  builder.includes("dataType: 'exact_price'")
  && builder.includes("operation: 'upsert'")
  && builder.includes("origin: 'initialBinding'"));
check('first-binding projection copies only service, settle type and unit price',
  builder.includes('serviceName: item?.serviceType')
  && builder.includes('settleType: item?.settleType')
  && builder.includes('unitPrice: item?.unitPrice'));
check('first-binding skips public-identical, conflicts and already queued records',
  ['already_public','open_conflict','already_queued'].every(token => builder.includes(token)));
check('receive/local mode cannot create first-binding candidates',
  builder.includes("binding.mode !== 'collaborate'")
  && featureMethods.includes("binding.mode !== 'collaborate'"));
check('public comparison precedes initial candidate generation',
  output.indexOf('const syncResult = await this.syncBinding') >= 0
  && output.indexOf('const syncResult = await this.syncBinding') < output.indexOf('handleCollaborativeBindingReady(binding, syncResult)'));
check('cloud pull path still never enqueues submissions',
  !output.slice(output.indexOf('async syncBinding'), output.indexOf('commitSyncMetadata')).includes('enqueueSubmission'));

const forbiddenPayloadFields = ['history','orderContent','rawChat','originalChat','notes','recentBosses','layoutTemplates','customRatios','usageCount','lastUsed','personalSort'];
check('network envelope contains no private payload fields',
  forbiddenPayloadFields.every(field => !builder.includes(`${field}:`) && !writeClient.includes(`${field}:`)));
check('no hardcoded credential material',
  ![output, writeClient, builder, dispatcher].some(text => /Bearer\s+[A-Za-z0-9._-]{12,}|dt_v1_[A-Za-z0-9_-]{43}|(?:api[_-]?token|secret[_-]?key|admin[_-]?password)\s*[:=]\s*['"][^'"]+/i.test(text)));
check('no formal mutation, auto approval or admin review is enabled',
  !output.includes('publicMutationAllowed: true')
  && !output.includes('autoApprovalEnabled: true')
  && !output.includes('adminReview: true'));
check('legacy schemas remain unchanged', [
  'const LOCAL_DATA_SCHEMA_VERSION = 5;',
  'const PRICE_LIBRARY_SCHEMA_VERSION = 3;',
  'const BACKUP_SCHEMA_VERSION = 4;',
  'const ORDER_PROJECT_SCHEMA_VERSION = 2;',
].every(token => output.includes(token)));

const failed = checks.filter(item => !item.ok);
const result = { stage: '4C-client-8.2.28', candidateSha256: sha(output), total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks };
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results', '阶段4C_客户端8.2.28静态验证结果.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ stage: result.stage, total: result.total, passed: result.passed, failed: result.failed, candidateSha256: result.candidateSha256 }, null, 2));
process.exit(failed.length ? 1 : 0);
