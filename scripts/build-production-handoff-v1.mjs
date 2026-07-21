import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'dist', 'production-handoff-v1');

const PUBLIC_ARTIFACT_ALLOWLIST = Object.freeze([
  'index.html',
  'build-manifest.json',
  'pages-release.json',
]);

const ADMIN_FILES = Object.freeze([
  'admin/production-console.html',
  'admin/production-console.css',
  'admin/production-console.js',
]);

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

const phases = Object.freeze([
  Object.freeze({
    id: 'disabled',
    order: 0,
    purpose: '代码已就绪但所有正式能力保持关闭',
    expectedMode: 'disabled',
    flags: Object.freeze({}),
    manualGate: 'none',
  }),
  Object.freeze({
    id: 'bootstrap_once',
    order: 1,
    purpose: '全部生产能力关闭时执行一次性空库初始化',
    expectedMode: 'bootstrap',
    flags: Object.freeze({ CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1' }),
    manualGate: 'exact_confirmation_and_edgeone_api_token',
  }),
  Object.freeze({
    id: 'read_sync_only',
    order: 2,
    purpose: '只开放公共版本、快照和增量读取',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    }),
    manualGate: 'permanent_public_origin_or_time_limited_acceptance_test',
  }),
  Object.freeze({
    id: 'admin_foundation',
    order: 3,
    purpose: '开启正式管理员身份，审核、治理和导出仍关闭',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    }),
    manualGate: 'independent_admin_https_origin_and_random_secrets',
  }),
  Object.freeze({
    id: 'ordinary_submission_small_cohort',
    order: 4,
    purpose: '开放少量设备普通候选提交，自动审核仍关闭',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
      CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    }),
    manualGate: 'small_cohort_acceptance',
  }),
  Object.freeze({
    id: 'ordinary_auto_approval',
    order: 5,
    purpose: '在普通提交稳定后开启普通自动审核',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
      CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
      CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    }),
    manualGate: 'ordinary_auto_approval_acceptance',
  }),
  Object.freeze({
    id: 'admin_operations',
    order: 6,
    purpose: '开启人工审核、设备治理和完整迁移导出',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
      CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
      CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
      CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '1',
      CLOUD_PRODUCTION_EXPORT_ENABLED: '1',
      CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    }),
    manualGate: 'administrator_console_acceptance',
  }),
  Object.freeze({
    id: 'sensitive_manual_review',
    order: 7,
    purpose: '最后开放敏感候选入口，所有敏感变化继续人工审核',
    expectedMode: 'production',
    flags: Object.freeze({
      CLOUD_PRODUCTION_ENABLED: '1',
      CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
      CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '1',
      CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '1',
      CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '1',
      CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
      CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '1',
      CLOUD_PRODUCTION_EXPORT_ENABLED: '1',
      CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    }),
    manualGate: 'sensitive_manual_review_acceptance',
  }),
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath));
}

function write(relativePath, content) {
  const target = path.join(outputRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function phaseFlags(overrides) {
  const flags = Object.fromEntries(FLAG_NAMES.map(name => [name, '0']));
  return Object.freeze({ ...flags, ...overrides });
}

function buildManualOperations() {
  return `# 生产部署交接操作单\n\n` +
`本目录不含真实密钥，不会自动部署，也不会晋升稳定版。\n\n` +
`## A. 当前无需操作\n\n` +
`- 普通用户8.2.31候选继续保留；\n` +
`- 所有生产开关继续为0；\n` +
`- 管理员控制台只在本交接包的admin目录中，未进入普通用户公开产物。\n\n` +
`## B. 未来可先做、无需自定义域名的Blob初始化\n\n` +
`1. EdgeOne Makers控制台：创建API Token，并记下项目ID。Token不得发送到聊天或提交到GitHub。\n` +
`2. GitHub仓库：Settings → Secrets and variables → Actions → New repository secret。\n` +
`3. 新建EDGEONE_PROJECT_ID和EDGEONE_API_TOKEN两个仓库秘密。\n` +
`4. GitHub仓库：Actions → stage8d-edgeone-production-bootstrap → Run workflow。\n` +
`5. 第一次只选择plan；确认报告中的真实读写均为0。\n` +
`6. 确认后选择execute，并输入精确确认词INITIALIZE-see-see_cz-V1。\n` +
`7. EdgeOne项目：Blob存储页面只读核对两个命名空间和初始化对象。命名空间由SDK首次访问自动创建，不要在控制台寻找“新建Blob”按钮。\n\n` +
`## C. 有长期HTTPS入口后配置正式环境\n\n` +
`1. EdgeOne项目 → Settings → Environment Variables。\n` +
`2. 复制config/production.env.template中的变量名；填入两个纯HTTPS Origin和八项彼此不同的随机秘密。\n` +
`3. 环境变量修改只影响后续部署，保存后必须重新部署main。\n` +
`4. 严格按activation-phases.json逐阶段改开关，每阶段重新部署并验收，不得一次全部开启。\n\n` +
`## D. 自定义域名\n\n` +
`EdgeOne项目 → Domain Management → Add custom domain。含中国大陆加速区的域名必须先完成ICP备案。自定义域名应关联production环境；它会跟随production分支最新成功部署。\n\n` +
`## E. 管理员入口\n\n` +
`管理员控制台必须部署到负责人控制的独立HTTPS来源，并将该来源的纯Origin填入CLOUD_ADMIN_PUBLIC_ORIGIN。不要把admin目录复制到普通用户三文件产物中。\n\n` +
`## F. 最后一道授权\n\n` +
`完成全部真实设备、读写、审核、回滚和导出验收后，仍需项目负责人单独授权8.3.0稳定晋升。\n`;
}

export function buildProductionHandoff() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const files = [];
  for (const relativePath of ADMIN_FILES) {
    const content = read(relativePath);
    write(relativePath, content);
    files.push(Object.freeze({ path: relativePath, bytes: content.byteLength, sha256: sha256(content), role: 'isolated_admin_console' }));
  }

  const envTemplate = read('config/production.env.template');
  write('config/production.env.template', envTemplate);
  files.push(Object.freeze({
    path: 'config/production.env.template',
    bytes: envTemplate.byteLength,
    sha256: sha256(envTemplate),
    role: 'names_and_safe_defaults_only',
  }));

  const launchPlan = read('release/production-launch-plan-v1.json');
  write('release/production-launch-plan-v1.json', launchPlan);
  files.push(Object.freeze({
    path: 'release/production-launch-plan-v1.json',
    bytes: launchPlan.byteLength,
    sha256: sha256(launchPlan),
    role: 'owner_authorized_plan_without_activation',
  }));

  const activationPhases = Object.freeze({
    schemaVersion: 1,
    kind: 'production_activation_phases',
    targetStableVersion: '8.3.0',
    stablePromotionAuthorized: false,
    initialScope: Object.freeze({ clubId: 'see', libraryId: 'see_cz', groupId: 'group_see', protocolLibraryId: 'lib_see_cz' }),
    phases: Object.freeze(phases.map(phase => Object.freeze({ ...phase, flags: phaseFlags(phase.flags) }))),
  });
  const activationText = `${JSON.stringify(activationPhases, null, 2)}\n`;
  write('activation-phases.json', activationText);
  files.push(Object.freeze({
    path: 'activation-phases.json',
    bytes: Buffer.byteLength(activationText),
    sha256: sha256(Buffer.from(activationText)),
    role: 'machine_validated_rollout_order',
  }));

  const operations = buildManualOperations();
  write('人工操作清单.md', operations);
  files.push(Object.freeze({
    path: '人工操作清单.md',
    bytes: Buffer.byteLength(operations),
    sha256: sha256(Buffer.from(operations)),
    role: 'owner_click_path_and_expected_result',
  }));

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
    publicArtifactAllowlist: PUBLIC_ARTIFACT_ALLOWLIST,
    adminConsoleFiles: ADMIN_FILES,
    productionStores: Object.freeze({ public: 'cloud-collab-production-v1', admin: 'cloud-collab-admin-production-v1' }),
    bootstrap: Object.freeze({
      confirmation: 'INITIALIZE-see-see_cz-V1',
      workflow: 'stage8d-edgeone-production-bootstrap',
      defaultOperation: 'plan',
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
      'owner_controlled_permanent_public_https_origin_required_for_formal_anonymous_use',
      'independent_admin_https_origin_required_for_formal_admin_console',
      'edgeone_project_id_and_api_token_required_for_real_bootstrap',
      'eight_independent_random_runtime_secrets_required_before_activation',
      'real_l4_acceptance_required_before_stable_promotion',
    ]),
    files: Object.freeze(files),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  write('handoff-manifest.json', manifestText);

  return Object.freeze({ outputRoot, manifest });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = buildProductionHandoff();
  process.stdout.write(`${JSON.stringify({ output: path.relative(root, result.outputRoot), ...result.manifest.boundaries })}\n`);
}
