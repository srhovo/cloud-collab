import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.join(root, 'release', 'production-launch-plan-v1.json');
const templatePath = path.join(root, 'config', 'production.env.template');
const outputPath = path.join(root, 'dist', 'production-launch-readiness-v1.json');

function fail(message) {
  throw new Error(`阶段7L生产准备校验失败：${message}`);
}

function parseEnvTemplate(text) {
  const result = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) fail(`环境变量模板行无效：${line}`);
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    if (result.has(key)) fail(`环境变量重复：${key}`);
    result.set(key, value);
  }
  return result;
}

function assertFlag(env, name) {
  if (env.get(name) !== '0') fail(`${name}必须默认关闭`);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const templateText = fs.readFileSync(templatePath, 'utf8');
const env = parseEnvTemplate(templateText);

if (plan.schemaVersion !== 1) fail('计划schemaVersion必须为1');
if (plan.candidate?.version !== '8.2.31') fail('候选版本必须为8.2.31');
if (plan.candidate?.observationPeriod !== 'passed') fail('候选观察期尚未通过');
if (plan.stableRelease?.targetVersion !== '8.3.0') fail('正式目标版本必须为8.3.0');
if (plan.stableRelease?.promotionAuthorized !== false || plan.stableRelease?.promotionPerformed !== false) {
  fail('阶段7L不得授权或执行稳定晋升');
}
if (plan.scope?.groupId !== 'see' || plan.scope?.libraryId !== 'see_cz') fail('正式作用域与负责人决策不一致');
if (!/^[a-z0-9][a-z0-9_]{2,47}$/u.test(plan.scope.groupId)) fail('groupId格式无效');
if (!/^[a-z0-9][a-z0-9_]{2,55}$/u.test(plan.scope.libraryId)) fail('libraryId格式无效');
if (plan.scope?.protocolField !== 'groupId' || plan.scope?.displayLabel !== 'club') fail('club显示层与groupId协议兼容关系无效');

for (const name of [
  'CLOUD_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
  'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
  'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
  'CLOUD_ADMIN_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED',
]) assertFlag(env, name);

if (env.get('CLOUD_PRODUCTION_GROUP_ID') !== 'see') fail('模板groupId不一致');
if (env.get('CLOUD_PRODUCTION_LIBRARY_ID') !== 'see_cz') fail('模板libraryId不一致');
if (env.get('CLOUD_ADMIN_USERNAME') !== 'xiaxue') fail('管理员用户名不一致');
if (env.get('CLOUD_PRODUCTION_BLOB_STORE_NAME') !== 'cloud-collab-production-v1') fail('生产Blob名称不一致');
if (env.get('CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME') !== 'cloud-collab-admin-production-v1') fail('管理员Blob名称不一致');

const secretNames = [
  'CLOUD_ADMIN_PASSWORD',
  'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
  'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_SESSION_SECRET',
  'CLOUD_ADMIN_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_DEVICE_REF_SALT',
  'CLOUD_ADMIN_ROLLBACK_REF_SALT',
  'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
];
for (const name of secretNames) {
  if (!env.has(name)) fail(`缺少密钥变量：${name}`);
  if (env.get(name) !== '') fail(`${name}模板不得包含真实值`);
}

if (/eo_token=/iu.test(templateText) || /eo_token=/iu.test(JSON.stringify(plan))) fail('不得固化临时EdgeOne访问令牌');
if (/group_fixture|lib_receive_fixture|cloud-collab-preview-v1|cloud-collab-admin-preview-v1/u.test(
  [env.get('CLOUD_PRODUCTION_GROUP_ID'), env.get('CLOUD_PRODUCTION_LIBRARY_ID'), env.get('CLOUD_PRODUCTION_BLOB_STORE_NAME'), env.get('CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME')].join('\n'),
)) fail('生产作用域不得复用预览资源');

const authorized = plan.capabilityAuthorization || {};
for (const name of ['readSync', 'ordinarySubmission', 'sensitiveSubmission', 'automaticOrdinaryApproval']) {
  if (authorized[name] !== true) fail(`${name}授权记录缺失`);
}
if (authorized.activationPerformed !== false) fail('阶段7L不得声称已经启用生产能力');
if (plan.access?.platformProjectOrDeploymentDomainPermanentForPublicUse !== false) fail('EdgeOne平台域名永久性判断无效');
if (plan.access?.permanentPrimaryDomainStatus !== 'blocked_pending_owner_controlled_custom_domain') fail('永久入口阻断状态无效');
if (plan.administrator?.submittedChatSecretAccepted !== false) fail('聊天中暴露的管理员密钥不得接受');

const report = Object.freeze({
  schemaVersion: 1,
  status: 'production_preparation_ready_domain_blob_and_secrets_required',
  candidateVersion: plan.candidate.version,
  targetStableVersion: plan.stableRelease.targetVersion,
  groupId: plan.scope.groupId,
  libraryId: plan.scope.libraryId,
  authorizedCapabilities: Object.freeze({
    readSync: true,
    ordinarySubmission: true,
    automaticOrdinaryApproval: true,
    sensitiveSubmission: true,
  }),
  productionActivationPerformed: false,
  stablePromotionAuthorized: false,
  stablePromotionPerformed: false,
  permanentDomainReady: false,
  productionBlobInitialized: false,
  realSecretsConfigured: false,
  secretVariableCount: secretNames.length,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
