import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED = Object.freeze({
  stableVersion: '8.2.25',
  candidateVersion: '8.2.31',
  candidateBytes: 1_155_575,
  candidateSha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
  externalClubId: 'see',
  externalLibraryId: 'see_cz',
  protocolGroupId: 'group_see',
  protocolLibraryId: 'lib_see_cz',
  publicStoreName: 'cloud-collab-production-v1',
  adminStoreName: 'cloud-collab-admin-production-v1',
  adminUsername: 'xiaxue',
});

const PUBLIC_FILES = Object.freeze(['build-manifest.json', 'index.html', 'pages-release.json']);
const ADMIN_FILES = Object.freeze(['admin-release.json', 'index.html', 'production-console.css', 'production-console.js']);
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
const SECRET_NAMES = Object.freeze([
  'CLOUD_ADMIN_PASSWORD',
  'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
  'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_SESSION_SECRET',
  'CLOUD_ADMIN_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_DEVICE_REF_SALT',
  'CLOUD_ADMIN_ROLLBACK_REF_SALT',
  'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
]);

class Stage8EError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message || code || '阶段8E离线部署预检失败');
    this.name = 'Stage8EError';
    this.code = code || 'STAGE8E_ERROR';
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, details = null, cause = null) {
  throw new Stage8EError(code, message, details, cause);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    fail('STAGE8E_JSON_INVALID', '无法读取部署预检JSON', { filename }, error);
  }
}

function listFiles(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail('STAGE8E_ARTIFACT_DIRECTORY_MISSING', '部署产物目录不存在', { directory });
  }
  return fs.readdirSync(directory).sort();
}

function assertExactFiles(directory, expected, label) {
  const actual = listFiles(directory);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail('STAGE8E_ARTIFACT_SCOPE_INVALID', `${label}文件范围无效`, { actual, expected: wanted });
  }
  for (const filename of actual) {
    const stat = fs.lstatSync(path.join(directory, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('STAGE8E_ARTIFACT_FILE_INVALID', `${label}必须只包含普通文件`, { filename });
    }
  }
  return Object.freeze(actual);
}

function descriptor(directory, filename) {
  const bytes = fs.readFileSync(path.join(directory, filename));
  return Object.freeze({ filename, bytes: bytes.length, sha256: sha256(bytes) });
}

function repositoryCommit(root, supplied) {
  const value = String(supplied || '').trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(value)) return value;
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(commit)) return commit;
  } catch (error) {
    fail('STAGE8E_COMMIT_UNAVAILABLE', '无法确定阶段8E来源提交', null, error);
  }
  fail('STAGE8E_COMMIT_INVALID', '阶段8E来源提交无效');
}

function parseEnvTemplate(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return Object.freeze(values);
}

function assertTemplate(values) {
  const exact = {
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: EXPECTED.externalClubId,
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: EXPECTED.externalLibraryId,
    CLOUD_PRODUCTION_GROUP_ID: EXPECTED.protocolGroupId,
    CLOUD_PRODUCTION_LIBRARY_ID: EXPECTED.protocolLibraryId,
    CLOUD_PRODUCTION_BLOB_STORE_NAME: EXPECTED.publicStoreName,
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: EXPECTED.adminStoreName,
    CLOUD_ADMIN_USERNAME: EXPECTED.adminUsername,
  };
  for (const [name, expected] of Object.entries(exact)) {
    if (values[name] !== expected) {
      fail('STAGE8E_ENV_TEMPLATE_VALUE_INVALID', '生产环境模板固定值无效', {
        name,
        actual: values[name] ?? null,
        expected,
      });
    }
  }
  for (const name of FLAG_NAMES) {
    if (values[name] !== '0') {
      fail('STAGE8E_PRODUCTION_FLAG_NOT_CLOSED', '离线预检要求所有生产开关默认关闭', {
        name,
        actual: values[name] ?? null,
      });
    }
  }
  for (const name of SECRET_NAMES) {
    if (values[name] !== '') {
      fail('STAGE8E_SECRET_TEMPLATE_NOT_EMPTY', '生产环境模板不得包含真实密钥', { name });
    }
  }
  if (values.CLOUD_PRODUCTION_PUBLIC_ORIGIN !== '' || values.CLOUD_ADMIN_PUBLIC_ORIGIN !== '') {
    fail('STAGE8E_ORIGIN_TEMPLATE_NOT_EMPTY', '没有长期域名前，正式Origin必须保持空值');
  }
}

function assertCandidate(publicDirectory) {
  const buildManifest = readJson(path.join(publicDirectory, 'build-manifest.json'));
  const release = readJson(path.join(publicDirectory, 'pages-release.json'));
  const indexBytes = fs.readFileSync(path.join(publicDirectory, 'index.html'));
  const actual = {
    version: String(buildManifest.candidateVersion || buildManifest.version || ''),
    bytes: Number(buildManifest.bytes),
    sha256: String(buildManifest.sha256 || '').toLowerCase(),
    indexBytes: indexBytes.length,
    indexSha256: sha256(indexBytes),
  };
  if (actual.version !== EXPECTED.candidateVersion
      || actual.bytes !== EXPECTED.candidateBytes
      || actual.sha256 !== EXPECTED.candidateSha256
      || actual.indexBytes !== EXPECTED.candidateBytes
      || actual.indexSha256 !== EXPECTED.candidateSha256) {
    fail('STAGE8E_CANDIDATE_IDENTITY_MISMATCH', '普通用户候选身份与8.2.31冻结值不一致', { actual, expected: EXPECTED });
  }
  const stableVersion = String(release.stableVersion || release.currentStableVersion || '');
  if (stableVersion !== EXPECTED.stableVersion
      || release.stablePromotionAuthorized !== false
      || release.stablePromotionPerformed !== false
      || release.productionWriteEnablementIncluded !== false) {
    fail('STAGE8E_PUBLIC_RELEASE_BOUNDARY_INVALID', '普通用户发布清单越过稳定晋升或生产写入边界', {
      stableVersion,
      stablePromotionAuthorized: release.stablePromotionAuthorized,
      stablePromotionPerformed: release.stablePromotionPerformed,
      productionWriteEnablementIncluded: release.productionWriteEnablementIncluded,
    });
  }
  return Object.freeze({ buildManifest, release, actual });
}

function assertAdmin(adminDirectory) {
  const release = readJson(path.join(adminDirectory, 'admin-release.json'));
  if (release.stableVersion !== EXPECTED.stableVersion
      || release.candidateVersion !== EXPECTED.candidateVersion
      || release.includesSecretValues !== false
      || release.productionCapabilitiesDefaultOff !== true
      || release.stablePromotionAuthorized !== false
      || release.stablePromotionPerformed !== false
      || release.productionWriteEnablementIncluded !== false) {
    fail('STAGE8E_ADMIN_RELEASE_BOUNDARY_INVALID', '管理员发布清单越过版本、密钥或生产能力边界', { release });
  }
  return Object.freeze({ release });
}

function blocker(id, owner, reason, completionEvidence) {
  return Object.freeze({ id, owner, blocking: true, status: 'not_completed', reason, completionEvidence });
}

function markdownEnvironment(values) {
  const nonSecretNames = [
    'CLOUD_PRODUCTION_EXTERNAL_CLUB_ID', 'CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID',
    'CLOUD_PRODUCTION_GROUP_ID', 'CLOUD_PRODUCTION_LIBRARY_ID',
    'CLOUD_PRODUCTION_BLOB_STORE_NAME', 'CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME',
    'CLOUD_ADMIN_USERNAME', 'CLOUD_PRODUCTION_PUBLIC_ORIGIN', 'CLOUD_ADMIN_PUBLIC_ORIGIN',
  ];
  const lines = [
    '# 阶段8E：环境变量录入清单', '',
    '当前清单只提供变量名和非秘密固定值；真实密钥不得进入GitHub、聊天、截图或本部署包。', '',
    '## 固定非秘密值', '', '```text',
  ];
  for (const name of nonSecretNames) lines.push(`${name}=${values[name] ?? ''}`);
  lines.push('```', '', '## 首次必须保持关闭的开关', '', '```text');
  for (const name of FLAG_NAMES) lines.push(`${name}=0`);
  lines.push('```', '', '## 需要在受信任电脑生成并录入的秘密变量名', '');
  for (const name of SECRET_NAMES) lines.push(`- \`${name}\``);
  lines.push('', '生成命令：', '', '```bash',
    'npm ci --ignore-scripts',
    'npm run production:secrets:generate -- --output /安全目录/cloud-collab-production-secrets.env',
    '```', '',
    '生成文件只保存到密码管理器和EdgeOne私密环境变量。', '');
  return `${lines.join('\n')}\n`;
}

function markdownManualOperations() {
  return `# 阶段8E：未来人工操作顺序\n\n当前无需操作。没有长期域名时，流程必须保持阻断。\n\n## 1. 准备长期HTTPS域名\n\n路径：域名服务商控制台 → DNS管理。\n\n建议：\n\n\`\`\`text\napp.你的域名\nadmin.你的域名\n\`\`\`\n\n预期：两个地址均可长期HTTPS访问，不依赖eo_token。\n\n失败处理：没有域名时停止，不把临时预览链接填入正式Origin。\n\n## 2. EdgeOne普通项目\n\n路径：EdgeOne Pages控制台 → cloud-collab → 设置。\n\n保持仓库根目录构建，核对普通产物只有：\n\n\`\`\`text\nindex.html\nbuild-manifest.json\npages-release.json\n\`\`\`\n\n## 3. EdgeOne管理员项目\n\n路径：EdgeOne Pages控制台 → 新建项目 → 导入srhovo/cloud-collab。\n\n按\`config/edgeone-admin.project.json\`录入管理员项目构建参数。核对管理员产物只有：\n\n\`\`\`text\nindex.html\nproduction-console.css\nproduction-console.js\nadmin-release.json\n\`\`\`\n\n失败处理：出现普通码单器主页、build-manifest.json或pages-release.json时停止。\n\n## 4. Blob可访问性\n\n路径：EdgeOne项目 → 存储 / Blob（文字可能随平台调整）。\n\n必须访问既有：\n\n\`\`\`text\ncloud-collab-production-v1\ncloud-collab-admin-production-v1\n\`\`\`\n\n失败处理：若只能创建新空Store、同名Store为空或跨项目不可访问，停止；不要复制数据或新建同名空库冒充正式库。\n\n## 5. 环境变量\n\n路径：EdgeOne项目 → 设置 → 环境变量。\n\n先录入固定值和秘密值，但全部生产开关保持0。\n\n## 6. 一次性初始化\n\n仅在域名、两个Blob和全部变量准备完成后临时设置：\n\n\`\`\`text\nCLOUD_PRODUCTION_BOOTSTRAP_ENABLED=1\nCLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION=INITIALIZE-see-see_cz-V1\n\`\`\`\n\n完成后立即恢复0和空确认词。失败时不要手工补写Blob。\n\n## 7. 分阶段开启\n\n\`\`\`text\n生产总开关\n→ 只读同步\n→ 管理员身份\n→ 完整导出\n→ 普通提交\n→ 自动审核\n→ 人工审核\n→ 设备治理\n→ 回滚真实验收\n→ 敏感提交与敏感审核\n\`\`\`\n\n每次只改一项，失败就恢复刚开启的开关。\n\n## 8. L4与稳定晋升\n\n桌面、Android、iPhone Safari全部完成真实验收后，仍需单独授权8.3.0晋升。\n`;
}

export function buildStage8EPreflight({ root, outputDirectory, commitSha } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const output = path.resolve(outputDirectory || path.join(repositoryRoot, 'release-output', 'stage8e-offline-preflight'));
  const relative = path.relative(repositoryRoot, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('STAGE8E_OUTPUT_UNSAFE', '阶段8E输出目录必须位于仓库内部');
  }
  const sourceCommit = repositoryCommit(repositoryRoot, commitSha);
  const publicDirectory = path.join(repositoryRoot, '.edgeone-artifact');
  const adminDirectory = path.join(repositoryRoot, '.edgeone-admin-artifact');
  const publicFiles = assertExactFiles(publicDirectory, PUBLIC_FILES, '普通用户产物');
  const adminFiles = assertExactFiles(adminDirectory, ADMIN_FILES, '管理员产物');
  const candidate = assertCandidate(publicDirectory);
  const admin = assertAdmin(adminDirectory);
  const envTemplate = fs.readFileSync(path.join(repositoryRoot, 'config', 'production.env.template'), 'utf8');
  const envValues = parseEnvTemplate(envTemplate);
  assertTemplate(envValues);
  const adminProject = readJson(path.join(repositoryRoot, 'config', 'edgeone-admin.project.json'));
  const publicProject = readJson(path.join(repositoryRoot, 'edgeone.json'));

  const blockers = Object.freeze([
    blocker('permanent_public_origin', '负责人', '普通用户长期HTTPS域名尚未提供', '可长期直接访问且不含临时令牌的HTTPS Origin'),
    blocker('permanent_admin_origin', '负责人', '管理员长期HTTPS域名尚未提供', '独立管理员HTTPS Origin及证书生效'),
    blocker('public_blob_verified', '负责人+技术验证', '公共生产Blob尚未创建或可访问性尚未验证', EXPECTED.publicStoreName),
    blocker('admin_blob_verified', '负责人+技术验证', '管理员生产Blob尚未创建或可访问性尚未验证', EXPECTED.adminStoreName),
    blocker('production_secrets_installed', '负责人', '8项真实秘密变量尚未安全生成并录入', 'EdgeOne私密变量存在且不泄露值'),
    blocker('production_environment_installed', '负责人', '双项目正式环境变量尚未录入', '变量名、固定值、Origin和Store全部通过运行时校验'),
    blocker('bootstrap_completed', '负责人+自动验证', '一次性空库初始化尚未执行', '初始化报告通过且bootstrap开关恢复0'),
    blocker('real_deployment_verified', '负责人+自动验证', '普通与管理员正式项目尚未真实部署验收', '双项目、响应头、API和Blob访问证据通过'),
    blocker('l4_device_matrix_completed', '负责人', '桌面、Android、iPhone Safari的L4真实验收尚未完成', 'L4逐项证据全部通过'),
    blocker('stable_promotion_authorized', '负责人', '8.3.0稳定晋升尚未单独授权', '明确的最终稳定晋升授权'),
  ]);

  const artifactIntegrity = Object.freeze({
    schemaVersion: 1,
    sourceCommit,
    publicArtifact: Object.freeze({
      files: publicFiles,
      descriptors: Object.freeze(publicFiles.map(filename => descriptor(publicDirectory, filename))),
      candidateVersion: EXPECTED.candidateVersion,
      candidateBytes: candidate.actual.indexBytes,
      candidateSha256: candidate.actual.indexSha256,
    }),
    adminArtifact: Object.freeze({
      files: adminFiles,
      descriptors: Object.freeze(adminFiles.map(filename => descriptor(adminDirectory, filename))),
      releaseKind: admin.release.kind,
      includesSecretValues: false,
    }),
    mutuallyExclusive: publicFiles.every(filename => !adminFiles.includes(filename) || filename === 'index.html'),
    stableVersion: EXPECTED.stableVersion,
    stablePromotionAuthorized: false,
  });

  const deploymentValues = Object.freeze({
    schemaVersion: 1,
    sourceCommit,
    scope: Object.freeze({
      external: Object.freeze({ clubId: EXPECTED.externalClubId, libraryId: EXPECTED.externalLibraryId }),
      protocol: Object.freeze({ groupId: EXPECTED.protocolGroupId, libraryId: EXPECTED.protocolLibraryId }),
    }),
    stores: Object.freeze({ public: EXPECTED.publicStoreName, admin: EXPECTED.adminStoreName }),
    administrator: Object.freeze({ username: EXPECTED.adminUsername, passwordIncluded: false }),
    origins: Object.freeze({ public: null, admin: null, permanentOriginsReady: false }),
    flags: Object.freeze(Object.fromEntries(FLAG_NAMES.map(name => [name, '0']))),
    secretVariableNames: SECRET_NAMES,
    realSecretValuesIncluded: false,
    publicProjectTemplate: publicProject,
    adminProjectTemplate: adminProject,
  });

  const report = Object.freeze({
    schemaVersion: 1,
    stage: '8E',
    kind: 'offline_production_deployment_preflight',
    sourceCommit,
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    codeComplete: true,
    artifactVerificationPassed: true,
    productionReady: false,
    blockerCount: blockers.length,
    blockers,
    realEdgeOneDeploymentPerformed: false,
    realBlobAccessPerformed: false,
    realSecretValuesGeneratedOrRead: false,
    productionFlagsEnabled: false,
    stableVersion: EXPECTED.stableVersion,
    candidateVersion: EXPECTED.candidateVersion,
    targetStableVersion: '8.3.0',
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
  });

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'readiness-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(output, 'deployment-values.json'), `${JSON.stringify(deploymentValues, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(output, 'artifact-integrity.json'), `${JSON.stringify(artifactIntegrity, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(output, 'environment-variable-checklist.md'), markdownEnvironment(envValues), 'utf8');
  fs.writeFileSync(path.join(output, 'manual-operations.md'), markdownManualOperations(), 'utf8');

  const files = fs.readdirSync(output).sort();
  const expectedFiles = [
    'artifact-integrity.json', 'deployment-values.json', 'environment-variable-checklist.md',
    'manual-operations.md', 'readiness-report.json',
  ];
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    fail('STAGE8E_OUTPUT_SCOPE_INVALID', '阶段8E输出文件范围无效', { files, expectedFiles });
  }
  const combined = files.map(filename => fs.readFileSync(path.join(output, filename), 'utf8')).join('\n');
  for (const marker of ['eo_token=', 'eo_time=', 'dt_v1_', 'cloud_admin_session=', 'CLOUD_ADMIN_PASSWORD=']) {
    if (combined.includes(marker)) {
      fail('STAGE8E_SENSITIVE_VALUE_LEAK', '阶段8E部署包包含禁止的凭据或临时令牌内容', { marker });
    }
  }
  return Object.freeze({ outputDirectory: output, files: Object.freeze(files), report, artifactIntegrity });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = buildStage8EPreflight({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
