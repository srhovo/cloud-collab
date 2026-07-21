import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@edgeone/pages-blob';

import {
  buildProductionBootstrapResources,
  executeProductionBootstrap,
} from '../src/server/production_bootstrap_v1.js';
import { readProductionRuntimeConfig } from '../src/server/production_runtime_config_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRMATION = 'INITIALIZE-see-see_cz-V1';
const PUBLIC_STORE = 'cloud-collab-production-v1';
const ADMIN_STORE = 'cloud-collab-admin-production-v1';

function fail(code, message, exitCode = 2) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(exitCode);
}

function replaceLiteral(value, secret) {
  const normalized = String(secret || '');
  if (!normalized) return value;
  return value.split(normalized).join('[REDACTED]');
}

export function sanitizeFailureMessage(message, {
  token = process.env.EDGEONE_API_TOKEN,
  projectId = process.env.EDGEONE_PROJECT_ID,
} = {}) {
  let safe = String(message || 'EdgeOne生产初始化失败');
  for (const secret of [token, projectId]) {
    const normalized = String(secret || '');
    safe = replaceLiteral(safe, normalized);
    if (normalized) safe = replaceLiteral(safe, encodeURIComponent(normalized));
  }
  return safe
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?token|token|authorization)\s*[=:]\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/\bpages-[A-Za-z0-9_-]{6,}\b/gu, 'pages-[REDACTED]');
}

function bootstrapEnv() {
  return Object.freeze({
    CLOUD_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '0',
    CLOUD_PRODUCTION_EXPORT_ENABLED: '0',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: CONFIRMATION,
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: PUBLIC_STORE,
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: ADMIN_STORE,
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_PUBLIC_ORIGIN: '',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: '',
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
  });
}

function buildPlan() {
  const config = readProductionRuntimeConfig(bootstrapEnv());
  const plan = buildProductionBootstrapResources(config);
  return Object.freeze({
    schemaVersion: 1,
    stage: '8G',
    operation: 'plan',
    status: 'ready_not_executed',
    projectIdConfigured: Boolean(String(process.env.EDGEONE_PROJECT_ID || '').trim()),
    apiTokenConfigured: Boolean(String(process.env.EDGEONE_API_TOKEN || '').trim()),
    publicStoreName: PUBLIC_STORE,
    adminStoreName: ADMIN_STORE,
    externalScope: plan.manifest.externalScope,
    protocolScope: plan.manifest.protocolScope,
    confirmationRequired: CONFIRMATION,
    resourceCount: plan.entries.length,
    resources: plan.manifest.resources,
    manifestSha256: plan.manifestSha256,
    namespaceCreation: 'automatic_on_first_sdk_getStore_call',
    blobConsoleAccess: 'read_only_browse',
    realSecretValuesExposed: false,
    realBlobReadsPerformed: 0,
    realBlobWritesPerformed: 0,
    realBlobDeletesPerformed: 0,
    productionCapabilitiesEnabled: false,
    stablePromotionAuthorized: false,
  });
}

function writeReport(report) {
  const requested = String(process.env.BOOTSTRAP_REPORT_PATH || '').trim();
  if (!requested) return;
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('BOOTSTRAP_REPORT_PATH_INVALID', '报告路径必须位于仓库目录内');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function readExecutionCredentials() {
  const projectId = String(process.env.EDGEONE_PROJECT_ID || '').trim();
  const token = String(process.env.EDGEONE_API_TOKEN || '').trim();
  const confirmation = String(process.env.CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION || '').trim();

  if (!/^pages-[A-Za-z0-9_-]{6,}$/u.test(projectId)) {
    fail('EDGEONE_PROJECT_ID_INVALID', 'EDGEONE_PROJECT_ID缺失或格式无效');
  }
  if (Buffer.byteLength(token, 'utf8') < 20) {
    fail('EDGEONE_API_TOKEN_INVALID', 'EDGEONE_API_TOKEN缺失或过短');
  }
  if (confirmation !== CONFIRMATION) {
    fail('BOOTSTRAP_CONFIRMATION_INVALID', '一次性初始化确认词不匹配');
  }
  return Object.freeze({ projectId, token });
}

async function executeBootstrap() {
  const { projectId, token } = readExecutionCredentials();
  const publicStore = getStore({ name: PUBLIC_STORE, projectId, token, consistency: 'strong' });
  const adminStore = getStore({ name: ADMIN_STORE, projectId, token, consistency: 'strong' });
  const result = await executeProductionBootstrap({
    publicStore,
    adminStore,
    env: bootstrapEnv(),
  });

  return Object.freeze({
    schemaVersion: 1,
    stage: '8G',
    operation: 'execute',
    status: result.status,
    publicStoreName: PUBLIC_STORE,
    adminStoreName: ADMIN_STORE,
    projectIdSuffix: projectId.slice(-6),
    resourceCount: result.resourceCount,
    createdCount: result.createdCount,
    existingExactCount: result.existingExactCount,
    manifestSha256: result.manifestSha256,
    operations: result.operations,
    realBlobReadsPerformed: result.realBlobReadsPerformed,
    realBlobWritesPerformed: result.realBlobWritesPerformed,
    realBlobDeletesPerformed: result.realBlobDeletesPerformed,
    realSecretValuesExposed: false,
    productionCapabilitiesEnabled: false,
    stablePromotionAuthorized: false,
  });
}

async function main() {
  try {
    const report = process.argv.includes('--execute') ? await executeBootstrap() : buildPlan();
    writeReport(report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    fail(
      error?.code || 'EDGEONE_PRODUCTION_BOOTSTRAP_FAILED',
      sanitizeFailureMessage(error?.message || 'EdgeOne生产初始化失败'),
      1,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
