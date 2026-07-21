import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_CANDIDATE_FILES } from './prepare-public-candidate-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = message => { throw new Error(`阶段8D生产交接构建失败：${message}`); };

function parseEnv(text) {
  const entries = [];
  const values = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) fail(`环境变量行无效：${line}`);
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    if (values.has(name)) fail(`环境变量重复：${name}`);
    entries.push({ name, value });
    values.set(name, value);
  }
  return { entries, values };
}

const handoffPlan = JSON.parse(read('release/production-handoff-plan-v1.json'));
const launchPlan = JSON.parse(read('release/production-launch-plan-v1.json'));
const templateText = read('config/production.env.template');
const { entries, values } = parseEnv(templateText);
const toolHtml = read('tools/production-secret-generator.html');
const toolJs = read('tools/production-secret-generator.js');
const toolConfig = read('tools/production-secret-generator-config.js');

if (handoffPlan.schemaVersion !== 1 || handoffPlan.stage !== '8D') fail('交接计划版本无效');
if (handoffPlan.status !== 'code_complete_waiting_owner_domain_and_platform_configuration') fail('交接计划状态无效');
if (handoffPlan.stablePromotionAuthorized !== false || handoffPlan.stablePromotionPerformed !== false) fail('不得提前授权稳定晋升');
if (handoffPlan.productionActivationPerformed !== false) fail('不得声称已启用生产');

if (launchPlan.candidate?.version !== '8.2.31'
    || launchPlan.candidate?.sha256 !== '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b'
    || launchPlan.stableRelease?.targetVersion !== '8.3.0'
    || launchPlan.stableRelease?.promotionAuthorized !== false) {
  fail('冻结候选或目标稳定版本无效');
}

const featureFlags = [
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
for (const name of featureFlags) {
  if (values.get(name) !== '0') fail(`${name}必须默认关闭`);
}

for (const [name, expected] of [
  ['CLOUD_PRODUCTION_EXTERNAL_CLUB_ID', 'see'],
  ['CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID', 'see_cz'],
  ['CLOUD_PRODUCTION_GROUP_ID', 'group_see'],
  ['CLOUD_PRODUCTION_LIBRARY_ID', 'lib_see_cz'],
  ['CLOUD_PRODUCTION_BLOB_STORE_NAME', 'cloud-collab-production-v1'],
  ['CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME', 'cloud-collab-admin-production-v1'],
  ['CLOUD_ADMIN_USERNAME', 'xiaxue'],
]) {
  if (values.get(name) !== expected) fail(`${name}与冻结计划不一致`);
}

if (values.get('CLOUD_PRODUCTION_PUBLIC_ORIGIN') !== '' || values.get('CLOUD_ADMIN_PUBLIC_ORIGIN') !== '') {
  fail('没有自定义域名时正式来源必须留空');
}
if (values.get('CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION') !== '') fail('初始化确认词必须默认留空');

const privateEntries = entries.filter(({ name }) => /(PASSWORD|KEY|SECRET|SALT)$/u.test(name));
if (privateEntries.length !== 8 || privateEntries.some(({ value }) => value !== '')) fail('八项私密变量必须存在且模板值为空');
if (/eo_token=/iu.test(templateText + JSON.stringify(handoffPlan) + JSON.stringify(launchPlan))) fail('交接材料不得固化临时访问令牌');

if (!toolHtml.includes("connect-src 'none'")
    || !toolJs.includes('crypto.getRandomValues')
    || !toolJs.includes("window.addEventListener('pagehide', clearPage)")) {
  fail('离线工具缺少网络隔离、强随机或离开页面清理');
}
if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.clipboard|localStorage|sessionStorage|indexedDB|document\.cookie)\b/u.test(toolHtml + toolJs + toolConfig)) {
  fail('离线工具包含网络、浏览器存储、Cookie或剪贴板接口');
}
if (!toolConfig.includes('CLOUD_PRODUCTION_ENABLED=0') || !toolConfig.includes('CLOUD_PRODUCTION_BOOTSTRAP_ENABLED=0')) {
  fail('离线工具必须保持总开关和初始化开关关闭');
}

const expectedPublicFiles = ['index.html', 'build-manifest.json', 'pages-release.json'];
if (JSON.stringify(PUBLIC_CANDIDATE_FILES) !== JSON.stringify(expectedPublicFiles)) fail('普通用户公开白名单发生变化');
if (PUBLIC_CANDIDATE_FILES.some(name => name.startsWith('admin/') || name.startsWith('tools/'))) fail('管理员或本地工具进入普通用户产物');

const manualActions = Object.freeze([
  Object.freeze({
    order: 1,
    title: '准备可控制的域名',
    path: '域名注册商与工信部备案系统',
    action: '购买或使用已有域名；当前含中国大陆区域绑定自定义域名时先完成ICP备案。',
    requiredNow: false,
  }),
  Object.freeze({
    order: 2,
    title: '绑定两个正式HTTPS来源',
    path: 'EdgeOne Makers → cloud-collab项目 → 域名管理 → 添加自定义域名',
    action: '推荐分别绑定app.<你的域名>和admin.<你的域名>到生产环境，并按平台提示添加DNS归属验证与CNAME。',
    requiredNow: false,
  }),
  Object.freeze({
    order: 3,
    title: '生成并导入生产私密值',
    path: '本仓库tools/production-secret-generator.html；EdgeOne Makers → 项目设置 → 环境变量',
    action: '在可信设备本地打开离线工具，生成八项互不相同的随机值；将批量文本导入平台并保存到密码管理器。所有开关继续保持0。',
    requiredNow: false,
  }),
  Object.freeze({
    order: 4,
    title: '触发新部署并执行一次性初始化',
    path: 'EdgeOne Makers → 部署记录 → 重新部署，或向main推送已验收提交',
    action: '环境变量修改只影响新部署。初始化时仅开启BOOTSTRAP并填写确认词，其他能力全部关闭；首次getStore调用自动创建两个Blob命名空间。完成后立刻把BOOTSTRAP恢复为0并再次部署。',
    requiredNow: false,
  }),
  Object.freeze({
    order: 5,
    title: '按顺序开放能力并做真实设备验收',
    path: 'EdgeOne Makers → 项目设置 → 环境变量；部署记录；普通用户与独立管理员来源',
    action: '依次开放总开关、只读、普通提交、自动审核、管理员、敏感提交、设备治理和导出；每次只改一组并重新部署。',
    requiredNow: false,
  }),
  Object.freeze({
    order: 6,
    title: '完成L4并单独授权8.3.0晋升',
    path: 'GitHub发布审计、EdgeOne真实环境与项目负责人确认',
    action: '所有真实环境验收通过后，项目负责人另行明确授权稳定晋升；当前仍禁止晋升。',
    requiredNow: false,
  }),
]);

const report = Object.freeze({
  schemaVersion: 1,
  stage: '8D',
  status: 'handoff_ready_waiting_owner_domain',
  candidate: Object.freeze({
    version: launchPlan.candidate.version,
    sha256: launchPlan.candidate.sha256,
    bytes: launchPlan.candidate.bytes,
  }),
  stable: Object.freeze({ current: '8.2.25', target: '8.3.0', promotionAuthorized: false }),
  scope: Object.freeze({ external: launchPlan.scope.external, protocol: launchPlan.scope.protocol }),
  publicArtifactAllowlist: PUBLIC_CANDIDATE_FILES,
  offlineGenerator: Object.freeze({
    files: Object.freeze([
      'tools/production-secret-generator.html',
      'tools/production-secret-generator.css',
      'tools/production-secret-generator-config.js',
      'tools/production-secret-generator.js',
    ]),
    networkAccess: false,
    persistentBrowserStorage: false,
    clipboardApiAccess: false,
    privateValueCount: privateEntries.length,
    randomBytesPerValue: 48,
  }),
  edgeOne: Object.freeze({
    mainPushTriggersDeployment: true,
    projectDomainTracksLatestSuccessfulDeployment: true,
    customDomainTracksLatestSuccessfulProductionDeployment: true,
    environmentChangesRequireNewDeployment: true,
    blobNamespaceManualCreationRequired: false,
    blobNamespaceCreation: 'first_sdk_getStore_call',
    blobConsoleAccess: 'read_only_browse',
  }),
  manualActions,
  currentBlockers: Object.freeze([
    'owner_controlled_domain_missing',
    'public_and_admin_origins_unconfigured',
    'private_values_unconfigured',
    'bootstrap_not_executed',
    'real_environment_l4_not_executed',
    'stable_promotion_not_authorized',
  ]),
  boundaries: Object.freeze({
    deploymentPerformed: false,
    environmentVariablesWritten: false,
    realPrivateValuesGenerated: false,
    realBlobOperationsPerformed: 0,
    productionActivationPerformed: false,
    administratorConsoleDeployed: false,
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
  }),
});

const markdown = [
  '# 生产上线负责人操作清单',
  '',
  '当前代码、自动测试和离线交接工具已准备完成；以下步骤等负责人拥有可控制域名后再执行。',
  '',
  ...manualActions.flatMap(item => [
    `## ${item.order}. ${item.title}`,
    '',
    `**路径：** ${item.path}`,
    '',
    item.action,
    '',
  ]),
  '## 当前禁止事项',
  '',
  '- 不使用带eo_token的临时链接作为正式来源。',
  '- 不在聊天、GitHub、Actions日志或普通用户页面保存真实私密值。',
  '- 不把admin/或tools/加入普通用户三文件发布包。',
  '- 不在L4通过和负责人单独授权前晋升8.3.0。',
  '',
].join('\n');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'production-handoff-v1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(dist, 'production-owner-actions-v1.md'), markdown, 'utf8');
fs.writeFileSync(path.join(dist, 'production-edgeone-env-template-v1.txt'), templateText, 'utf8');
console.log(JSON.stringify(report));
