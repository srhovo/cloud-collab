import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ADMIN_CONSOLE_OUTPUT_DIRECTORY = '.edgeone-admin-artifact';
export const ADMIN_CONSOLE_CONFIG_TEMPLATE = 'config/edgeone-admin.project.json';
export const ADMIN_CONSOLE_FILES = Object.freeze([
  'index.html',
  'production-console.css',
  'production-console.js',
  'admin-release.json',
]);
export const ADMIN_CONSOLE_SOURCES = Object.freeze([
  Object.freeze({ sourcePath: 'admin/production-console.html', outputFile: 'index.html' }),
  Object.freeze({ sourcePath: 'admin/production-console.css', outputFile: 'production-console.css' }),
  Object.freeze({ sourcePath: 'admin/production-console.js', outputFile: 'production-console.js' }),
]);

const ADMIN_TITLE = '码单器正式管理员控制台';
const FROZEN_CANDIDATE = Object.freeze({
  version: '8.2.31',
  sha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
});

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
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function repositoryCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function checkedCommit(value) {
  const commit = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    fail('ADMIN_CONSOLE_COMMIT_INVALID', '管理员产物必须绑定40位Git提交SHA');
  }
  return commit;
}

function safeOutputDirectory(root, outputDirectory) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(outputDirectory || path.join(repositoryRoot, ADMIN_CONSOLE_OUTPUT_DIRECTORY));
  const relative = path.relative(repositoryRoot, target);
  if (relative !== ADMIN_CONSOLE_OUTPUT_DIRECTORY) {
    fail('ADMIN_CONSOLE_OUTPUT_UNSAFE', '管理员产物只能输出到仓库根目录.edgeone-admin-artifact', { relative });
  }
  return target;
}

function assertIncludes(text, values, code, label) {
  const missing = values.filter(value => !text.includes(value));
  if (missing.length) fail(code, `${label}缺少安全锚点`, { missing });
}

function assertExcludes(text, values, code, label) {
  const found = values.filter(value => text.includes(value));
  if (found.length) fail(code, `${label}包含禁止内容`, { found });
}

function auditHtml(text) {
  assertIncludes(text, [
    `<title>${ADMIN_TITLE}</title>`,
    '<link rel="stylesheet" href="./production-console.css">',
    '<script src="./production-console.js" defer></script>',
    "default-src 'none'",
    "connect-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ], 'ADMIN_CONSOLE_HTML_INVALID', '管理员HTML');
  assertExcludes(text, ['<style', 'http://', 'https://', 'eo_token', 'eo_time'], 'ADMIN_CONSOLE_HTML_FORBIDDEN', '管理员HTML');
  if ((text.match(/<script\b/gu) || []).length !== 1) {
    fail('ADMIN_CONSOLE_SCRIPT_COUNT_INVALID', '管理员HTML必须只引用一个同源外部脚本');
  }
}

function auditCss(text) {
  if (text.length < 1000) fail('ADMIN_CONSOLE_CSS_TOO_SMALL', '管理员CSS内容异常');
  assertExcludes(text, ['url(', '@import', 'http://', 'https://'], 'ADMIN_CONSOLE_CSS_FORBIDDEN', '管理员CSS');
}

function auditJavaScript(text) {
  assertIncludes(text, [
    '/api/admin/auth/login',
    '/api/admin/auth/session',
    '/api/admin/auth/logout',
    '/api/admin/reviews',
    '/api/admin/ordinary-reviews',
    '/api/admin/sensitive-reviews',
    '/api/admin/devices',
    '/api/admin/rollbacks',
    '/api/admin/exports/summary',
    '/api/admin/exports/download',
    "credentials: 'same-origin'",
    "cache: 'no-store'",
    "redirect: 'error'",
    "referrerPolicy: 'no-referrer'",
    "confirmation: 'EXPORT_FULL_PUBLIC_DATABASE'",
    "confirmation: 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'",
    "x-cloud-collab-stable-promotion-authorized",
    'const result = data.summary',
    'result.byteLength',
  ], 'ADMIN_CONSOLE_JS_INVALID', '管理员脚本');
  assertExcludes(text, [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
    'innerHTML',
    'outerHTML',
    'http://',
    'https://',
    'x-mdq-',
    'packageByteLength',
    'CLOUD_ADMIN_PASSWORD',
    'CLOUD_ADMIN_SESSION_SECRET',
  ], 'ADMIN_CONSOLE_JS_FORBIDDEN', '管理员脚本');
}

function readAndAuditSources(root) {
  return ADMIN_CONSOLE_SOURCES.map(item => {
    const absolutePath = path.join(root, item.sourcePath);
    const bytes = fs.readFileSync(absolutePath);
    const text = bytes.toString('utf8');
    if (item.outputFile === 'index.html') auditHtml(text);
    if (item.outputFile.endsWith('.css')) auditCss(text);
    if (item.outputFile.endsWith('.js')) auditJavaScript(text);
    return Object.freeze({
      ...item,
      bytes,
      sha256: digest(bytes),
      byteLength: bytes.length,
    });
  });
}

export function prepareAdminConsole({ root, outputDirectory, commitSha } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const target = safeOutputDirectory(repositoryRoot, outputDirectory);
  const sourceCommit = checkedCommit(commitSha || process.env.GITHUB_SHA || repositoryCommit(repositoryRoot));
  const sources = readAndAuditSources(repositoryRoot);
  const configPath = path.join(repositoryRoot, ADMIN_CONSOLE_CONFIG_TEMPLATE);
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    fail('ADMIN_CONSOLE_CONFIG_TEMPLATE_MISSING', '管理员项目配置模板不存在');
  }

  const release = Object.freeze({
    schemaVersion: 1,
    kind: 'production_admin_console_artifact',
    deploymentStatus: 'code_complete_not_deployed',
    sourceCommit,
    title: ADMIN_TITLE,
    sourceFiles: Object.freeze(sources.map(item => Object.freeze({
      sourcePath: item.sourcePath,
      outputFile: item.outputFile,
      sha256: item.sha256,
      bytes: item.byteLength,
    }))),
    outputFiles: ADMIN_CONSOLE_FILES,
    projectConfigTemplate: ADMIN_CONSOLE_CONFIG_TEMPLATE,
    intendedOriginEnv: 'CLOUD_ADMIN_PUBLIC_ORIGIN',
    requiresSeparateAdministratorOrigin: true,
    requiresProductionAdminSession: true,
    platformResponseHeadersRequired: true,
    includesOrdinaryUserCandidate: false,
    includesSecretValues: false,
    productionCapabilitiesDefaultOff: true,
    frozenPublicCandidate: FROZEN_CANDIDATE,
    stableVersion: '8.2.25',
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
  });

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const source of sources) {
    fs.writeFileSync(path.join(target, source.outputFile), source.bytes);
  }
  fs.writeFileSync(path.join(target, 'admin-release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');

  const files = fs.readdirSync(target).sort();
  if (JSON.stringify(files) !== JSON.stringify([...ADMIN_CONSOLE_FILES].sort())) {
    fail('ADMIN_CONSOLE_SCOPE_INVALID', '管理员产物文件范围无效', { files });
  }
  for (const filename of files) {
    const stat = fs.lstatSync(path.join(target, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('ADMIN_CONSOLE_FILE_TYPE_INVALID', '管理员产物必须是普通文件且不能是符号链接', { filename });
    }
  }

  return Object.freeze({
    outputDirectory: target,
    files: Object.freeze(files),
    release,
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = prepareAdminConsole({
    root,
    outputDirectory: argumentValue('--output'),
    commitSha: argumentValue('--commit'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
