import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ADMIN_CONSOLE_FILES = Object.freeze(['index.html', 'admin-release.json']);
export const ADMIN_CONSOLE_SOURCE = 'dist/admin-production-console.html';
export const ADMIN_CONSOLE_OUTPUT = '.edgeone-admin-artifact';
export const ADMIN_CONSOLE_TITLE = '码单器正式管理员控制台';
export const ADMIN_CONSOLE_SESSION_PROBE_TEMPLATE = 'checkSession({quiet:true});';
export const ADMIN_CONSOLE_SESSION_PROBE_RENDERED = 'checkSession({quiet:false});';

export class AdminConsoleArtifactError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'AdminConsoleArtifactError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new AdminConsoleArtifactError(code, message, details);
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function repositoryCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function checkedCommit(value) {
  const commit = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('ADMIN_CONSOLE_COMMIT_INVALID', '管理员产物必须绑定40位Git提交SHA');
  return commit;
}

function safeOutput(root, outputDirectory) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(outputDirectory || path.join(repositoryRoot, ADMIN_CONSOLE_OUTPUT));
  const relative = path.relative(repositoryRoot, target);
  if (relative !== ADMIN_CONSOLE_OUTPUT) {
    fail('ADMIN_CONSOLE_OUTPUT_UNSAFE', '管理员产物只允许输出到仓库根目录.edgeone-admin-artifact', { relative });
  }
  return target;
}

export function renderAdminConsole(sourceText) {
  const text = String(sourceText || '');
  const templateCount = text.split(ADMIN_CONSOLE_SESSION_PROBE_TEMPLATE).length - 1;
  const renderedCount = text.split(ADMIN_CONSOLE_SESSION_PROBE_RENDERED).length - 1;
  if (templateCount !== 1 || renderedCount !== 0) {
    fail('ADMIN_CONSOLE_RENDER_MARKER_INVALID', '管理员控制台会话探测模板标记无效', {
      templateCount,
      renderedCount,
    });
  }
  return text.replace(ADMIN_CONSOLE_SESSION_PROBE_TEMPLATE, ADMIN_CONSOLE_SESSION_PROBE_RENDERED);
}

function auditSource(text) {
  if (!text.includes(`<title>${ADMIN_CONSOLE_TITLE}</title>`)
      || !text.includes("frame-ancestors 'none'")
      || !text.includes("credentials:'same-origin'")
      || !text.includes("confirmation:'EXPORT_FULL_PUBLIC_DATABASE'")
      || !text.includes("confirmation:'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'")
      || !text.includes(ADMIN_CONSOLE_SESSION_PROBE_RENDERED)
      || text.includes(ADMIN_CONSOLE_SESSION_PROBE_TEMPLATE)) {
    fail('ADMIN_CONSOLE_SOURCE_INVALID', '管理员控制台身份或关键安全锚点缺失');
  }
  const requiredPaths = [
    '/api/admin/auth/login', '/api/admin/auth/session', '/api/admin/auth/logout',
    '/api/admin/reviews', '/api/admin/ordinary-reviews', '/api/admin/sensitive-reviews',
    '/api/admin/devices', '/api/admin/rollbacks', '/api/admin/exports/summary',
    '/api/admin/exports/download',
  ];
  for (const value of requiredPaths) {
    if (!text.includes(value)) fail('ADMIN_CONSOLE_API_MISSING', '管理员控制台缺少正式API路径', { value });
  }
  const forbidden = [
    'eo_token', 'eo_time', 'admin-preview.html', 'localStorage.', 'sessionStorage.', 'indexedDB.',
    "const APP_VERSION = '8.2.31';", '<script src=', '<link rel="stylesheet"',
  ];
  for (const value of forbidden) {
    if (text.includes(value)) fail('ADMIN_CONSOLE_FORBIDDEN_CONTENT', '管理员控制台包含禁止内容', { value });
  }
  if ((text.match(/<script>/g) || []).length !== 1 || (text.match(/<style>/g) || []).length !== 1) {
    fail('ADMIN_CONSOLE_INLINE_STRUCTURE_INVALID', '管理员控制台必须只有一个内联脚本和一个内联样式');
  }
}

export function prepareAdminConsole({ root, outputDirectory, commitSha } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const target = safeOutput(repositoryRoot, outputDirectory);
  const sourceCommit = checkedCommit(commitSha || process.env.GITHUB_SHA || repositoryCommit(repositoryRoot));
  const sourcePath = path.join(repositoryRoot, ADMIN_CONSOLE_SOURCE);
  const templateText = fs.readFileSync(sourcePath, 'utf8');
  const renderedText = renderAdminConsole(templateText);
  const bytes = Buffer.from(renderedText, 'utf8');
  auditSource(renderedText);

  const release = Object.freeze({
    schemaVersion: 1,
    kind: 'production_admin_console_artifact',
    deploymentStatus: 'code_complete_not_deployed',
    sourceCommit,
    sourcePath: ADMIN_CONSOLE_SOURCE,
    title: ADMIN_CONSOLE_TITLE,
    sha256: sha256(bytes),
    bytes: bytes.length,
    outputFiles: ADMIN_CONSOLE_FILES,
    intendedOrigin: 'CLOUD_ADMIN_PUBLIC_ORIGIN',
    requiresSeparateAdministratorOrigin: true,
    requiresProductionAdminSession: true,
    initialSessionProbeVisible: true,
    includesOrdinaryUserCandidate: false,
    includesSecretValues: false,
    productionCapabilitiesDefaultOff: true,
    stableVersion: '8.2.25',
    candidateVersion: '8.2.31',
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
  });

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'index.html'), bytes);
  fs.writeFileSync(path.join(target, 'admin-release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');

  const files = fs.readdirSync(target).sort();
  if (JSON.stringify(files) !== JSON.stringify([...ADMIN_CONSOLE_FILES].sort())) {
    fail('ADMIN_CONSOLE_SCOPE_INVALID', '管理员产物文件范围无效', { files });
  }
  for (const filename of files) {
    const stat = fs.lstatSync(path.join(target, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('ADMIN_CONSOLE_FILE_TYPE_INVALID', '管理员产物必须是普通文件', { filename });
    }
  }
  if (files.includes('build-manifest.json') || files.includes('pages-release.json')) {
    fail('ADMIN_CONSOLE_PUBLIC_ARTIFACT_LEAK', '管理员产物不得混入普通用户候选清单');
  }
  return Object.freeze({
    outputDirectory: target,
    files: Object.freeze(files),
    release,
    renderedSha256: release.sha256,
    renderedBytes: release.bytes,
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(prepareAdminConsole({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
  }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
