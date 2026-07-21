import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_CONFIG_TEMPLATE,
  ADMIN_CONSOLE_FILES,
} from './prepare-admin-console-v1.mjs';
import { PUBLIC_CANDIDATE_FILES } from './prepare-public-candidate-v1.mjs';

export class AdminArtifactIsolationError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'AdminArtifactIsolationError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new AdminArtifactIsolationError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(absolutePath, label) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    fail('ADMIN_ARTIFACT_JSON_INVALID', `${label}JSON无效`, { absolutePath });
  }
}

function exactFiles(directory, expected, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail('ADMIN_ARTIFACT_DIRECTORY_MISSING', `${label}目录不存在`, { directory });
  }
  const files = fs.readdirSync(directory).sort();
  if (JSON.stringify(files) !== JSON.stringify([...expected].sort())) {
    fail('ADMIN_ARTIFACT_FILES_INVALID', `${label}文件范围无效`, { files, expected });
  }
  for (const filename of files) {
    const stat = fs.lstatSync(path.join(directory, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('ADMIN_ARTIFACT_FILE_TYPE_INVALID', `${label}只能包含普通文件`, { filename });
    }
  }
  return files;
}

function headersFor(config, source) {
  const rule = Array.isArray(config.headers) ? config.headers.find(item => item?.source === source) : null;
  return new Map((rule?.headers || []).map(item => [String(item.key || '').toLowerCase(), String(item.value || '')]));
}

function requireHeader(headers, key, expected, code) {
  const actual = headers.get(key.toLowerCase());
  if (actual !== expected) fail(code, `管理员项目响应头${key}无效`, { actual, expected });
}

export function auditAdminProjectConfig({ root, configPath } = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const relative = configPath || ADMIN_CONSOLE_CONFIG_TEMPLATE;
  const config = readJson(path.join(repositoryRoot, relative), '管理员项目配置');
  if (config.buildCommand !== 'npm run edgeone:admin:build'
      || config.installCommand !== 'npm ci --ignore-scripts'
      || config.outputDirectory !== './.edgeone-admin-artifact'
      || config.nodeVersion !== '22.11.0') {
    fail('ADMIN_PROJECT_BUILD_CONFIG_INVALID', '管理员项目构建配置无效');
  }

  const global = headersFor(config, '/*');
  requireHeader(global, 'cache-control', 'no-store, max-age=0', 'ADMIN_PROJECT_CACHE_HEADER_INVALID');
  requireHeader(global, 'strict-transport-security', 'max-age=31536000', 'ADMIN_PROJECT_HSTS_INVALID');
  requireHeader(global, 'x-content-type-options', 'nosniff', 'ADMIN_PROJECT_NOSNIFF_INVALID');
  requireHeader(global, 'x-frame-options', 'DENY', 'ADMIN_PROJECT_FRAME_HEADER_INVALID');
  requireHeader(global, 'referrer-policy', 'no-referrer', 'ADMIN_PROJECT_REFERRER_HEADER_INVALID');
  requireHeader(global, 'cross-origin-opener-policy', 'same-origin', 'ADMIN_PROJECT_COOP_INVALID');
  requireHeader(global, 'cross-origin-resource-policy', 'same-origin', 'ADMIN_PROJECT_CORP_INVALID');
  requireHeader(global, 'permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'ADMIN_PROJECT_PERMISSIONS_INVALID');

  const csp = global.get('content-security-policy') || '';
  for (const directive of [
    "default-src 'none'",
    "connect-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]) {
    if (!csp.includes(directive)) {
      fail('ADMIN_PROJECT_CSP_INVALID', '管理员项目CSP缺少必要指令', { directive });
    }
  }

  for (const [source, contentType] of [
    ['/index.html', 'text/html; charset=utf-8'],
    ['/production-console.css', 'text/css; charset=utf-8'],
    ['/production-console.js', 'application/javascript; charset=utf-8'],
    ['/admin-release.json', 'application/json; charset=utf-8'],
  ]) {
    requireHeader(headersFor(config, source), 'content-type', contentType, 'ADMIN_PROJECT_CONTENT_TYPE_INVALID');
  }
  return Object.freeze({ verified: true, configPath: relative });
}

export function verifyAdminPublicArtifactIsolation({
  root,
  adminDirectory,
  publicDirectory,
  configPath,
} = {}) {
  const repositoryRoot = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const adminDir = path.resolve(adminDirectory || path.join(repositoryRoot, '.edgeone-admin-artifact'));
  const publicDir = path.resolve(publicDirectory || path.join(repositoryRoot, '.edgeone-artifact'));
  const adminFiles = exactFiles(adminDir, ADMIN_CONSOLE_FILES, '管理员产物');
  const publicFiles = exactFiles(publicDir, PUBLIC_CANDIDATE_FILES, '普通用户产物');
  auditAdminProjectConfig({ root: repositoryRoot, configPath });

  const release = readJson(path.join(adminDir, 'admin-release.json'), '管理员发布清单');
  if (release.kind !== 'production_admin_console_artifact'
      || release.deploymentStatus !== 'code_complete_not_deployed'
      || !/^[a-f0-9]{40}$/.test(String(release.sourceCommit || ''))
      || release.requiresSeparateAdministratorOrigin !== true
      || release.requiresProductionAdminSession !== true
      || release.platformResponseHeadersRequired !== true
      || release.includesOrdinaryUserCandidate !== false
      || release.includesSecretValues !== false
      || release.productionCapabilitiesDefaultOff !== true
      || release.frozenPublicCandidate?.version !== '8.2.31'
      || release.frozenPublicCandidate?.sha256 !== '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b'
      || release.stableVersion !== '8.2.25'
      || release.stablePromotionAuthorized !== false
      || release.stablePromotionPerformed !== false
      || release.productionWriteEnablementIncluded !== false) {
    fail('ADMIN_RELEASE_BOUNDARY_INVALID', '管理员发布清单边界无效');
  }
  if (JSON.stringify([...release.outputFiles].sort()) !== JSON.stringify([...ADMIN_CONSOLE_FILES].sort())) {
    fail('ADMIN_RELEASE_OUTPUT_FILES_INVALID', '管理员发布清单文件范围无效');
  }
  if (!Array.isArray(release.sourceFiles) || release.sourceFiles.length !== 3) {
    fail('ADMIN_RELEASE_SOURCE_FILES_INVALID', '管理员发布清单源文件无效');
  }

  for (const item of release.sourceFiles) {
    const sourceBytes = fs.readFileSync(path.join(repositoryRoot, item.sourcePath));
    const outputBytes = fs.readFileSync(path.join(adminDir, item.outputFile));
    if (!sourceBytes.equals(outputBytes)
        || digest(sourceBytes) !== item.sha256
        || sourceBytes.length !== item.bytes) {
      fail('ADMIN_SOURCE_OUTPUT_MISMATCH', '管理员源文件、输出文件或摘要不一致', { item });
    }
  }

  const adminIndex = fs.readFileSync(path.join(adminDir, 'index.html'));
  const publicIndex = fs.readFileSync(path.join(publicDir, 'index.html'));
  if (adminIndex.equals(publicIndex)) fail('ADMIN_PUBLIC_INDEX_COLLISION', '管理员与普通用户首页发生内容碰撞');

  const publicManifest = readJson(path.join(publicDir, 'build-manifest.json'), '普通用户构建清单');
  const publicRelease = readJson(path.join(publicDir, 'pages-release.json'), '普通用户发布清单');
  if (publicManifest.version !== '8.2.31'
      || publicManifest.sha256 !== digest(publicIndex)
      || publicManifest.bytes !== publicIndex.length
      || publicRelease.candidate?.version !== '8.2.31'
      || publicRelease.candidate?.sha256 !== publicManifest.sha256
      || publicRelease.stable?.version !== '8.2.25'
      || publicRelease.stable?.promotionAuthorized !== false
      || publicRelease.stable?.promotionPerformed !== false
      || publicRelease.productionWriteEnablementIncluded !== false) {
    fail('PUBLIC_ARTIFACT_BOUNDARY_INVALID', '普通用户候选产物边界无效');
  }

  const adminCombined = [
    fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8'),
    fs.readFileSync(path.join(adminDir, 'production-console.css'), 'utf8'),
    fs.readFileSync(path.join(adminDir, 'production-console.js'), 'utf8'),
  ].join('\n');
  if (adminCombined.includes('码单器8.2.31（公共协作发布候选版）')
      || adminCombined.includes("const APP_VERSION = '8.2.31';")
      || adminFiles.includes('build-manifest.json')
      || adminFiles.includes('pages-release.json')) {
    fail('PUBLIC_CONTENT_LEAKED_INTO_ADMIN', '普通用户候选内容混入管理员产物');
  }
  if (publicFiles.includes('admin-release.json')
      || publicFiles.includes('production-console.css')
      || publicFiles.includes('production-console.js')) {
    fail('ADMIN_CONTENT_LEAKED_INTO_PUBLIC', '管理员文件混入普通用户产物');
  }

  return Object.freeze({
    verified: true,
    adminFiles: Object.freeze(adminFiles),
    publicFiles: Object.freeze(publicFiles),
    adminIndexSha256: digest(adminIndex),
    publicIndexSha256: digest(publicIndex),
    mutuallyExclusive: true,
    deploymentPerformed: false,
    productionWriteEnablementIncluded: false,
    stablePromotionAuthorized: false,
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = verifyAdminPublicArtifactIsolation({
    root,
    adminDirectory: argumentValue('--admin'),
    publicDirectory: argumentValue('--public'),
    configPath: argumentValue('--config'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
