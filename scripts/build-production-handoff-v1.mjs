import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_CANDIDATE_FILES } from './prepare-public-candidate-v1.mjs';
import { ADMIN_CONSOLE_FILES } from './prepare-admin-console-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = message => { throw new Error(`生产交接构建失败：${message}`); };

function parseEnv(text) {
  const result = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) fail(`环境变量行无效：${line}`);
    const name = line.slice(0, index).trim();
    if (result.has(name)) fail(`环境变量重复：${name}`);
    result.set(name, line.slice(index + 1));
  }
  return result;
}

const handoff = JSON.parse(read('release/production-handoff-plan-v1.json'));
const launch = JSON.parse(read('release/production-launch-plan-v1.json'));
const templateText = read('config/production.env.template');
const env = parseEnv(templateText);
const toolHtml = read('tools/production-secret-generator.html');
const toolJs = read('tools/production-secret-generator.js');
const toolCss = read('tools/production-secret-generator.css');

if (handoff.schemaVersion !== 3 || handoff.stage !== '8E' || handoff.revisedAtStage !== '8I') fail('交接计划版本无效');
if (handoff.status !== 'domain_selected_architecture_review_required_before_platform_write') fail('交接计划状态无效');
if (handoff.recommendedBootstrapWorkflow !== 'stage8h-edgeone-production-bootstrap') fail('初始化工作流版本无效');
if (handoff.domain?.registrableDomain !== 'xiaxue.site'
    || handoff.domain?.publicOrigin !== 'https://app.xiaxue.site'
    || handoff.domain?.administratorOrigin !== 'https://admin.xiaxue.site') fail('正式域名计划无效');
if (handoff.domain?.ownershipConfirmed !== false || handoff.domain?.dnsConfigured !== false || handoff.domain?.httpsVerified !== false) fail('未验收域名不得标记就绪');
if (handoff.architecture?.currentProjectScopedBlobDetected !== true
    || handoff.architecture?.accountApiTokenInLongRunningRuntimeAllowed !== false
    || handoff.architecture?.administratorProjectCreationBlocked !== true
    || handoff.architecture?.realBootstrapBlocked !== true) fail('跨项目存储阻断边界无效');
if (handoff.stablePromotionAuthorized !== false || handoff.stablePromotionPerformed !== false || handoff.productionActivationPerformed !== false) fail('发布边界必须关闭');
if (launch.candidate?.version !== '8.2.31'
    || launch.candidate?.sha256 !== '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b'
    || launch.candidate?.bytes !== 1155575) fail('冻结候选身份无效');

const flags = [
  'CLOUD_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
  'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
  'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
  'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
  'CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED',
  'CLOUD_PRODUCTION_EXPORT_ENABLED',
  'CLOUD_ADMIN_PRODUCTION_ENABLED',
  'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED',
];
for (const name of flags) if (env.get(name) !== '0') fail(`${name}必须默认关闭`);

for (const [name, expected] of [
  ['CLOUD_PRODUCTION_EXTERNAL_CLUB_ID', 'see'],
  ['CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID', 'see_cz'],
  ['CLOUD_PRODUCTION_GROUP_ID', 'group_see'],
  ['CLOUD_PRODUCTION_LIBRARY_ID', 'lib_see_cz'],
  ['CLOUD_PRODUCTION_BLOB_STORE_NAME', 'cloud-collab-production-v1'],
  ['CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME', 'cloud-collab-admin-production-v1'],
  ['CLOUD_ADMIN_USERNAME', 'xiaxue'],
]) if (env.get(name) !== expected) fail(`${name}与冻结计划不一致`);

if (env.get('CLOUD_PRODUCTION_PUBLIC_ORIGIN') !== '' || env.get('CLOUD_ADMIN_PUBLIC_ORIGIN') !== '') fail('DNS与HTTPS验收前正式来源必须保持空');
if (env.get('CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION') !== '') fail('初始化确认词必须保持空');

const privateNames = [...toolHtml.matchAll(/data-private-name="([A-Z0-9_]+)"/gu)].map(match => match[1]);
if (privateNames.length !== 8 || new Set(privateNames).size !== 8) fail('离线工具变量范围无效');
for (const name of privateNames) if (!env.has(name) || env.get(name) !== '') fail(`${name}模板必须为空`);
const combinedTool = `${toolHtml}\n${toolJs}\n${toolCss}`;
if (!toolHtml.includes("connect-src 'none'") || !toolJs.includes('crypto.getRandomValues') || !toolJs.includes('new Uint8Array(48)')) fail('离线工具隔离或随机强度不足');
if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie|navigator\.clipboard/u.test(combinedTool)) fail('离线工具包含禁止接口');
if (/eo_token=/iu.test(templateText + JSON.stringify(handoff) + JSON.stringify(launch))) fail('交接材料不得固化临时令牌');

const actions = Object.freeze([
  Object.freeze({ order: 1, title: '确认xiaxue.site注册、实名和正常状态', requiredNow: true, path: '腾讯云控制台 → 域名注册 → 我的域名 → xiaxue.site' }),
  Object.freeze({ order: 2, title: '等待阶段8I跨项目存储架构审计', requiredNow: true, path: '当前不创建管理员项目，不运行真实初始化' }),
  Object.freeze({ order: 3, title: '绑定并验证app.xiaxue.site', requiredNow: false, path: '架构审计通过后按EdgeOne域名向导配置DNS与HTTPS' }),
  Object.freeze({ order: 4, title: '按最终架构配置admin.xiaxue.site', requiredNow: false, path: '只有阶段8I解除阻断后执行' }),
  Object.freeze({ order: 5, title: '生成私密配置并完成零开关部署', requiredNow: false, path: '在可信设备本地生成；全部生产开关保持0' }),
  Object.freeze({ order: 6, title: '分阶段验收并单独决定稳定晋升', requiredNow: false, path: '完成真实设备L4后再单独授权8.3.0' }),
]);

const report = Object.freeze({
  schemaVersion: 3,
  stage: '8E',
  revisedAtStage: '8I',
  status: 'handoff_ready_domain_selected_architecture_review_required',
  candidate: Object.freeze({ version: '8.2.31', sha256: launch.candidate.sha256, bytes: launch.candidate.bytes }),
  stable: Object.freeze({ current: '8.2.25', target: '8.3.0', promotionAuthorized: false, promotionPerformed: false }),
  scope: Object.freeze({ external: launch.scope.external, protocol: launch.scope.protocol }),
  domain: Object.freeze({ ...handoff.domain }),
  architecture: Object.freeze({ ...handoff.architecture }),
  artifacts: Object.freeze({ public: PUBLIC_CANDIDATE_FILES, administrator: ADMIN_CONSOLE_FILES, toolsDeployed: false }),
  offlineGenerator: Object.freeze({ networkAccess: false, persistentBrowserStorage: false, clipboardApiAccess: false, privateValueCount: 8, randomBytesPerValue: 48 }),
  bootstrap: Object.freeze({ recommendedWorkflow: handoff.recommendedBootstrapWorkflow, domainRequired: false, automaticTrigger: false, operationDefault: 'plan', blockedByArchitectureReview: true, executed: false }),
  manualActions: actions,
  optionalPreDomainActions: Object.freeze([]),
  activationBlockers: Object.freeze(['domain_ownership_unconfirmed', 'dns_unconfigured', 'https_unverified', 'cross_project_blob_architecture_unresolved', 'administrator_project_creation_blocked', 'real_bootstrap_blocked', 'private_values_unconfigured', 'real_environment_l4_not_executed', 'stable_promotion_not_authorized']),
  boundaries: Object.freeze({ deploymentPerformed: false, environmentVariablesWritten: false, realPrivateValuesGenerated: false, realBlobOperationsPerformed: 0, productionActivationPerformed: false, administratorConsoleDeployed: false, stablePromotionAuthorized: false, stablePromotionPerformed: false }),
});

const markdown = [
  '# 生产上线负责人操作清单',
  '',
  '已选择xiaxue.site，计划入口为https://app.xiaxue.site与https://admin.xiaxue.site。当前只确认域名注册、实名和正常状态。',
  '',
  '阶段8I完成跨项目存储架构前，不创建管理员项目，不运行真实Blob初始化。',
  '',
  ...actions.flatMap(item => [`## ${item.order}. ${item.title}`, '', `**现在是否执行：** ${item.requiredNow ? '是' : '否'}`, '', `**路径：** ${item.path}`, '']),
  '## 固定安全边界',
  '',
  '- 真实初始化入口已升级为stage8h-edgeone-production-bootstrap，但当前被阶段8I阻断。',
  '- 不把平台账户级访问令牌放入长期运行的管理员函数。',
  '- DNS与HTTPS验收前两个正式Origin继续留空。',
  '- 不使用带eo_token的临时地址作为正式来源。',
  '- 全部正式能力保持关闭，L4完成前不得晋升8.3.0。',
  '',
].join('\n');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'production-handoff-v1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(dist, 'production-owner-actions-v1.md'), markdown, 'utf8');
fs.writeFileSync(path.join(dist, 'production-edgeone-env-template-v1.txt'), templateText, 'utf8');
console.log(JSON.stringify(report));
