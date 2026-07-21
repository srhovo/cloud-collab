import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = relative => JSON.parse(read(relative));
const fail = message => { throw new Error(`阶段8Q失败：${message}`); };

const evidence = readJson('release/edgeone-host-isolation-evidence-stage8q.json');
if (evidence.schemaVersion !== 1 || evidence.stage !== '8Q') fail('证据版本无效');
if (evidence.project?.name !== 'cloud-collab'
    || evidence.project?.edgeOneProjectCount !== 1
    || evidence.project?.accelerationRegion !== 'global_excluding_chinese_mainland') fail('项目证据无效');
if (evidence.origins?.public !== 'https://app.xiaxue.site'
    || evidence.origins?.admin !== 'https://admin.xiaxue.site') fail('正式Origin无效');

for (const [name, value] of Object.entries(evidence.checks ?? {})) {
  if (name === 'certificateWarningsObserved') {
    if (value !== false) fail('不应记录证书警告');
  } else if (value !== true) {
    fail(`${name}未通过`);
  }
}

if (evidence.originTemplateFrozen !== true
    || evidence.privateValuesGenerated !== false
    || evidence.environmentVariablesWrittenToEdgeOne !== false
    || evidence.realBlobOperationsPerformed !== 0
    || evidence.productionActivationAllowed !== false
    || evidence.productionActivationPerformed !== false
    || evidence.stablePromotionAuthorized !== false
    || evidence.stablePromotionPerformed !== false) fail('关闭边界无效');

const env = read('config/production.env.template');
const required = [
  'CLOUD_PRODUCTION_PUBLIC_ORIGIN=https://app.xiaxue.site',
  'CLOUD_ADMIN_PUBLIC_ORIGIN=https://admin.xiaxue.site',
  'CLOUD_PRODUCTION_EXTERNAL_CLUB_ID=see',
  'CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID=see_cz',
  'CLOUD_PRODUCTION_GROUP_ID=group_see',
  'CLOUD_PRODUCTION_LIBRARY_ID=lib_see_cz',
  'CLOUD_PRODUCTION_BLOB_STORE_NAME=cloud-collab-production-v1',
  'CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME=cloud-collab-admin-production-v1',
  'CLOUD_ADMIN_USERNAME=xiaxue'
];
for (const line of required) if (!env.includes(`${line}\n`)) fail(`模板缺少 ${line}`);

const zeroFlags = [
  'CLOUD_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
  'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
  'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
  'CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED',
  'CLOUD_PRODUCTION_EXPORT_ENABLED',
  'CLOUD_ADMIN_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED'
];
for (const key of zeroFlags) if (!env.includes(`${key}=0\n`)) fail(`${key}必须保持0`);

const blankPrivateValues = [
  'CLOUD_ADMIN_PASSWORD',
  'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
  'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_SESSION_SECRET',
  'CLOUD_ADMIN_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_DEVICE_REF_SALT',
  'CLOUD_ADMIN_ROLLBACK_REF_SALT',
  'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
  'CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION'
];
for (const key of blankPrivateValues) if (!env.includes(`${key}=\n`)) fail(`${key}不得写入仓库`);

console.log('阶段8Q Host隔离证据、正式Origin和零开关模板通过');
