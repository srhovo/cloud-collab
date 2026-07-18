import { createHash } from 'node:crypto';

export class SubmissionRateLimitError extends Error {
  constructor(code, message, status = 429, details = null, retryable = true, cause = null) {
    super(message || code || '提交频率超过限制');
    this.name = 'SubmissionRateLimitError';
    this.code = code || 'SUBMISSION_RATE_LIMIT_ERROR';
    this.status = status;
    this.details = details;
    this.retryable = Boolean(retryable);
    if (cause) this.cause = cause;
  }
}

function hash(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function positiveInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function prefix(deviceId, window, bucket) {
  return `rate/submission/${window}/${hash(deviceId)}/${bucket}/`;
}

function markerKey(deviceId, window, bucket, idempotencyKey) {
  return `${prefix(deviceId, window, bucket)}${hash(idempotencyKey)}.json`;
}

async function createMarker(store, key, value) {
  try {
    await store.setJSON(key, value, { onlyIfNew: true });
    return true;
  } catch (error) {
    try {
      const existing = await store.get(key, { type: 'json', consistency: 'strong' });
      if (existing) return false;
    } catch (_) {}
    throw new SubmissionRateLimitError('RATE_LIMIT_STORAGE_FAILED', '限流状态暂时无法安全写入', 503, { key }, true, error);
  }
}

async function countPrefix(store, value) {
  try {
    const result = await store.list({ prefix: value, consistency: 'strong' });
    return Array.isArray(result?.blobs) ? result.blobs.length : 0;
  } catch (error) {
    throw new SubmissionRateLimitError('RATE_LIMIT_STORAGE_FAILED', '限流状态暂时无法安全读取', 503, { prefix: value }, true, error);
  }
}

export async function enforceSubmissionRateLimit({
  store,
  deviceId,
  idempotencyKey,
  now = Date.now(),
  minuteLimit = 20,
  hourLimit = 200,
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function' || typeof store.list !== 'function') {
    throw new SubmissionRateLimitError('INVALID_RATE_LIMIT_STORE', '限流存储接口无效', 503, null, true);
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new SubmissionRateLimitError('INVALID_SERVER_TIME', '服务器时间无效', 500, null, true);
  }
  const effectiveMinuteLimit = positiveInt(minuteLimit, 20, 1, 1000);
  const effectiveHourLimit = positiveInt(hourLimit, 200, 1, 10000);
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);
  const value = Object.freeze({ schemaVersion: 1, createdAt: now, idempotencyKeyHash: hash(idempotencyKey) });

  await Promise.all([
    createMarker(store, markerKey(deviceId, 'minute', minuteBucket, idempotencyKey), value),
    createMarker(store, markerKey(deviceId, 'hour', hourBucket, idempotencyKey), value),
  ]);
  const [minuteCount, hourCount] = await Promise.all([
    countPrefix(store, prefix(deviceId, 'minute', minuteBucket)),
    countPrefix(store, prefix(deviceId, 'hour', hourBucket)),
  ]);
  if (minuteCount > effectiveMinuteLimit || hourCount > effectiveHourLimit) {
    throw new SubmissionRateLimitError('RATE_LIMITED', '设备提交频率超过安全上限', 429, {
      minuteCount,
      minuteLimit: effectiveMinuteLimit,
      hourCount,
      hourLimit: effectiveHourLimit,
    }, true);
  }
  return Object.freeze({ minuteCount, hourCount, minuteLimit: effectiveMinuteLimit, hourLimit: effectiveHourLimit });
}
