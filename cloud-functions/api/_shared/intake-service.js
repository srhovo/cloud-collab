import { createHash } from 'node:crypto';
import { canonicalize, normalizeSubmission } from '../../../src/server/submission_policy_v1.js';
import { issueDeviceToken, verifyDeviceToken } from './device-token.js';
import {
  candidateKey,
  deviceProfileKey,
  idempotencyKeyPath,
  rateMarkerKey,
  ratePrefix,
  sha256Hex,
} from './blob-store.js';
import { WriteFoundationError } from './http.js';

const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_NICKNAME_LENGTH = 24;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MINUTE_LIMIT = 20;
const DEFAULT_HOUR_LIMIT = 200;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeNickname(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  let text = String(value);
  try { text = text.normalize('NFKC'); } catch (_) {}
  text = text.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_NICKNAME_LENGTH) {
    throw new WriteFoundationError('INVALID_NICKNAME', `昵称最多${MAX_NICKNAME_LENGTH}个字符`, { status: 400 });
  }
  return text;
}

function normalizeRegistration(value) {
  if (!exactKeys(value, ['schemaVersion', 'deviceId', 'nickname', 'clientContext'])) {
    throw new WriteFoundationError('INVALID_REGISTRATION_FIELDS', '设备注册字段必须严格符合协议', { status: 400 });
  }
  if (value.schemaVersion !== 1 || !DEVICE_ID_PATTERN.test(String(value.deviceId || ''))) {
    throw new WriteFoundationError('INVALID_DEVICE_REGISTRATION', '设备注册协议或deviceId无效', { status: 400 });
  }
  if (!exactKeys(value.clientContext, ['appVersion', 'protocolVersion'])
    || typeof value.clientContext.appVersion !== 'string'
    || value.clientContext.appVersion.length < 3
    || value.clientContext.appVersion.length > 32
    || value.clientContext.protocolVersion !== 1) {
    throw new WriteFoundationError('INVALID_CLIENT_CONTEXT', '设备注册clientContext无效', { status: 400 });
  }
  return Object.freeze({
    schemaVersion: 1,
    deviceId: value.deviceId,
    nickname: normalizeNickname(value.nickname),
    clientContext: Object.freeze({ appVersion: value.clientContext.appVersion, protocolVersion: 1 }),
  });
}

function normalizePositiveInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function tokenResponse(profile, secret) {
  const issued = issueDeviceToken({
    deviceId: profile.deviceId,
    tokenVersion: profile.tokenVersion,
    issuedAt: profile.issuedAt,
    expiresAt: profile.expiresAt,
    tokenId: profile.tokenId,
  }, secret);
  return Object.freeze({
    deviceId: profile.deviceId,
    deviceToken: issued.token,
    issuedAt: profile.issuedAt,
    expiresAt: profile.expiresAt,
    tokenVersion: profile.tokenVersion,
    registrationState: 'registered',
  });
}

export function createDeviceRegistrationService({ repository, secret, now = () => Date.now(), tokenTtlMs = DEFAULT_TOKEN_TTL_MS } = {}) {
  if (!repository) throw new WriteFoundationError('BLOB_STORAGE_UNAVAILABLE', '设备注册存储未配置', { status: 503, retryable: true });
  return Object.freeze({
    async register(raw) {
      const request = normalizeRegistration(raw);
      const timestamp = now();
      const ttl = normalizePositiveInt(tokenTtlMs, DEFAULT_TOKEN_TTL_MS, 60_000, 365 * 24 * 60 * 60 * 1000);
      const profile = Object.freeze({
        schemaVersion: 1,
        deviceId: request.deviceId,
        nickname: request.nickname,
        nicknameTag: request.deviceId.slice(-4),
        status: 'active',
        role: 'normal',
        trusted: false,
        tokenVersion: 1,
        tokenId: createHash('sha256').update(`${request.deviceId}\u0000${timestamp}`).digest('base64url').slice(0, 32),
        issuedAt: timestamp,
        expiresAt: timestamp + ttl,
        createdAt: timestamp,
        lastRegisteredAt: timestamp,
        clientContext: request.clientContext,
      });
      tokenResponse(profile, secret);
      const stored = await repository.createJson(deviceProfileKey(request.deviceId), profile);
      const effective = stored.created ? profile : stored.value;
      if (!effective || effective.deviceId !== request.deviceId || effective.status !== 'active') {
        throw new WriteFoundationError('DEVICE_REGISTRATION_BLOCKED', '设备注册状态不可用', { status: 403 });
      }
      return tokenResponse(effective, secret);
    },
  });
}

function submissionFingerprint(submission) {
  return sha256Hex(canonicalize(submission));
}

async function consumeRate({ repository, deviceId, idempotencyKey, now, minuteLimit, hourLimit }) {
  const timestamp = now();
  const minuteBucket = Math.floor(timestamp / 60_000);
  const hourBucket = Math.floor(timestamp / 3_600_000);
  const marker = { createdAt: timestamp, idempotencyKeyHash: sha256Hex(idempotencyKey) };
  await repository.createJson(rateMarkerKey(deviceId, 'minute', minuteBucket, idempotencyKey), marker);
  await repository.createJson(rateMarkerKey(deviceId, 'hour', hourBucket, idempotencyKey), marker);
  const [minuteEntries, hourEntries] = await Promise.all([
    repository.list(ratePrefix(deviceId, 'minute', minuteBucket)),
    repository.list(ratePrefix(deviceId, 'hour', hourBucket)),
  ]);
  if (minuteEntries.length > minuteLimit || hourEntries.length > hourLimit) {
    throw new WriteFoundationError('RATE_LIMITED', '设备提交频率超过安全上限', {
      status: 429,
      retryable: true,
      details: { minuteCount: minuteEntries.length, minuteLimit, hourCount: hourEntries.length, hourLimit },
    });
  }
}

export function createSubmissionIntakeService({
  repository,
  secret,
  now = () => Date.now(),
  minuteLimit = DEFAULT_MINUTE_LIMIT,
  hourLimit = DEFAULT_HOUR_LIMIT,
} = {}) {
  if (!repository) throw new WriteFoundationError('BLOB_STORAGE_UNAVAILABLE', '提交存储未配置', { status: 503, retryable: true });
  const effectiveMinuteLimit = normalizePositiveInt(minuteLimit, DEFAULT_MINUTE_LIMIT, 1, 1000);
  const effectiveHourLimit = normalizePositiveInt(hourLimit, DEFAULT_HOUR_LIMIT, 1, 10000);

  return Object.freeze({
    async submit(rawSubmission, bearerToken) {
      let submission;
      try { submission = normalizeSubmission(rawSubmission); }
      catch (error) {
        throw new WriteFoundationError(error?.code || 'INVALID_SUBMISSION', error?.message || '提交校验失败', { status: 400, details: error?.details || null });
      }
      const token = verifyDeviceToken(bearerToken, secret, { now: now() });
      if (token.deviceId !== submission.deviceId) {
        throw new WriteFoundationError('DEVICE_TOKEN_MISMATCH', '设备令牌与提交设备不一致', { status: 403 });
      }
      const profile = await repository.getJson(deviceProfileKey(submission.deviceId));
      if (!profile || profile.status !== 'active' || profile.tokenVersion !== token.tokenVersion) {
        throw new WriteFoundationError('DEVICE_NOT_ACTIVE', '设备未注册、已封禁或令牌版本失效', { status: 403 });
      }

      const fingerprint = submissionFingerprint(submission);
      const idemPath = idempotencyKeyPath(submission.idempotencyKey);
      const existing = await repository.getJson(idemPath);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new WriteFoundationError('IDEMPOTENCY_BODY_MISMATCH', '同一幂等键出现不同请求体', { status: 409 });
        }
        if (existing.response) return Object.freeze({ ...existing.response, idempotentReplay: true });
        if (existing.state !== 'failed' || !existing.failure?.retryable) {
          const failure = existing.failure;
          if (failure) throw new WriteFoundationError(failure.code || 'SUBMISSION_REJECTED', '同一提交此前已被拒绝', { status: failure.status || 409, retryable: false });
          throw new WriteFoundationError('SUBMISSION_IN_PROGRESS', '同一提交正在处理，请稍后重试', { status: 409, retryable: true });
        }
      }

      const receivedAt = now();
      const reservation = Object.freeze({ schemaVersion: 1, fingerprint, state: 'processing', receivedAt, response: null });
      const reserved = existing?.state === 'failed' && existing.failure?.retryable
        ? (await repository.putJson(idemPath, reservation), { created: true, value: reservation })
        : await repository.createJson(idemPath, reservation);
      if (!reserved.created) {
        const known = reserved.value;
        if (known?.fingerprint !== fingerprint) {
          throw new WriteFoundationError('IDEMPOTENCY_BODY_MISMATCH', '同一幂等键出现不同请求体', { status: 409 });
        }
        if (known?.response) return Object.freeze({ ...known.response, idempotentReplay: true });
        throw new WriteFoundationError('SUBMISSION_IN_PROGRESS', '同一提交正在处理，请稍后重试', { status: 409, retryable: true });
      }

      try {
        await consumeRate({
          repository,
          deviceId: submission.deviceId,
          idempotencyKey: submission.idempotencyKey,
          now,
          minuteLimit: effectiveMinuteLimit,
          hourLimit: effectiveHourLimit,
        });
        const candidateId = `cand_${sha256Hex(`${submission.deviceId}\u0000${submission.submissionId}`).slice(0, 40)}`;
        const candidate = Object.freeze({
          schemaVersion: 1,
          candidateId,
          state: 'waiting_confirmation',
          submission,
          receivedAt,
          publicMutationAllowed: false,
          autoApprovalEnabled: false,
        });
        await repository.createJson(candidateKey(candidateId), candidate);
        const response = Object.freeze({
          submissionId: submission.submissionId,
          candidateId,
          state: 'waiting_confirmation',
          receivedAt,
          publicMutationAllowed: false,
          autoApprovalEnabled: false,
          idempotentReplay: false,
        });
        await repository.putJson(idemPath, { ...reservation, state: 'completed', response });
        return response;
      } catch (error) {
        const safeError = error instanceof WriteFoundationError
          ? error
          : new WriteFoundationError('SUBMISSION_STORAGE_FAILED', '提交暂时无法安全保存', { status: 503, retryable: true });
        await repository.putJson(idemPath, {
          ...reservation,
          state: 'failed',
          response: null,
          failure: { code: safeError.code, status: safeError.status, retryable: safeError.retryable },
        });
        throw safeError;
      }
    },
  });
}
