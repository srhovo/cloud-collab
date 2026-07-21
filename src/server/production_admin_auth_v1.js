import {
  AdminAuthError,
  ADMIN_LOGIN_RATE_SLOT_MS,
  ADMIN_SESSION_RATE_SLOT_MS,
  authenticateAdminCredentials,
  consumeAdminLoginRateLimit,
  consumeAdminSessionRateLimit,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_ADMIN_AUTH_VERSION = 1;

export class ProductionAdminAuthError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式管理员身份验证失败');
    this.name = 'ProductionAdminAuthError';
    this.code = code || 'PRODUCTION_ADMIN_AUTH_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function mapAdminError(error) {
  if (error instanceof ProductionAdminAuthError) return error;
  if (error instanceof ProductionRuntimeConfigError) {
    return new ProductionAdminAuthError(error.code, error.message, 503, error.details, error);
  }
  if (error instanceof AdminAuthError) {
    return new ProductionAdminAuthError(error.code, error.message, error.status, error.details, error);
  }
  return error;
}

export function readProductionAdminAuthConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) { throw mapAdminError(error); }
  const flags = runtime.flags;
  if (runtime.mode !== 'production' || flags.production !== true || flags.readSync !== true
      || flags.admin !== true || flags.adminReview !== true) {
    throw new ProductionAdminAuthError('PRODUCTION_ADMIN_DISABLED', '正式管理员身份或人工审核尚未开启', 503);
  }
  if (!runtime.adminOrigin || !runtime.adminUsername) {
    throw new ProductionAdminAuthError('PRODUCTION_ADMIN_ORIGIN_INVALID', '正式管理员HTTPS来源尚未配置', 503);
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_AUTH_VERSION,
    enabled: true,
    username: runtime.adminUsername,
    password: runtime.secrets.CLOUD_ADMIN_PASSWORD,
    sessionSecret: runtime.secrets.CLOUD_ADMIN_SESSION_SECRET,
    rateLimitSalt: runtime.secrets.CLOUD_ADMIN_RATE_LIMIT_SALT,
    storeName: runtime.adminStoreName,
    publicStoreName: runtime.publicStoreName,
    publicOrigin: runtime.adminOrigin,
    loginRateSlotMs: ADMIN_LOGIN_RATE_SLOT_MS,
    sessionRateSlotMs: ADMIN_SESSION_RATE_SLOT_MS,
    capabilities: Object.freeze({
      reviewQueueRead: true,
      reviewMutation: true,
      sensitiveReview: true,
      deviceMutation: false,
      rollback: false,
      export: false,
      publicMutationAllowed: true,
      stablePromotionAuthorized: false,
    }),
  });
}

export function authenticateProductionAdminCredentials(input, config) {
  try { return authenticateAdminCredentials(input, config); }
  catch (error) { throw mapAdminError(error); }
}

export function createProductionAdminSessionToken(input, config) {
  try { return createAdminSessionToken(input, config); }
  catch (error) { throw mapAdminError(error); }
}

export function verifyProductionAdminSessionToken(token, config, now = Date.now()) {
  try { return verifyAdminSessionToken(token, config, now); }
  catch (error) { throw mapAdminError(error); }
}

export async function consumeProductionAdminLoginRateLimit(input) {
  try { return await consumeAdminLoginRateLimit(input); }
  catch (error) { throw mapAdminError(error); }
}

export async function consumeProductionAdminSessionRateLimit(input) {
  try { return await consumeAdminSessionRateLimit(input); }
  catch (error) { throw mapAdminError(error); }
}

export function projectProductionAdminSession(session, config) {
  return Object.freeze({
    authenticated: true,
    username: session.username,
    expiresAt: session.expiresAt,
    sessionIdSuffix: session.sessionIdSuffix,
    capabilities: config.capabilities,
    stablePromotionAuthorized: false,
  });
}
