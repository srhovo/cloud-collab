import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATE_VERSION = '8.2.31';

export class PublicDeploymentVerificationError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'PublicDeploymentVerificationError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new PublicDeploymentVerificationError(code, message, details);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deploymentBase(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('PUBLIC_DEPLOYMENT_URL_INVALID', '部署地址无效');
  }
  if (url.protocol !== 'https:') fail('PUBLIC_DEPLOYMENT_URL_INVALID', '部署地址必须使用HTTPS');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assetUrl(base, filename, nonce) {
  const url = new URL(filename, base);
  url.searchParams.set('release_verify', nonce);
  return url;
}

function header(response, name) {
  return String(response?.headers?.get?.(name) || '').trim();
}

async function responseBytes(response, label) {
  if (!response || response.status !== 200) {
    fail('PUBLIC_DEPLOYMENT_HTTP_FAILURE', `${label}读取失败`, { status: response?.status ?? null });
  }
  return Buffer.from(await response.arrayBuffer());
}

function assertContentType(response, expected, label, { requireUtf8 = false } = {}) {
  const value = header(response, 'content-type').toLowerCase();
  const utf8 = /charset\s*=\s*utf-?8\b/.test(value);
  if (!value.includes(expected) || (requireUtf8 && !utf8)) {
    fail('PUBLIC_DEPLOYMENT_CONTENT_TYPE_INVALID', `${label} Content-Type无效`, {
      value,
      expected,
      requireUtf8,
    });
  }
}

function assertEdgeOneHeaders(response, label) {
  const cacheControl = header(response, 'cache-control').toLowerCase();
  if (!cacheControl.includes('max-age=0') || !cacheControl.includes('must-revalidate')) {
    fail('PUBLIC_DEPLOYMENT_CACHE_HEADER_INVALID', `${label}缓存头无效`, { cacheControl });
  }
  const required = new Map([
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'deny'],
    ['referrer-policy', 'no-referrer'],
  ]);
  for (const [name, expected] of required) {
    const actual = header(response, name).toLowerCase();
    if (actual !== expected) {
      fail('PUBLIC_DEPLOYMENT_SECURITY_HEADER_INVALID', `${label}缺少安全响应头`, {
        name,
        expected,
        actual,
      });
    }
  }
}

async function verifyOnce({ base, expectedCommitSha, expectedChannel, fetchImpl, nonce }) {
  const releaseResponse = await fetchImpl(assetUrl(base, 'pages-release.json', nonce), {
    cache: 'no-store',
    redirect: 'follow',
  });
  const releaseBytes = await responseBytes(releaseResponse, 'pages-release.json');
  assertContentType(releaseResponse, 'application/json', 'pages-release.json', {
    requireUtf8: expectedChannel === 'edgeone-primary',
  });
  if (expectedChannel === 'edgeone-primary') assertEdgeOneHeaders(releaseResponse, 'pages-release.json');

  let release;
  try {
    release = JSON.parse(releaseBytes.toString('utf8'));
  } catch {
    fail('PUBLIC_DEPLOYMENT_RELEASE_JSON_INVALID', '线上发布清单JSON无效');
  }
  if (release.schemaVersion !== 1
      || release.kind !== 'candidate_preview_deployment'
      || release.deploymentStatus !== 'candidate_preview_not_stable'
      || release.channel !== expectedChannel
      || release.sourceCommit !== expectedCommitSha
      || release.candidate?.version !== CANDIDATE_VERSION
      || release.stable?.version !== '8.2.25'
      || release.stable?.promotionAuthorized !== false
      || release.stable?.promotionPerformed !== false
      || release.allPreviewCapabilitiesDefaultOff !== true
      || release.productionWriteEnablementIncluded !== false) {
    fail('PUBLIC_DEPLOYMENT_RELEASE_IDENTITY_MISMATCH', '线上发布清单身份或边界不匹配', {
      expectedCommitSha,
      actualCommitSha: release.sourceCommit || null,
      expectedChannel,
      actualChannel: release.channel || null,
    });
  }

  const indexResponse = await fetchImpl(assetUrl(base, 'index.html', nonce), {
    cache: 'no-store',
    redirect: 'follow',
  });
  const indexBytes = await responseBytes(indexResponse, 'index.html');
  assertContentType(indexResponse, 'text/html', 'index.html');
  if (expectedChannel === 'edgeone-primary') assertEdgeOneHeaders(indexResponse, 'index.html');
  if (digest(indexBytes) !== release.candidate.sha256 || indexBytes.length !== release.candidate.bytes) {
    fail('PUBLIC_DEPLOYMENT_INDEX_HASH_MISMATCH', '线上HTML摘要或字节数不匹配');
  }
  const indexText = indexBytes.toString('utf8');
  const title = indexText.match(/<title>([^<]+)<\/title>/i)?.[1] || null;
  if (title !== release.candidate.title
      || !indexText.includes(`const APP_VERSION = '${CANDIDATE_VERSION}';`)) {
    fail('PUBLIC_DEPLOYMENT_HTML_IDENTITY_MISMATCH', '线上HTML标题或APP_VERSION不匹配', { title });
  }

  const buildManifestResponse = await fetchImpl(assetUrl(base, 'build-manifest.json', nonce), {
    cache: 'no-store',
    redirect: 'follow',
  });
  const buildManifestBytes = await responseBytes(buildManifestResponse, 'build-manifest.json');
  assertContentType(buildManifestResponse, 'application/json', 'build-manifest.json', {
    requireUtf8: expectedChannel === 'edgeone-primary',
  });
  if (expectedChannel === 'edgeone-primary') assertEdgeOneHeaders(buildManifestResponse, 'build-manifest.json');
  let buildManifest;
  try {
    buildManifest = JSON.parse(buildManifestBytes.toString('utf8'));
  } catch {
    fail('PUBLIC_DEPLOYMENT_BUILD_MANIFEST_JSON_INVALID', '线上构建清单JSON无效');
  }
  if (digest(buildManifestBytes) !== release.buildManifestSha256
      || buildManifest.version !== release.candidate.version
      || buildManifest.sha256 !== release.candidate.sha256
      || buildManifest.bytes !== release.candidate.bytes) {
    fail('PUBLIC_DEPLOYMENT_BUILD_MANIFEST_MISMATCH', '线上构建清单与发布清单不匹配');
  }

  const excludedResponse = await fetchImpl(assetUrl(base, 'admin-sensitive-reviews-preview.html', nonce), {
    cache: 'no-store',
    redirect: 'follow',
  });
  if (excludedResponse?.status === 200) {
    fail('PUBLIC_DEPLOYMENT_PREVIEW_PAGE_EXPOSED', '管理员预览页不应出现在公开候选入口');
  }

  return Object.freeze({
    status: 'verified_candidate_preview_not_stable',
    url: base.href,
    channel: expectedChannel,
    sourceCommit: release.sourceCommit,
    candidateVersion: release.candidate.version,
    sha256: release.candidate.sha256,
    bytes: release.candidate.bytes,
    publicJsonUtf8Verified: expectedChannel === 'edgeone-primary',
    stablePromotionPerformed: false,
    productionWriteEnablementIncluded: false,
  });
}

export async function verifyPublicDeployment({
  url,
  expectedCommitSha,
  expectedChannel = 'github-pages-backup',
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 5000,
} = {}) {
  const base = deploymentBase(url);
  const commit = String(expectedCommitSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    fail('PUBLIC_DEPLOYMENT_COMMIT_INVALID', '必须提供40位预期Git提交SHA');
  }
  if (!['edgeone-primary', 'github-pages-backup'].includes(expectedChannel)) {
    fail('PUBLIC_DEPLOYMENT_CHANNEL_INVALID', '预期部署通道无效');
  }
  if (typeof fetchImpl !== 'function') fail('PUBLIC_DEPLOYMENT_FETCH_MISSING', '当前运行时不支持fetch');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 12) {
    fail('PUBLIC_DEPLOYMENT_ATTEMPTS_INVALID', '重试次数无效');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyOnce({
        base,
        expectedCommitSha: commit,
        expectedChannel,
        fetchImpl,
        nonce: `${commit.slice(0, 12)}-${attempt}-${Date.now()}`,
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(retryDelayMs);
    }
  }
  fail('PUBLIC_DEPLOYMENT_VERIFY_FAILED', '线上候选部署在重试窗口内未通过一致性验证', {
    causeCode: lastError?.code || null,
    causeMessage: lastError?.message || String(lastError),
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run() {
  const result = await verifyPublicDeployment({
    url: argumentValue('--url'),
    expectedCommitSha: argumentValue('--expected-commit') || process.env.GITHUB_SHA,
    expectedChannel: argumentValue('--expected-channel') || 'github-pages-backup',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
