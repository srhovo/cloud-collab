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

if (handoff.schemaVersion !== 2 || handoff.stage !== '8E' || handoff.revisedAtStage !== '8G') fail('交接计划版本无效');
if (handoff.status !== 'code_complete_pre_domain_bootstrap_available_waiting_owner_domain_and_platform_configuration') fail('交接计划状态无效');
if (handoff.recommendedBootstrapWorkflow !== 'stage8g-edgeone-production-bootstrap'
    || handoff.bootstrapRequiresOwnerDomain !== false
    || handoff.deploymentBootstrapPathDeprecated !== true) fail('阶段8G初始化路径未收敛');
if (handoff.stablePromotionAuthorized !== false || handoff.stablePromotionPerformed !== false) fail('稳定晋升必须关闭');
if (handoff.productionActivationPerformed !== false) fail('生产能力不得提前启用');
if (launch.candidate?.version !== '8.2.31'
    || launch.candidate?.sha256 !== '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b'
    || launch.candidate?.bytes !== 1155575) fail('冻结候选身份无效');
if (launch.stableRelease?.targetVersion !== '8.3.0'
    || launch.stableRelease?.promotionAuthorized !== false
    || launch.stableRelease?.promotionPerformed !== false) fail('目标稳定版本边界无效');

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

if (env.get('CLOUD_PRODUCTION_PUBLIC_ORIGIN') !== '' || env.get('CLOUD_ADMIN_PUBLIC_ORIGIN') !== '') fail('正式来源必须保持空');
if (env.get('CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION') !== '') fail('初始化确认词必须保持空');

const privateNames = [...toolHtml.matchAll(/data-private-name="([A-Z0-9_]+)"/gu)].map(match => match[1]);
if (privateNames.length !== 8 || new Set(privateNames).size !== 8) fail('离线工具必须包含八项独立变量');
for (const name of privateNames) {
  if (!env.has(name) || env.get(name) !== '') fail(`${name}模板必须存在且为空`);
}

const combinedTool = `${toolHtml}\n${toolJs}\n${toolCss}`;
if (!toolHtml.includes("connect-src 'none'") || !toolJs.includes('crypto.getRandomValues') || !toolJs.includes('new Uint8Array(48)')) fail('离线工具隔离或随机强度不足');
if (!toolJs.includes("window.addEventListener('pagehide', clearPage)")) fail('离线工具必须在pagehide清理');
if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie|navigator\.clipboard/u.test(combinedTool)) fail('离线工具包含禁止接口');
if (/https?:\/\//u.test(toolJs + toolCss)) fail('离线脚本或样式不得引用外部资源');
if (/eo_token=/iu.test(templateText + JSON.stringify(handoff) + JSON.stringify(launch))) fail('交接材料不得固化临时令牌');

const expectedPublic = ['index.html', 'build-manifest.json', 'pages-release.json'];
const expectedAdmin = ['index.html', 'production-console.css', 'production-console.js', 'admin-release.json'];
if (JSON.stringify(PUBLIC_CANDIDATE_FILES) !== JSON.stringify(expectedPublic)) fail('普通用户白名单变化');
if (JSON.stringify(ADMIN_CONSOLE_FILES) !== JSON.stringify(expectedAdmin)) fail('管理员白名单变化');

const actions = Object.freeze([
  Object.freeze({
    order: 1,
    title: '可选：在域名前执行一次性Blob初始化',
    path: 'GitHub Actions → stage8g-edgeone-production-bootstrap → 先plan；配置EDGEONE_PROJECT_ID与EDGEONE_API_TOKEN后再execute',
    requiresOwnerDomain: false,
    requiredNow: false,
  }),
  Object.freeze({
    order: 2,
    title: '准备可控制域名与ICP备案',
    path: '域名注册商控制台；需要时进入工信部ICP备案系统',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
  Object.freeze({
    order: 3,
    title: '绑定普通与管理员正式域名',
    path: 'EdgeOne Makers → cloud-collab项目 → 域名管理 → 添加自定义域名',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
  Object.freeze({
    order: 4,
    title: '在可信设备生成并导入私密配置',
    path: '本地tools/production-secret-generator.html；EdgeOne Makers → 项目设置 → 环境变量',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
  Object.freeze({
    order: 5,
    title: '保持全部开关为0并完成双来源部署核验',
    path: 'EdgeOne Makers → 部署记录；普通用户来源；管理员独立来源',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
  Object.freeze({
    order: 6,
    title: '按顺序开放能力并真实验收',
    path: 'EdgeOne Makers → 项目设置 → 环境变量；部署记录；普通与管理员来源',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
  Object.freeze({
    order: 7,
    title: '完成L4并单独授权8.3.0晋升',
    path: 'GitHub发布审计、EdgeOne真实环境、项目负责人确认',
    requiresOwnerDomain: true,
    requiredNow: false,
  }),
]);

const report = Object.freeze({
  schemaVersion: 2,
  stage: '8E',
  revisedAtStage: '8G',
  status: 'handoff_ready_pre_domain_bootstrap_available',
  candidate: Object.freeze({ version: '8.2.31', sha256: launch.candidate.sha256, bytes: launch.candidate.bytes }),
  stable: Object.freeze({ current: '8.2.25', target: '8.3.0', promotionAuthorized: false, promotionPerformed: false }),
  scope: Object.freeze({ external: launch.scope.external, protocol: launch.scope.protocol }),
  artifacts: Object.freeze({ public: PUBLIC_CANDIDATE_FILES, administrator: ADMIN_CONSOLE_FILES, toolsDeployed: false }),
  offlineGenerator: Object.freeze({ files: ['tools/production-secret-generator.html', 'tools/production-secret-generator.css', 'tools/production-secret-generator.js'], networkAccess: false, persistentBrowserStorage: false, clipboardApiAccess: false, privateValueCount: 8, randomBytesPerValue: 48 }),
  bootstrap: Object.freeze({
    recommendedWorkflow: handoff.recommendedBootstrapWorkflow,
    domainRequired: false,
    automaticTrigger: false,
    operationDefault: 'plan',
    executeRequires: Object.freeze(['operation=execute', 'exact_confirmation', 'EDGEONE_PROJECT_ID', 'EDGEONE_API_TOKEN']),
    deploymentEnvironmentBootstrapDeprecated: true,
    executed: false,
  }),
  edgeOne: Object.freeze({ mainPushTriggersDeployment: true, projectDomainTracksLatestSuccessfulDeployment: true, customDomainTracksLatestSuccessfulProductionDeployment: true, environmentChangesRequireNewDeployment: true, blobNamespaceManualCreationRequired: false, blobNamespaceCreation: 'first_sdk_getStore_call', blobConsoleAccess: 'read_only_browse' }),
  manualActions: actions,
  optionalPreDomainActions: Object.freeze(['stage8g_blob_bootstrap_not_executed']),
  activationBlockers: Object.freeze(['owner_controlled_domain_missing', 'public_and_admin_origins_unconfigured', 'private_values_unconfigured', 'dual_origin_zero_flag_deployment_not_verified', 'real_environment_l4_not_executed', 'stable_promotion_not_authorized']),
  boundaries: Object.freeze({ deploymentPerformed: false, environmentVariablesWritten: false, realPrivateValuesGenerated: false, realBlobOperationsPerformed: 0, productionActivationPerformed: false, administratorConsoleDeployed: false, stablePromotionAuthorized: false, stablePromotionPerformed: false }),
});

const markdown = [
  '# 生产上线负责人操作清单',
  '',
  '当前无需执行正式上线操作。域名前唯一可选动作是通过阶段8G手动工作流完成一次性Blob初始化；正式入口配置、环境变量导入、能力启用和L4验收仍需可控制域名。',
  '',
  ...actions.flatMap(item => [
    `## ${item.order}. ${item.title}`,
    '',
    `**是否要求可控制域名：** ${item.requiresOwnerDomain ? '是' : '否'}`,
    '',
    `**路径：** ${item.path}`,
    '',
  ]),
  '## 固定安全边界',
  '',
  '- 唯一推荐初始化入口是stage8g-edgeone-production-bootstrap；不再推荐通过临时开启部署环境中的bootstrap开关初始化。',
  '- 不使用带eo_token的临时地址作为正式来源。',
  '- 不在聊天、GitHub、Actions日志或网页源代码保存真实私密值。',
  '- 环境变量修改后必须触发新部署。',
  '- Blob命名空间由首次getStore调用自动创建，控制台主要用于只读浏览。',
  '- L4通过并获得负责人单独授权前不得晋升8.3.0。',
  '',
].join('\n');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'production-handoff-v1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(dist, 'production-owner-actions-v1.md'), markdown, 'utf8');
fs.writeFileSync(path.join(dist, 'production-edgeone-env-template-v1.txt'), templateText, 'utf8');
console.log(JSON.stringify(report));
