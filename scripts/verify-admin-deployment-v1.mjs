import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_CONSOLE_FILES } from './prepare-admin-console-v1.mjs';

const ADMIN_TITLE = '码单器正式管理员控制台';
const FROZEN_PUBLIC_CANDIDATE_SHA256 = '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b';
const SOURCE_OUTPUTS = Object.freeze([
  Object.freeze({ sourcePath: 'admin/production-console.html', outputFile: 'index.html', contentType: 'text/html' }),
  Object.freeze({ sourcePath: 'admin/production-console.css', outputFile: 'production-console.css', contentType: 'text/css' }),
  Object.freeze({ sourcePath: 'admin/production-console.js', outputFile: 'production-console.js', contentType: 'application/javascript' }),
]);
const MAX_BYTES = Object.freeze({
  'admin-release.json': 256 * 1024,
  'index.html': 512 * 1024,
  'production-console.css': 512 * 1024,
  'production-console.js': 2 * 1024 * 1024,
});

export class AdminDeploymentVerificationError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'AdminDeploymentVerificationError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new AdminDeploymentVerificationError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deploymentBase(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('ADMIN_DEPLOYMENT_URL_INVALID', '管理员部署来源无效');
  }
  if (url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== '/') {
    fail('ADMIN_DEPLOYMENT_URL_INVALID', '管理员部署地址必须是无凭据、无路径、无查询参数的HTTPS来源');
  }
  return url;
}

function assetUrl(base, filename, nonce) {
  const url = new URL(filename, base);
  url.searchParams.set('admin_verify', nonce);
  return url;
}

function header(response, name) {
  return String(response?.headers?.get?.(name) || '').trim();
}

function normalizedTokens(value) {
  return String(value || '').trim().split(/\s+/u).filter(Boolean).sort();
}

function cspDirectives(value) {
  const directives = new Map();
  for (const segment of String(value || '').split(';')) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens.shift().toLowerCase();
    if (directives.has(name)) {
      fail('ADMIN_DEPLOYMENT_CSP_DUPLICATE', '管理员部署CSP包含重复指令', { name });
    }
    directives.set(name, tokens.sort());
  }
  return directives;
}

function assertExactDirective(directives, name, expected) {
  const actual = directives.get(name);
  if (JSON.stringify(actual || null) !== JSON.stringify([...expected].sort())) {
    fail('ADMIN_DEPLOYMENT_CSP_INVALID', '管理员部署CSP指令无效', { name, actual: actual || null, expected });
  }
}

function assertSecurityHeaders(response, label) {
  const cacheControl = header(response, 'cache-control').toLowerCase();
  if (!cacheControl.split(',').map(value => value.trim()).includes('no-store')
      || !/\bmax-age\s*=\s*0\b/u.test(cacheControl)) {
    fail('ADMIN_DEPLOYMENT_CACHE_HEADER_INVALID', `${label}缓存头无效`, { cacheControl });
  }

  const hsts = header(response, 'strict-transport-security').toLowerCase();
  const maxAge = Number(/(?:^|;)\s*max-age\s*=\s*(\d+)/u.exec(hsts)?.[1]);
  if (!Number.isSafeInteger(maxAge) || maxAge < 31_536_000) {
    fail('ADMIN_DEPLOYMENT_HSTS_INVALID', `${label} HSTS无效`, { hsts });
  }

  for (const [name, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'deny'],
    ['referrer-policy', 'no-referrer'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['cross-origin-resource-policy', 'same-origin'],
  ]) {
    const actual = header(response, name).toLowerCase();
    if (actual !== expected) {
      fail('ADMIN_DEPLOYMENT_SECURITY_HEADER_INVALID', `${label}安全响应头无效`, { name, actual, expected });
    }
  }

  const permissions = header(response, 'permissions-policy').toLowerCase();
  for (const token of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) {
    if (!permissions.split(',').map(value => value.trim()).includes(token)) {
      fail('ADMIN_DEPLOYMENT_PERMISSIONS_POLICY_INVALID', `${label} Permissions-Policy无效`, { token, permissions });
    }
  }

  const directives = cspDirectives(header(response, 'content-security-policy'));
  for (const [name, expected] of [
    ['default-src', ["'none'"]],
    ['connect-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['img-src', ["'none'"]],
    ['font-src', ["'none'"]],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['worker-src', ["'none'"]],
    ['manifest-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ]) {
    assertExactDirective(directives, name, expected);
  }
}

function assertContentType(response, expected, label) {
  const value = header(response, 'content-type').toLowerCase();
  if (!value.includes(expected) || !/charset\s*=\s*utf-?8\b/u.test(value)) {
    fail('ADMIN_DEPLOYMENT_CONTENT_TYPE_INVALID', `${label} Content-Type无效`, { value, expected });
  }
}

async function responseBytes(response, filename) {
  if (!response || response.status !== 200) {
    fail('ADMIN_DEPLOYMENT_HTTP_FAILURE', `${filename}读取失败`, { status: response?.status ?? null });
  }
  const maximum = MAX_BYTES[filename];
  const declared = Number(header(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    fail('ADMIN_DEPLOYMENT_ASSET_TOO_LARGE', `${filename}超过安全大小`, { declared, maximum });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximum) {
    fail('ADMIN_DEPLOYMENT_ASSET_SIZE_INVALID', `${filename}大小无效`, { bytes: bytes.length, maximum });
  }
  return bytes;
}

function exactStringArray(actual, expected) {
  return Array.isArray(actual)
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function assertRelease(release, expectedCommitSha) {
  if (release?.schemaVersion !== 1
      || release.kind !== 'production_admin_console_artifact'
      || release.deploymentStatus !== 'code_complete_not_deployed'
      || release.sourceCommit !== expectedCommitSha
      || release.title !== ADMIN_TITLE
      || !exactStringArray(release.outputFiles, ADMIN_CONSOLE_FILES)
      || release.projectConfigTemplate !== 'config/edgeone-admin.project.json'
      || release.intendedOriginEnv !== 'CLOUD_ADMIN_PUBLIC_ORIGIN'
      || release.requiresSeparateAdministratorOrigin !== true
      || release.requiresProductionAdminSession !== true
      || release.platformResponseHeadersRequired !== true
      || release.includesOrdinaryUserCandidate !== false
      || release.includesSecretValues !== false
      || release.productionCapabilitiesDefaultOff !== true
      || release.frozenPublicCandidate?.version !== '8.2.31'
      || release.frozenPublicCandidate?.sha256 !== FROZEN_PUBLIC_CANDIDATE_SHA256
      || release.stableVersion !== '8.2.25'
      || release.stablePromotionAuthorized !== false
      || release.stablePromotionPerformed !== false
      || release.productionWriteEnablementIncluded !== false) {
    fail('ADMIN_DEPLOYMENT_RELEASE_IDENTITY_MISMATCH', '线上管理员发布清单身份或边界不匹配', {
      expectedCommitSha,
      actualCommitSha: release?.sourceCommit || null,
    });
  }
  if (!Array.isArray(release.sourceFiles) || release.sourceFiles.length !== SOURCE_OUTPUTS.length) {
    fail('ADMIN_DEPLOYMENT_RELEASE_SOURCES_INVALID', '线上管理员发布清单源文件范围无效');
  }
  const byOutput = new Map();
  for (const item of release.sourceFiles) {
    if (!item || typeof item !== 'object' || byOutput.has(item.outputFile)) {
      fail('ADMIN_DEPLOYMENT_RELEASE_SOURCES_INVALID', '线上管理员发布清单源文件重复或无效');
    }
    byOutput.set(item.outputFile, item);
  }
  for (const expected of SOURCE_OUTPUTS) {
    const item = byOutput.get(expected.outputFile);
    if (!item
        || item.sourcePath !== expected.sourcePath
        || !/^[a-f0-9]{64}$/u.test(String(item.sha256 || ''))
        || !Number.isSafeInteger(item.bytes)
        || item.bytes < 1
        || item.bytes > MAX_BYTES[expected.outputFile]) {
      fail('ADMIN_DEPLOYMENT_RELEASE_SOURCES_INVALID', '线上管理员发布清单源文件摘要无效', { expected, item: item || null });
    }
  }
  return byOutput;
}

function assertAssetIdentity(filename, text) {
  if (filename === 'index.html') {
    const title = /<title>([^<]+)<\/title>/iu.exec(text)?.[1] || null;
    if (title !== ADMIN_TITLE
        || !text.includes('<link rel="stylesheet" href="./production-console.css">')
        || !text.includes('<script src="./production-console.js" defer></script>')
        || text.includes('码单器8.2.31（公共协作发布候选版）')
        || text.includes("const APP_VERSION = '8.2.31';")) {
      fail('ADMIN_DEPLOYMENT_HTML_IDENTITY_MISMATCH', '线上管理员HTML身份无效', { title });
    }
  }
  if (filename === 'production-console.css' && /(?:url\s*\(|@import|https?:\/\/)/iu.test(text)) {
    fail('ADMIN_DEPLOYMENT_CSS_EXTERNAL_RESOURCE', '线上管理员CSS包含外部资源');
  }
  if (filename === 'production-console.js') {
    for (const required of [
      '/api/admin/auth/login',
      '/api/admin/reviews',
      '/api/admin/sensitive-reviews',
      '/api/admin/devices',
      '/api/admin/rollbacks',
      '/api/admin/exports/download',
      "credentials: 'same-origin'",
      "cache: 'no-store'",
      "x-cloud-collab-stable-promotion-authorized",
    ]) {
      if (!text.includes(required)) {
        fail('ADMIN_DEPLOYMENT_JS_IDENTITY_MISMATCH', '线上管理员脚本缺少正式控制面锚点', { required });
      }
    }
    if (/(?:localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|https?:\/\/)/u.test(text)) {
      fail('ADMIN_DEPLOYMENT_JS_FORBIDDEN_CONTENT', '线上管理员脚本包含禁止内容');
    }
  }
}

async function fetchAsset(fetchImpl, base, filename, nonce) {
  let response;
  try {
    response = await fetchImpl(assetUrl(base, filename, nonce), {
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    fail('ADMIN_DEPLOYMENT_FETCH_FAILED', `${filename}请求失败`, { cause: error?.message || String(error) });
  }
  const bytes = await responseBytes(response, filename);
  assertSecurityHeaders(response, filename);
  return Object.freeze({ response, bytes });
}

async function verifyOnce({ base, expectedCommitSha, fetchImpl, nonce }) {
  const releaseAsset = await fetchAsset(fetchImpl, base, 'admin-release.json', nonce);
  assertContentType(releaseAsset.response, 'application/json', 'admin-release.json');
  let release;
  try {
    release = JSON.parse(releaseAsset.bytes.toString('utf8'));
  } catch {
    fail('ADMIN_DEPLOYMENT_RELEASE_JSON_INVALID', '线上管理员发布清单JSON无效');
  }
  const sources = assertRelease(release, expectedCommitSha);

  const verifiedFiles = [];
  for (const expected of SOURCE_OUTPUTS) {
    const asset = await fetchAsset(fetchImpl, base, expected.outputFile, nonce);
    assertContentType(asset.response, expected.contentType, expected.outputFile);
    const manifestItem = sources.get(expected.outputFile);
    const actualSha256 = digest(asset.bytes);
    if (actualSha256 !== manifestItem.sha256 || asset.bytes.length !== manifestItem.bytes) {
      fail('ADMIN_DEPLOYMENT_ASSET_HASH_MISMATCH', '线上管理员文件摘要或字节数不匹配', {
        filename: expected.outputFile,
        expectedSha256: manifestItem.sha256,
        actualSha256,
        expectedBytes: manifestItem.bytes,
        actualBytes: asset.bytes.length,
      });
    }
    assertAssetIdentity(expected.outputFile, asset.bytes.toString('utf8'));
    verifiedFiles.push(Object.freeze({
      filename: expected.outputFile,
      sha256: actualSha256,
      bytes: asset.bytes.length,
    }));
  }

  for (const excluded of ['build-manifest.json', 'pages-release.json']) {
    let response;
    try {
      response = await fetchImpl(assetUrl(base, excluded, nonce), {
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      fail('ADMIN_DEPLOYMENT_EXCLUDED_FILE_CHECK_FAILED', `${excluded}排除检查失败`, { cause: error?.message || String(error) });
    }
    if (![404, 410].includes(response?.status)) {
      fail('ADMIN_DEPLOYMENT_PUBLIC_FILE_EXPOSED', '普通用户候选文件不应出现在管理员来源', {
        filename: excluded,
        status: response?.status ?? null,
      });
    }
  }

  return Object.freeze({
    status: 'verified_admin_static_deployment_not_runtime_activation',
    origin: base.origin,
    sourceCommit: release.sourceCommit,
    files: Object.freeze(verifiedFiles),
    adminReleaseSha256: digest(releaseAsset.bytes),
    platformSecurityHeadersVerified: true,
    ordinaryUserCandidateFilesExcluded: true,
    runtimeActivationVerified: false,
    productionWriteEnablementIncluded: false,
    stablePromotionPerformed: false,
  });
}

export async function verifyAdminDeployment({
  url,
  expectedCommitSha,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 5000,
} = {}) {
  const base = deploymentBase(url);
  const commit = String(expectedCommitSha || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    fail('ADMIN_DEPLOYMENT_COMMIT_INVALID', '必须提供40位预期Git提交SHA');
  }
  if (typeof fetchImpl !== 'function') fail('ADMIN_DEPLOYMENT_FETCH_MISSING', '当前运行时不支持fetch');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 12) {
    fail('ADMIN_DEPLOYMENT_ATTEMPTS_INVALID', '管理员部署验证重试次数无效');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    fail('ADMIN_DEPLOYMENT_RETRY_DELAY_INVALID', '管理员部署验证重试延迟无效');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyOnce({
        base,
        expectedCommitSha: commit,
        fetchImpl,
        nonce: `${commit.slice(0, 12)}-${attempt}-${Date.now()}`,
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(retryDelayMs);
    }
  }
  fail('ADMIN_DEPLOYMENT_VERIFY_FAILED', '管理员静态部署在重试窗口内未通过验证', {
    causeCode: lastError?.code || null,
    causeMessage: lastError?.message || String(lastError),
    causeDetails: lastError?.details || null,
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run() {
  const result = await verifyAdminDeployment({
    url: argumentValue('--url'),
    expectedCommitSha: argumentValue('--expected-commit') || process.env.GITHUB_SHA,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
