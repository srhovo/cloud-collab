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
const domainSelection = JSON.parse(read('release/production-domain-selection-v1.json'));
const launch = JSON.parse(read('release/production-launch-plan-v1.json'));
const templateText = read('config/production.env.template');
const env = parseEnv(templateText);
const toolHtml = read('tools/production-secret-generator.html');
const toolJs = read('tools/production-secret-generator.js');
const toolCss = read('tools/production-secret-generator.css');

if (handoff.schemaVersion !== 7 || handoff.stage !== '8E' || handoff.revisedAtStage !== '8Q') fail('交接计划版本无效');
if (handoff.status !== 'custom_domains_https_and_host_isolation_verified_waiting_private_values') fail('交接计划状态无效');
if (handoff.recommendedBootstrapWorkflow !== 'stage8h-edgeone-production-bootstrap') fail('初始化工作流版本无效');
if (handoff.domain?.registrableDomain !== 'xiaxue.site'
    || handoff.domain?.publicOrigin !== 'https://app.xiaxue.site'
    || handoff.domain?.administratorOrigin !== 'https://admin.xiaxue.site') fail('正式域名计划无效');
if (handoff.domain?.ownershipConfirmed !== true
    || handoff.domain?.realNameConfirmed !== true
    || handoff.domain?.autoRenewEnabled !== true
    || handoff.domain?.dnsProvider !== 'DNSPod'
    || handoff.domain?.dnsControlConfirmed !== true
    || handoff.domain?.customDomainsAddedToSameProject !== true
    || handoff.domain?.dnsConfigured !== true
    || handoff.domain?.httpsVerified !== true
    || handoff.domain?.hostIsolationRealBrowserVerified !== true) fail('域名在线实证无效');

const expectedCnames = Object.freeze({
  'app.xiaxue.site': 'app.xiaxue.site.pages.dnsoe6.com.',
  'admin.xiaxue.site': 'admin.xiaxue.site.pages.dnsoe4.com.',
});
for (const [hostname, cnameTarget] of Object.entries(expectedCnames)) {
  const state = handoff.domain?.customDomainProvisioning?.[hostname];
  if (state?.status !== 'active'
      || state?.cnameVisible !== true
      || state?.cnameTarget !== cnameTarget
      || state?.httpsConfigured !== true
      || state?.realBrowserAccessVerified !== true) fail(`${hostname}在线状态无效`);
}

if (handoff.deployment?.initialAccelerationRegion !== 'global_excluding_chinese_mainland'
    || handoff.deployment?.accelerationRegionVerified !== true
    || handoff.deployment?.icpFilingRequiredForInitialRegion !== false
    || handoff.deployment?.icpFilingDeferred !== true
    || handoff.deployment?.mainlandAccelerationEnabled !== false
    || handoff.deployment?.eligibleMainlandCloudResourcePurchased !== false
    || handoff.deployment?.cloudServerPurchaseRequiredNow !== false
    || handoff.deployment?.futureMainlandAccelerationRequiresIcpFiling !== true) fail('免备案首发路线无效');
if (handoff.architecture?.topology !== 'single_edgeone_project_two_custom_domains'
    || handoff.architecture?.edgeOneProjectCount !== 1
    || handoff.architecture?.singleProjectHostIsolationImplemented !== true
    || handoff.architecture?.singleProjectHostIsolationRealBrowserVerified !== true
    || handoff.architecture?.currentProjectScopedBlobResolved !== true
    || handoff.architecture?.accountApiTokenInLongRunningRuntimeAllowed !== false
    || handoff.architecture?.administratorSeparateProjectRequired !== false
    || handoff.architecture?.administratorSeparateProjectCreationForbidden !== true
    || handoff.architecture?.realBootstrapBlockedByArchitecture !== false
    || handoff.architecture?.realBootstrapAuthorized !== false) fail('单项目双域名架构边界无效');
if (domainSelection.schemaVersion !== 5 || domainSelection.stage !== '8Q'
    || domainSelection.topology !== handoff.architecture.topology
    || domainSelection.edgeOneProjectCount !== 1
    || domainSelection.singleProjectHostIsolationImplemented !== true
    || domainSelection.singleProjectHostIsolationRealBrowserVerified !== true
    || domainSelection.accountApiTokenRequiredAtRuntime !== false
    || domainSelection.domainStatusConfirmed !== true
    || domainSelection.realNameStatusConfirmed !== true
    || domainSelection.dnsControlConfirmed !== true
    || domainSelection.customDomainsAddedToSameProject !== true
    || domainSelection.accelerationRegionVerified !== true
    || domainSelection.dnsConfigured !== true
    || domainSelection.httpsVerified !== true
    || domainSelection.initialAccelerationRegion !== 'global_excluding_chinese_mainland'
    || domainSelection.icpFilingRequiredForInitialRegion !== false) fail('域名选择记录与交接计划不一致');
if (handoff.privateValuesGenerated !== false
    || handoff.environmentVariablesWritten !== false
    || handoff.stablePromotionAuthorized !== false
    || handoff.stablePromotionPerformed !== false
    || handoff.productionActivationPerformed !== false) fail('发布边界必须关闭');
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
  ['CLOUD_PRODUCTION_PUBLIC_ORIGIN', 'https://app.xiaxue.site'],
  ['CLOUD_ADMIN_PUBLIC_ORIGIN', 'https://admin.xiaxue.site'],
  ['CLOUD_ADMIN_USERNAME', 'xiaxue'],
]) if (env.get(name) !== expected) fail(`${name}与冻结计划不一致`);

if (env.get('CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION') !== '') fail('初始化确认词必须保持空');

const privateNames = [...toolHtml.matchAll(/data-private-name="([A-Z0-9_]+)"/gu)].map(match => match[1]);
if (privateNames.length !== 8 || new Set(privateNames).size !== 8) fail('离线工具变量范围无效');
for (const name of privateNames) if (!env.has(name) || env.get(name) !== '') fail(`${name}模板必须为空`);
const combinedTool = `${toolHtml}\n${toolJs}\n${toolCss}`;
if (!toolHtml.includes("connect-src 'none'") || !toolJs.includes('crypto.getRandomValues') || !toolJs.includes('new Uint8Array(48)')) fail('离线工具隔离或随机强度不足');
if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie|navigator\.clipboard/u.test(combinedTool)) fail('离线工具包含禁止接口');
if (/eo_token=/iu.test(templateText + JSON.stringify(handoff) + JSON.stringify(launch))) fail('交接材料不得固化临时令牌');

const actions = Object.freeze([
  Object.freeze({ order: 1, title: '确认xiaxue.site注册、实名、续费和DNS控制权', completed: true, requiredNow: false, path: '已由负责人提供腾讯云域名控制台证据' }),
  Object.freeze({ order: 2, title: '把app和admin域名添加到同一个EdgeOne项目', completed: true, requiredNow: false, path: '两个域名已关联同一个cloud-collab生产环境' }),
  Object.freeze({ order: 3, title: '完成DNS、全球不含大陆区域和免费HTTPS验证', completed: true, requiredNow: false, path: '两个CNAME、加速区域和HTTPS均已由平台截图及浏览器访问确认' }),
  Object.freeze({ order: 4, title: '完成真实浏览器双入口与跨Host失败关闭验收', completed: true, requiredNow: false, path: 'app与admin页面正常；三个跨Host路径均按预期失败关闭' }),
  Object.freeze({ order: 5, title: '本地生成八项私密值并导入单项目环境变量', completed: false, requiredNow: true, path: '使用tools/production-secret-generator.html；所有功能开关继续保持0' }),
  Object.freeze({ order: 6, title: '单独审查是否执行阶段8H初始化', completed: false, requiredNow: false, path: '先plan；真实execute仍需负责人另行批准' }),
  Object.freeze({ order: 7, title: '完成零开关重部署、Blob初始化与分阶段启用', completed: false, requiredNow: false, path: '环境变量导入后先验证关闭态，再按只读、提交、审核、治理、导出顺序推进' }),
]);

const report = Object.freeze({
  schemaVersion: 7,
  stage: '8E',
  revisedAtStage: '8Q',
  status: 'handoff_ready_origins_and_host_isolation_verified_waiting_private_values',
  candidate: Object.freeze({ version: '8.2.31', sha256: launch.candidate.sha256, bytes: launch.candidate.bytes }),
  stable: Object.freeze({ current: '8.2.25', target: '8.3.0', promotionAuthorized: false, promotionPerformed: false }),
  scope: Object.freeze({ external: launch.scope.external, protocol: launch.scope.protocol }),
  domain: Object.freeze({ ...handoff.domain }),
  deployment: Object.freeze({ ...handoff.deployment }),
  architecture: Object.freeze({ ...handoff.architecture }),
  artifacts: Object.freeze({ public: PUBLIC_CANDIDATE_FILES, administratorInternalDirectory: '__admin', administrator: ADMIN_CONSOLE_FILES, toolsDeployed: false }),
  offlineGenerator: Object.freeze({ networkAccess: false, persistentBrowserStorage: false, clipboardApiAccess: false, privateValueCount: 8, randomBytesPerValue: 48 }),
  bootstrap: Object.freeze({ recommendedWorkflow: handoff.recommendedBootstrapWorkflow, domainRequired: false, automaticTrigger: false, operationDefault: 'plan', blockedByArchitectureReview: false, authorized: false, executed: false }),
  manualActions: actions,
  optionalPreDomainActions: Object.freeze([]),
  activationBlockers: Object.freeze(['private_values_unconfigured', 'environment_variables_not_imported', 'real_blob_initialization_not_executed', 'production_feature_flags_all_zero', 'real_environment_l4_not_executed', 'stable_promotion_not_authorized']),
  boundaries: Object.freeze({ deploymentPerformed: true, environmentVariablesWritten: false, realPrivateValuesGenerated: false, realBlobOperationsPerformed: 0, productionActivationPerformed: false, administratorConsoleDeployed: true, stablePromotionAuthorized: false, stablePromotionPerformed: false }),
});

const markdown = [
  '# 生产上线负责人操作清单',
  '',
  'xiaxue.site已完成注册、实名、自动续费、DNS、全球可用区（不含中国大陆）、双域名HTTPS和真实浏览器Host隔离验收。当前不需要购买云服务器，也不要求ICP备案。',
  '',
  '正式Origin已固定为https://app.xiaxue.site与https://admin.xiaxue.site。当前唯一需要执行的是在可信设备本地生成八项私密值，并导入同一个EdgeOne项目；所有功能开关继续保持0。',
  '',
  ...actions.flatMap(item => [`## ${item.order}. ${item.title}`, '', `**状态：** ${item.completed ? '已完成' : '未完成'}`, '', `**现在是否执行：** ${item.requiredNow ? '是' : '否'}`, '', `**路径：** ${item.path}`, '']),
  '## 固定安全边界',
  '',
  '- 只使用一个EdgeOne项目，不创建独立管理员项目。',
  '- 单项目双域名运行时不保存平台账户级访问令牌。',
  '- 八项私密值只在可信设备本地生成，不发送到聊天、不提交GitHub。',
  '- 真实初始化未授权；全部生产功能开关保持0。',
  '- L4完成并单独授权前不得晋升8.3.0。',
  '',
].join('\n');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'production-handoff-v1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(dist, 'production-owner-actions-v1.md'), markdown, 'utf8');
fs.writeFileSync(path.join(dist, 'production-edgeone-env-template-v1.txt'), templateText, 'utf8');
console.log(JSON.stringify(report));
