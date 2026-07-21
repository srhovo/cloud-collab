import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ADMIN_DEPLOYMENT_ROOT = 'deploy/admin';
export const ADMIN_STATIC_OUTPUT = '.edgeone-admin-artifact';
export const ADMIN_STATIC_FILES = Object.freeze([
  'index.html',
  'production-console.css',
  'production-console.js',
  'admin-release.json',
]);
export const ADMIN_SESSION_TEMPLATE = 'checkSession({ quiet: true });';
export const ADMIN_SESSION_RENDERED = 'checkSession({ quiet: false });';

const ADMIN_TITLE = '码单器正式管理员控制台';
const FROZEN_PUBLIC_CANDIDATE = Object.freeze({
  version: '8.2.31',
  sha256: '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b',
});

export class AdminDeploymentArtifactError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message || code || '管理员部署产物生成失败');
    this.name = 'AdminDeploymentArtifactError';
    this.code = code || 'ADMIN_DEPLOYMENT_ARTIFACT_ERROR';
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, details = null, cause = null) {
  throw new AdminDeploymentArtifactError(code, message, details, cause);
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function repositoryCommit(repositoryRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    fail('ADMIN_DEPLOYMENT_COMMIT_UNAVAILABLE', '无法确定管理员部署来源提交', null, error);
  }
}

function checkedCommit(value) {
  const commit = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    fail('ADMIN_DEPLOYMENT_COMMIT_INVALID', '管理员部署来源提交必须为40位Git SHA');
  }
  return commit;
}

function resolveInside(parent, child, code) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(code, '生成路径必须位于管理员项目根目录内', { parentPath, childPath, relative });
  }
  return childPath;
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail('ADMIN_DEPLOYMENT_SOURCE_DIRECTORY_MISSING', '管理员部署依赖目录不存在', { source });
  }
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
  });
}

function writeFile(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}

function renderConsoleScript(source) {
  const templateCount = source.split(ADMIN_SESSION_TEMPLATE).length - 1;
  const renderedCount = source.split(ADMIN_SESSION_RENDERED).length - 1;
  if (templateCount !== 1 || renderedCount !== 0) {
    fail('ADMIN_SESSION_RENDER_MARKER_INVALID', '管理员控制台初始会话检查标记无效', {
      templateCount,
      renderedCount,
    });
  }
  return source.replace(ADMIN_SESSION_TEMPLATE, ADMIN_SESSION_RENDERED);
}

function listFilesRecursive(directory) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
      else fail('ADMIN_DEPLOYMENT_FILE_TYPE_INVALID', '管理员部署依赖只能包含普通文件和目录', { target });
    }
  };
  visit(directory);
  return files.sort();
}

function resolveImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  return [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]
    .find(item => fs.existsSync(item) && fs.statSync(item).isFile()) || null;
}

function auditGeneratedFunctions(projectRoot) {
  const functionsRoot = path.join(projectRoot, 'cloud-functions');
  const apiRoot = path.join(functionsRoot, 'api');
  const adminApiRoot = path.join(apiRoot, 'admin');
  const sharedRoot = path.join(functionsRoot, '_shared');
  const serverRoot = path.join(projectRoot, 'src', 'server');
  for (const required of [adminApiRoot, sharedRoot, serverRoot]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isDirectory()) {
      fail('ADMIN_DEPLOYMENT_RUNTIME_DIRECTORY_MISSING', '管理员运行时目录缺失', { required });
    }
  }

  const apiFiles = listFilesRecursive(apiRoot);
  if (!apiFiles.length || apiFiles.some(file => {
    const relative = path.relative(adminApiRoot, file);
    return relative.startsWith('..') || path.isAbsolute(relative);
  })) {
    fail('ADMIN_DEPLOYMENT_API_SCOPE_INVALID', '管理员子项目只能包含/api/admin Cloud Functions', {
      apiFiles: apiFiles.map(file => path.relative(projectRoot, file)),
    });
  }

  const javascriptFiles = [
    ...listFilesRecursive(functionsRoot),
    ...listFilesRecursive(serverRoot),
  ].filter(file => file.endsWith('.js'));
  const importPattern = /(?:from\s*|import\s*)['"]([^'"]+)['"]/gu;
  let totalRuntimeBytes = 0;
  for (const file of javascriptFiles) {
    const source = fs.readFileSync(file, 'utf8');
    totalRuntimeBytes += Buffer.byteLength(source, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(file, specifier);
      if (!resolved) {
        fail('ADMIN_DEPLOYMENT_RELATIVE_IMPORT_MISSING', '管理员运行时相对导入无法解析', {
          importer: path.relative(projectRoot, file),
          specifier,
        });
      }
      const relative = path.relative(projectRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('ADMIN_DEPLOYMENT_IMPORT_ESCAPE', '管理员运行时相对导入逃逸项目根目录', {
          importer: path.relative(projectRoot, file),
          specifier,
          resolved,
        });
      }
    }
  }
  if (totalRuntimeBytes > 32 * 1024 * 1024) {
    fail('ADMIN_DEPLOYMENT_RUNTIME_TOO_LARGE', '管理员运行时源代码超过安全上限', { totalRuntimeBytes });
  }
  return Object.freeze({
    cloudFunctionFileCount: listFilesRecursive(functionsRoot).length,
    administratorApiFileCount: apiFiles.length,
    serverFileCount: listFilesRecursive(serverRoot).length,
    javascriptFileCount: javascriptFiles.length,
    totalRuntimeBytes,
  });
}

function fileDescriptor(outputRoot, filename, contentType) {
  const bytes = fs.readFileSync(path.join(outputRoot, filename));
  return Object.freeze({ filename, contentType, bytes: bytes.length, sha256: sha256(bytes) });
}

function auditStaticOutput(outputRoot) {
  const files = fs.readdirSync(outputRoot).sort();
  const expected = [...ADMIN_STATIC_FILES].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    fail('ADMIN_DEPLOYMENT_STATIC_SCOPE_INVALID', '管理员静态产物文件范围无效', { files, expected });
  }
  for (const filename of files) {
    const stat = fs.lstatSync(path.join(outputRoot, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('ADMIN_DEPLOYMENT_STATIC_FILE_INVALID', '管理员静态产物必须为普通文件', { filename });
    }
  }
  const html = fs.readFileSync(path.join(outputRoot, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(outputRoot, 'production-console.js'), 'utf8');
  if (!html.includes(`<title>${ADMIN_TITLE}</title>`)
      || !html.includes('./production-console.css')
      || !html.includes('./production-console.js')) {
    fail('ADMIN_DEPLOYMENT_ASSET_LINK_INVALID', '管理员入口身份或同源资源引用无效');
  }
  if (!script.includes(ADMIN_SESSION_RENDERED) || script.includes(ADMIN_SESSION_TEMPLATE)) {
    fail('ADMIN_DEPLOYMENT_SESSION_PROBE_INVALID', '管理员部署未启用可见初始会话检查');
  }
  const combined = files.map(filename => fs.readFileSync(path.join(outputRoot, filename), 'utf8')).join('\n');
  for (const marker of [
    'build-manifest.json',
    'pages-release.json',
    '码单器8.2.31（公共协作发布候选版）',
    "const APP_VERSION = '8.2.31';",
  ]) {
    if (combined.includes(marker)) {
      fail('ADMIN_DEPLOYMENT_PUBLIC_ARTIFACT_LEAK', '管理员产物混入普通用户候选内容', { marker });
    }
  }
  return Object.freeze(files);
}

export function prepareAdminDeploymentRoot({ repositoryRoot, projectRoot, commitSha } = {}) {
  const repo = path.resolve(repositoryRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const project = path.resolve(projectRoot || path.join(repo, ADMIN_DEPLOYMENT_ROOT));
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    fail('ADMIN_DEPLOYMENT_PROJECT_ROOT_MISSING', '管理员项目根目录不存在', { project });
  }
  const outputRoot = resolveInside(project, path.join(project, ADMIN_STATIC_OUTPUT), 'ADMIN_DEPLOYMENT_OUTPUT_UNSAFE');
  const generatedFunctions = resolveInside(project, path.join(project, 'cloud-functions'), 'ADMIN_DEPLOYMENT_FUNCTIONS_UNSAFE');
  const generatedSource = resolveInside(project, path.join(project, 'src'), 'ADMIN_DEPLOYMENT_SOURCE_UNSAFE');
  const sourceCommit = checkedCommit(commitSha || process.env.GITHUB_SHA || repositoryCommit(repo));

  for (const generated of [outputRoot, generatedFunctions, generatedSource]) {
    fs.rmSync(generated, { recursive: true, force: true });
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const htmlSource = path.join(repo, 'admin', 'production-console.html');
  const cssSource = path.join(repo, 'admin', 'production-console.css');
  const jsSource = path.join(repo, 'admin', 'production-console.js');
  for (const source of [htmlSource, cssSource, jsSource]) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      fail('ADMIN_DEPLOYMENT_CONSOLE_SOURCE_MISSING', '管理员控制台源文件不存在', { source });
    }
  }
  writeFile(path.join(outputRoot, 'index.html'), fs.readFileSync(htmlSource));
  writeFile(path.join(outputRoot, 'production-console.css'), fs.readFileSync(cssSource));
  writeFile(
    path.join(outputRoot, 'production-console.js'),
    Buffer.from(renderConsoleScript(fs.readFileSync(jsSource, 'utf8')), 'utf8'),
  );

  copyDirectory(path.join(repo, 'cloud-functions', '_shared'), path.join(generatedFunctions, '_shared'));
  copyDirectory(path.join(repo, 'cloud-functions', 'api', 'admin'), path.join(generatedFunctions, 'api', 'admin'));
  copyDirectory(path.join(repo, 'src', 'server'), path.join(generatedSource, 'server'));
  const runtimeAudit = auditGeneratedFunctions(project);

  const contentFiles = Object.freeze([
    fileDescriptor(outputRoot, 'index.html', 'text/html; charset=utf-8'),
    fileDescriptor(outputRoot, 'production-console.css', 'text/css; charset=utf-8'),
    fileDescriptor(outputRoot, 'production-console.js', 'application/javascript; charset=utf-8'),
  ]);
  const release = Object.freeze({
    schemaVersion: 1,
    kind: 'production_admin_console_deployment',
    deploymentStatus: 'code_complete_not_deployed',
    sourceCommit,
    title: ADMIN_TITLE,
    projectRoot: ADMIN_DEPLOYMENT_ROOT,
    projectConfig: 'deploy/admin/edgeone.json',
    outputDirectory: ADMIN_STATIC_OUTPUT,
    outputFiles: ADMIN_STATIC_FILES,
    contentFiles,
    runtimeAudit,
    apiScope: '/api/admin/*',
    anonymousPublicApiIncluded: false,
    intendedOriginEnv: 'CLOUD_ADMIN_PUBLIC_ORIGIN',
    requiresSeparateAdministratorOrigin: true,
    requiresProductionAdminSession: true,
    platformResponseHeadersRequired: true,
    responseHeadersConfiguredByEdgeOneJson: true,
    initialSessionProbeVisible: true,
    includesOrdinaryUserCandidate: false,
    includesSecretValues: false,
    productionCapabilitiesDefaultOff: true,
    frozenPublicCandidate: FROZEN_PUBLIC_CANDIDATE,
    stableVersion: '8.2.25',
    candidateVersion: FROZEN_PUBLIC_CANDIDATE.version,
    stablePromotionAuthorized: false,
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
  });
  writeFile(
    path.join(outputRoot, 'admin-release.json'),
    Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8'),
  );
  const files = auditStaticOutput(outputRoot);
  return Object.freeze({ repositoryRoot: repo, projectRoot: project, outputRoot, files, release });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = prepareAdminDeploymentRoot({
    repositoryRoot: argumentValue('--repository-root') || defaultRoot,
    projectRoot: argumentValue('--project-root'),
    commitSha: argumentValue('--commit'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
