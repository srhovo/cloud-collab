import {
  assertProductionScopeMapping,
  buildProductionScopeMapping,
} from './production_scope_mapping_v1.js';

export const PRODUCTION_RUNTIME_CONFIG_VERSION = 1;
export const PRODUCTION_PUBLIC_STORE_NAME = 'cloud-collab-production-v1';
export const PRODUCTION_ADMIN_STORE_NAME = 'cloud-collab-admin-production-v1';
export const PRODUCTION_BOOTSTRAP_CONFIRMATION = 'INITIALIZE-see-see_cz-V1';

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

export class ProductionRuntimeConfigError extends Error {
  constructor(code, message, details = null) {
    super(message || code || '生产运行时配置无效');
    this.name = 'ProductionRuntimeConfigError';
    this.code = code || 'PRODUCTION_RUNTIME_CONFIG_ERROR';
    this.status = 503;
    this.details = details;
  }
}

function readFlag(env, name) {
  const raw = String(env?.[name] ?? '').trim();
  if (raw !== '0' && raw !== '1') {
    throw new ProductionRuntimeConfigError('PRODUCTION_FLAG_INVALID', `${name}必须明确为0或1`, { name });
  }
  return raw === '1';
}

function readCompatibleFlag(env, name) {
  const raw = String(env?.[name] ?? '0').trim();
  if (raw !== '0' && raw !== '1') {
    throw new ProductionRuntimeConfigError('PRODUCTION_FLAG_INVALID', `${name}必须明确为0或1`, { name });
  }
  return raw === '1';
}

function secretBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function readSecret(env, name, { required }) {
  const value = String(env?.[name] || '');
  if (!required && !value) return '';
  const bytes = secretBytes(value);
  if (bytes < 32 || bytes > 256) {
    throw new ProductionRuntimeConfigError('PRODUCTION_SECRET_INVALID', `${name}必须为32至256字节`, { name, bytes });
  }
  return value;
}

function readHttpsOrigin(value, name, { required }) {
  const raw = String(value || '').trim();
  if (!required && !raw) return '';
  let url;
  try { url = new URL(raw); }
  catch (_) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ORIGIN_INVALID', `${name}必须为纯HTTPS来源`, { name });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || !url.hostname) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ORIGIN_INVALID', `${name}必须为纯HTTPS来源`, { name });
  }
  return url.origin;
}

function assertDependencies(flags) {
  const childEnabled = flags.readSync || flags.ordinarySubmission || flags.autoApproval
    || flags.sensitiveSubmission || flags.adminReview || flags.deviceGovernance
    || flags.rollback || flags.admin;
  if (!flags.production && childEnabled) {
    throw new ProductionRuntimeConfigError(
      'PRODUCTION_MASTER_GATE_CLOSED',
      '总开关关闭时不得开启任何生产能力',
    );
  }
  if (flags.ordinarySubmission && !flags.readSync) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '普通提交必须在只读同步之后开启');
  }
  if (flags.autoApproval && (!flags.readSync || !flags.ordinarySubmission)) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '普通自动审核必须在只读同步和普通提交之后开启');
  }
  if (flags.adminReview && (!flags.readSync || !flags.admin)) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '管理员审核必须同时具备只读同步和管理员身份能力');
  }
  if (flags.deviceGovernance && !flags.admin) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '设备治理必须先开启管理员身份能力');
  }
  if (flags.rollback && (!flags.readSync || !flags.admin)) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '公共数据回滚必须同时具备只读同步和管理员身份能力');
  }
  if (flags.sensitiveSubmission && (!flags.readSync || !flags.adminReview || !flags.admin)) {
    throw new ProductionRuntimeConfigError('PRODUCTION_ROLLOUT_ORDER_INVALID', '敏感提交必须在管理员人工审核已就绪后开启');
  }
}

function assertBootstrapIsolation(flags, confirmation) {
  if (!flags.bootstrap) return;
  if (flags.production || flags.readSync || flags.ordinarySubmission || flags.autoApproval
      || flags.sensitiveSubmission || flags.adminReview || flags.deviceGovernance
      || flags.rollback || flags.admin) {
    throw new ProductionRuntimeConfigError(
      'PRODUCTION_BOOTSTRAP_NOT_ISOLATED',
      '一次性初始化只能在全部生产能力关闭时执行',
    );
  }
  if (confirmation !== PRODUCTION_BOOTSTRAP_CONFIRMATION) {
    throw new ProductionRuntimeConfigError(
      'PRODUCTION_BOOTSTRAP_CONFIRMATION_INVALID',
      '一次性初始化确认词无效',
    );
  }
}

function readScope(env) {
  const mapping = buildProductionScopeMapping({
    clubId: env?.CLOUD_PRODUCTION_EXTERNAL_CLUB_ID,
    libraryId: env?.CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID,
  });
  const configured = {
    schemaVersion: 1,
    external: mapping.external,
    protocol: {
      groupId: String(env?.CLOUD_PRODUCTION_GROUP_ID || '').trim().toLowerCase(),
      libraryId: String(env?.CLOUD_PRODUCTION_LIBRARY_ID || '').trim().toLowerCase(),
    },
  };
  return assertProductionScopeMapping(configured);
}

export function readProductionRuntimeConfig(env = {}) {
  const flags = Object.freeze({
    production: readFlag(env, 'CLOUD_PRODUCTION_ENABLED'),
    readSync: readFlag(env, 'CLOUD_PRODUCTION_READ_SYNC_ENABLED'),
    ordinarySubmission: readFlag(env, 'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED'),
    autoApproval: readFlag(env, 'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED'),
    sensitiveSubmission: readFlag(env, 'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED'),
    adminReview: readFlag(env, 'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED'),
    deviceGovernance: readCompatibleFlag(env, 'CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED'),
    rollback: readCompatibleFlag(env, 'CLOUD_PRODUCTION_ROLLBACK_ENABLED'),
    admin: readFlag(env, 'CLOUD_ADMIN_PRODUCTION_ENABLED'),
    bootstrap: readFlag(env, 'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED'),
  });
  assertDependencies(flags);
  const bootstrapConfirmation = String(env.CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION || '').trim();
  assertBootstrapIsolation(flags, bootstrapConfirmation);

  const scope = readScope(env);
  const publicStoreName = String(env.CLOUD_PRODUCTION_BLOB_STORE_NAME || '').trim();
  const adminStoreName = String(env.CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME || '').trim();
  if (publicStoreName !== PRODUCTION_PUBLIC_STORE_NAME || adminStoreName !== PRODUCTION_ADMIN_STORE_NAME
      || publicStoreName === adminStoreName) {
    throw new ProductionRuntimeConfigError('PRODUCTION_STORE_INVALID', '生产公共Blob和管理员Blob必须使用固定且相互隔离的命名空间');
  }

  const runtimeEnabled = flags.production || flags.bootstrap;
  const publicOrigin = readHttpsOrigin(env.CLOUD_PRODUCTION_PUBLIC_ORIGIN, 'CLOUD_PRODUCTION_PUBLIC_ORIGIN', {
    required: flags.production,
  });
  const adminOrigin = readHttpsOrigin(env.CLOUD_ADMIN_PUBLIC_ORIGIN, 'CLOUD_ADMIN_PUBLIC_ORIGIN', {
    required: flags.admin,
  });
  const adminUsername = String(env.CLOUD_ADMIN_USERNAME || '').trim().toLowerCase();
  if ((flags.admin || flags.bootstrap) && adminUsername !== 'xiaxue') {
    throw new ProductionRuntimeConfigError('PRODUCTION_ADMIN_USERNAME_INVALID', '正式管理员用户名必须为xiaxue');
  }

  const requiredSecrets = Object.freeze({
    CLOUD_ADMIN_PASSWORD: flags.admin,
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: flags.production,
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: flags.production,
    CLOUD_ADMIN_SESSION_SECRET: flags.admin,
    CLOUD_ADMIN_RATE_LIMIT_SALT: flags.admin,
    CLOUD_ADMIN_DEVICE_REF_SALT: flags.adminReview || flags.deviceGovernance,
    CLOUD_ADMIN_ROLLBACK_REF_SALT: flags.rollback,
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: flags.adminReview,
  });
  const secrets = {};
  for (const name of SECRET_NAMES) {
    secrets[name] = readSecret(env, name, { required: requiredSecrets[name] === true });
  }
  const configuredSecrets = Object.values(secrets).filter(Boolean);
  if (new Set(configuredSecrets).size !== configuredSecrets.length) {
    throw new ProductionRuntimeConfigError('PRODUCTION_SECRETS_MUST_BE_DISTINCT', '所有已配置生产密钥必须彼此不同');
  }

  return Object.freeze({
    schemaVersion: PRODUCTION_RUNTIME_CONFIG_VERSION,
    mode: flags.bootstrap ? 'bootstrap' : (flags.production ? 'production' : 'disabled'),
    flags,
    scope,
    publicStoreName,
    adminStoreName,
    publicOrigin,
    adminOrigin,
    adminUsername,
    bootstrapConfirmation,
    secrets: Object.freeze(secrets),
    runtimeEnabled,
    stablePromotionAuthorized: false,
  });
}

export function projectProductionRuntimeStatus(config) {
  return Object.freeze({
    schemaVersion: PRODUCTION_RUNTIME_CONFIG_VERSION,
    mode: config?.mode || 'invalid',
    flags: Object.freeze({ ...(config?.flags || {}) }),
    externalScope: Object.freeze({ ...(config?.scope?.external || {}) }),
    protocolScope: Object.freeze({ ...(config?.scope?.protocol || {}) }),
    publicStoreName: config?.publicStoreName || null,
    adminStoreName: config?.adminStoreName || null,
    publicOriginReady: Boolean(config?.publicOrigin),
    adminOriginReady: Boolean(config?.adminOrigin),
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  });
}
