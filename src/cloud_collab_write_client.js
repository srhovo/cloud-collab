(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabWriteClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const CLIENT_VERSION = '8.2.28';
  const REGISTER_PATH = '/api/device/register';
  const SUBMIT_PATH = '/api/submissions/create';
  const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
  const DEVICE_TOKEN_PATTERN = /^dt_v1_[A-Za-z0-9_-]{43}$/;

  class WriteClientError extends Error {
    constructor(code, message, options = {}) {
      super(message || code || '云端提交请求失败');
      this.name = 'WriteClientError';
      this.code = code || 'WRITE_CLIENT_ERROR';
      this.status = Number.isInteger(options.status) ? options.status : 0;
      this.category = options.category || 'client';
      this.retryable = options.retryable === true;
      this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? Math.max(0, Math.round(options.retryAfterMs)) : 0;
      this.details = options.details || null;
      if (options.cause) this.cause = options.cause;
    }
  }

  function normalizeBase(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.href.replace(/\/$/, '');
    } catch (_) {
      return '';
    }
  }

  function readMeta(documentRef, name) {
    return String(documentRef?.querySelector?.(`meta[name="${name}"]`)?.getAttribute?.('content') || '').trim();
  }

  function resolveApiBase({ documentRef, locationRef } = {}) {
    const configured = normalizeBase(readMeta(documentRef, 'cloud-collab-api-base'));
    if (configured) return configured;
    const protocol = String(locationRef?.protocol || '').toLowerCase();
    return ['http:', 'https:'].includes(protocol) ? normalizeBase(locationRef.origin) : '';
  }

  function readWriteEnabled(documentRef) {
    return readMeta(documentRef, 'cloud-collab-write-enabled') === '1';
  }

  function parseRetryAfter(headers, now = Date.now()) {
    const raw = String(headers?.get?.('retry-after') || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Math.min(24 * 60 * 60 * 1000, Number(raw) * 1000);
    const time = Date.parse(raw);
    return Number.isFinite(time) ? Math.min(24 * 60 * 60 * 1000, Math.max(0, time - now)) : 0;
  }

  function classifyFailure({ status = 0, code = '', message = '', retryAfterMs = 0, cause = null } = {}) {
    const normalizedCode = String(code || '').trim() || (status ? `HTTP_${status}` : 'NETWORK_ERROR');
    if (normalizedCode === 'WRITE_CLIENT_DISABLED' || normalizedCode === 'WRITE_API_NOT_CONFIGURED') {
      return new WriteClientError(normalizedCode, message || '客户端上传能力未启用', { status, category: 'disabled', retryable: false, cause });
    }
    if (normalizedCode === 'PREVIEW_WRITE_DISABLED') {
      return new WriteClientError(normalizedCode, message || '服务器写入能力未开启', { status: status || 503, category: 'write_disabled', retryable: false, cause });
    }
    if (status === 0) {
      return new WriteClientError(normalizedCode, message || '网络连接失败', { status: 0, category: 'network', retryable: true, cause });
    }
    if (status === 429) {
      return new WriteClientError(normalizedCode, message || '请求过于频繁', { status, category: 'rate_limited', retryable: true, retryAfterMs, cause });
    }
    if (status === 401) {
      return new WriteClientError(normalizedCode, message || '设备凭据无效或已过期', { status, category: 'credential_invalid', retryable: false, cause });
    }
    if (status === 403) {
      return new WriteClientError(normalizedCode, message || '当前设备或作用域无权提交', { status, category: 'forbidden', retryable: false, cause });
    }
    if (status === 409) {
      return new WriteClientError(normalizedCode, message || '提交发生幂等或设备冲突', { status, category: 'conflict', retryable: false, cause });
    }
    if (status >= 500) {
      return new WriteClientError(normalizedCode, message || '云端服务暂时不可用', { status, category: 'server', retryable: true, retryAfterMs, cause });
    }
    if (status >= 400) {
      return new WriteClientError(normalizedCode, message || '提交内容未通过服务端校验', { status, category: 'invalid_request', retryable: false, cause });
    }
    return new WriteClientError(normalizedCode, message || '云端提交响应无效', { status, category: 'protocol', retryable: false, cause });
  }

  function assertCredential(value, expectedDeviceId = '') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw classifyFailure({ status: 0, code: 'DEVICE_CREDENTIAL_MISSING', message: '本地没有可用设备凭据' });
    const deviceId = String(value.deviceId || '');
    const deviceToken = String(value.deviceToken || '');
    if (!DEVICE_ID_PATTERN.test(deviceId) || !DEVICE_TOKEN_PATTERN.test(deviceToken)) {
      throw classifyFailure({ status: 401, code: 'INVALID_LOCAL_DEVICE_CREDENTIAL', message: '本地设备凭据格式无效' });
    }
    if (expectedDeviceId && deviceId !== expectedDeviceId) {
      throw classifyFailure({ status: 401, code: 'LOCAL_DEVICE_SCOPE_MISMATCH', message: '本地设备凭据与当前deviceId不一致' });
    }
    return value;
  }

  class CloudWriteApiClient {
    constructor({ apiBase = '', writeEnabled = false, timeoutMs = 5000, fetchImpl = null, now = () => Date.now() } = {}) {
      this.apiBase = normalizeBase(apiBase);
      this.writeEnabled = writeEnabled === true;
      this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 5000));
      this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this.now = now;
    }

    isConfigured() { return Boolean(this.apiBase && this.fetchImpl); }
    isWriteEnabled() { return this.writeEnabled && this.isConfigured(); }

    assertEnabled() {
      if (!this.writeEnabled) throw classifyFailure({ code: 'WRITE_CLIENT_DISABLED', message: '8.2.28上传能力默认关闭，未发送网络请求' });
      if (!this.isConfigured()) throw classifyFailure({ code: 'WRITE_API_NOT_CONFIGURED', message: '当前页面未配置上传API，未发送网络请求' });
    }

    async request(path, { body, deviceToken = '' } = {}) {
      this.assertEnabled();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;
      try {
        const response = await this.fetchImpl(`${this.apiBase}${path}`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok || payload?.ok !== true) {
          throw classifyFailure({
            status: response.status,
            code: payload?.error?.code || `HTTP_${response.status}`,
            message: payload?.error?.message || `云端返回HTTP ${response.status}`,
            retryAfterMs: parseRetryAfter(response.headers, this.now()),
          });
        }
        if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
          throw classifyFailure({ status: response.status, code: 'INVALID_WRITE_RESPONSE', message: '云端响应缺少有效data对象' });
        }
        return payload.data;
      } catch (error) {
        if (error instanceof WriteClientError) throw error;
        const timeout = error?.name === 'AbortError';
        throw classifyFailure({ code: timeout ? 'API_TIMEOUT' : 'API_UNREACHABLE', message: timeout ? '云端请求超时' : '无法连接云端提交接口', cause: error });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async registerDevice({ meta, credentialStore } = {}) {
      this.assertEnabled();
      const deviceId = String(meta?.deviceId || '');
      if (!DEVICE_ID_PATTERN.test(deviceId)) throw classifyFailure({ status: 400, code: 'INVALID_DEVICE_ID', message: '当前deviceId格式无效' });
      const data = await this.request(REGISTER_PATH, {
        body: {
          schemaVersion: 1,
          deviceId,
          nickname: meta?.nickname || null,
          clientContext: { appVersion: CLIENT_VERSION },
        },
      });
      const credential = {
        schemaVersion: 1,
        deviceId: String(data.deviceId || ''),
        deviceToken: String(data.deviceToken || ''),
        issuedAt: Number(data.issuedAt),
        expiresAt: data.expiresAt === null || data.expiresAt === undefined ? null : Number(data.expiresAt),
        tokenVersion: Number(data.tokenVersion) || 1,
      };
      assertCredential(credential, deviceId);
      if (!Number.isSafeInteger(credential.issuedAt) || credential.issuedAt <= 0
          || (credential.expiresAt !== null && (!Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= credential.issuedAt))) {
        throw classifyFailure({ status: 0, code: 'INVALID_REGISTRATION_RESPONSE', message: '设备注册响应时间字段无效' });
      }
      if (!credentialStore || typeof credentialStore.save !== 'function') {
        throw classifyFailure({ status: 0, code: 'CREDENTIAL_STORE_UNAVAILABLE', message: '本地专用凭据区不可用' });
      }
      credentialStore.save(credential);
      return credentialStore.getRedacted?.() || { deviceId, tokenPresent: true, issuedAt: credential.issuedAt, expiresAt: credential.expiresAt, tokenVersion: credential.tokenVersion };
    }

    async submit({ submission, credential } = {}) {
      const checked = assertCredential(credential, String(submission?.deviceId || ''));
      return this.request(SUBMIT_PATH, { body: submission, deviceToken: checked.deviceToken });
    }
  }

  function createConfiguredClient({ documentRef = typeof document !== 'undefined' ? document : null, locationRef = typeof location !== 'undefined' ? location : null, timeoutMs = 5000, fetchImpl = null, now } = {}) {
    return new CloudWriteApiClient({
      apiBase: resolveApiBase({ documentRef, locationRef }),
      writeEnabled: readWriteEnabled(documentRef),
      timeoutMs,
      fetchImpl,
      now,
    });
  }

  return Object.freeze({
    CLIENT_VERSION,
    REGISTER_PATH,
    SUBMIT_PATH,
    WriteClientError,
    CloudWriteApiClient,
    classifyFailure,
    assertCredential,
    createConfiguredClient,
  });
});
