import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_FILES,
  prepareAdminConsole,
} from './prepare-admin-console-v1.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'dist', 'production-handoff-v1');
const adminBuildRoot = path.join(root, '.edgeone-admin-artifact');

const PUBLIC_FILES = Object.freeze(['index.html', 'build-manifest.json', 'pages-release.json']);
const FLAG_NAMES = Object.freeze([
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
]);

const phaseDefinitions = Object.freeze([
  ['disabled', 'disabled', {}, '全部正式能力保持关闭'],
  ['bootstrap_once', 'bootstrap', { CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1' }, '一次性空库初始化'],
  ['read_sync_only', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
  }, '只读同步'],
  ['admin_foundation', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
  }, '管理员身份基础'],
  ['ordinary_submission_small_cohort', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
  }, '普通提交小流量'],
  ['ordinary_auto_approval', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
  }, '普通自动审核'],
  ['admin_operations', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '1',
    CLOUD_PRODUCTION_EXPORT_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
  }, '人工审核、设备治理和完整导出'],
  ['sensitive_manual_review', 'production', {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '1',
    CLOUD_PRODUCTION_EXPORT_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
  }, '敏感候选入口与人工审核'],
]);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative));
function write(relative, bytes) {
  const target = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
function record(files, relative, bytes, role) {
  write(relative, bytes);
  files.push(Object.freeze({ path: relative, bytes: bytes.length, sha256: digest(bytes), role }));
}
function allFlags(overrides = {}) {
  return Object.freeze({ ...Object.fromEntries(FLAG_NAMES.map(name => [name, '0'])), ...overrides });
}

function manualOperations() {
  return `# 生产部署交接操作单\n\n` +
`本包不含真实秘密，不会自动部署或晋升稳定版。\n\n` +
`## 无需域名即可执行的初始化\n\n` +
`1. EdgeOne Makers控制台创建API Token并记录项目ID。\n` +
`2. GitHub仓库 → Settings → Secrets and variables → Actions。\n` +
`3. 新建EDGEONE_PROJECT_ID与EDGEONE_API_TOKEN两个仓库秘密。\n` +
`4. GitHub仓库 → Actions → stage8e-edgeone-production-bootstrap → Run workflow。\n` +
`5. 先选plan；真实读写必须全部为0。\n` +
`6. 再选execute并输入INITIALIZE-see-see_cz-V1。\n` +
`7. EdgeOne项目Blob页只读核对两个命名空间。Blob命名空间由SDK首次访问自动创建。\n\n` +
`## 有长期HTTPS入口后的正式配置\n\n` +
`1. EdgeOne项目 → Settings → Environment Variables。\n` +
`2. 填入两个纯HTTPS Origin和八项彼此不同的随机秘密。\n` +
`3. 保存后重新部署main；环境变量不会反向影响旧部署。\n` +
`4. 严格按activation-phases.json逐阶段开启。\n\n` +
`## 自定义域名\n\n` +
`EdgeOne项目 → Domain Management → Add custom domain。含中国大陆加速区需先完成ICP备案。\n\n` +
`## 管理员项目\n\n` +
`使用admin-artifact四文件和config/edgeone-admin.project.json建立独立管理员来源，不得复制进普通用户三文件产物。\n\n` +
`## 最终授权\n\n` +
`真实L4验收后仍需项目负责人单独授权8.3.0稳定晋升。\n`;
}

export function buildProductionHandoff() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const admin = prepareAdminConsole({ root });
  const files = [];
  for (const filename of ADMIN_CONSOLE_FILES) {
    record(files, `admin-artifact/${filename}`, fs.readFileSync(path.join(adminBuildRoot, filename)), 'stage8d_verified_admin_artifact');
  }
  record(files, 'config/edgeone-admin.project.json', read('config/edgeone-admin.project.json'), 'admin_platform_header_template');
  record(files, 'config/production.env.template', read('config/production.env.template'), 'safe_defaults_and_empty_secret_slots');
  record(files, 'release/production-launch-plan-v1.json', read('release/production-launch-plan-v1.json'), 'owner_authorized_plan_without_activation');

  const phases = Object.freeze(phaseDefinitions.map(([id, expectedMode, overrides, purpose], order) => Object.freeze({
    id,
    order,
    expectedMode,
    purpose,
    flags: allFlags(overrides),
  })));
  const activation = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'production_activation_phases',
    targetStableVersion: '8.3.0',
    stablePromotionAuthorized: false,
    scope: { clubId: 'see', libraryId: 'see_cz', groupId: 'group_see', protocolLibraryId: 'lib_see_cz' },
    phases,
  }, null, 2)}\n`, 'utf8');
  record(files, 'activation-phases.json', activation, 'machine_validated_rollout_order');

  const operations = Buffer.from(manualOperations(), 'utf8');
  record(files, '人工操作清单.md', operations, 'owner_click_path_and_expected_result');

  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'production_handoff_package',
    status: 'prepared_not_deployed',
    sourceCandidate: Object.freeze({
      version: '8.2.31',
      sha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
      bytes: 1155575,
    }),
    targetStableVersion: '8.3.0',
    publicArtifactAllowlist: PUBLIC_FILES,
    adminArtifactFiles: ADMIN_CONSOLE_FILES.map(name => `admin-artifact/${name}`),
    adminArtifactSourceCommit: admin.release.sourceCommit,
    productionStores: Object.freeze({ public: 'cloud-collab-production-v1', admin: 'cloud-collab-admin-production-v1' }),
    bootstrap: Object.freeze({
      workflow: 'stage8e-edgeone-production-bootstrap',
      defaultOperation: 'plan',
      confirmation: 'INITIALIZE-see-see_cz-V1',
      realWriteRequiresExplicitExecute: true,
    }),
    boundaries: Object.freeze({
      containsRealSecrets: false,
      edgeOneDeploymentPerformed: false,
      blobReadsPerformed: 0,
      blobWritesPerformed: 0,
      blobDeletesPerformed: 0,
      productionFlagsChanged: 0,
      stablePromotionAuthorized: false,
      stablePromotionPerformed: false,
    }),
    blockers: Object.freeze([
      'permanent_public_https_origin_required_for_formal_anonymous_use',
      'independent_admin_https_origin_required_for_formal_admin_use',
      'edgeone_project_id_and_api_token_required_for_real_bootstrap',
      'eight_independent_runtime_secrets_required_before_activation',
      'real_l4_acceptance_required_before_stable_promotion',
    ]),
    files: Object.freeze(files),
  });
  write('handoff-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return Object.freeze({ outputRoot, manifest });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildProductionHandoff();
  process.stdout.write(`${JSON.stringify({ output: path.relative(root, result.outputRoot), ...result.manifest.boundaries })}\n`);
}
