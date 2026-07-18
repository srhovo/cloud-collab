(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSubmission = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  class SubmissionClientError extends Error {
    constructor(code, message, { status = 0, retryable = false, details = null } = {}) {
      super(message || code || '云端提交失败');
      this.name = 'SubmissionClientError';
      this.code = code || 'SUBMISSION_CLIENT_ERROR';
      this.status = status;
      this.retryable = Boolean(retryable);
      this.details = details;
    }
  }

  function normalizeBase(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    try {
      const url = new URL(text, typeof location !== 'undefined' ? location.href : 'https://local.invalid');
      if (!/^https?:$/.test(url.protocol)) return '';
      return url.origin === 'https://local.invalid' ? '' : url.href.replace(/\/$/, '');
    } catch (_) { return ''; }
  }

  class SubmissionApiClient {
    constructor({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
      this.baseUrl = normalizeBase(baseUrl) || ((typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) ? location.origin : '');
      this.fetchImpl = fetchImpl;
      this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 10000));
    }

    isConfigured() { return Boolean(this.baseUrl && typeof this.fetchImpl === 'function'); }

    async request(path, { body, token = null } = {}) {
      if (!this.isConfigured()) throw new SubmissionClientError('API_NOT_CONFIGURED', '提交接口尚未配置');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        });
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok || !payload?.ok) {
          const remote = payload?.error || {};
          throw new SubmissionClientError(remote.code || `HTTP_${response.status}`, remote.message || '服务器拒绝提交', {
            status: response.status,
            retryable: Boolean(remote.retryable) || response.status === 408 || response.status === 429 || response.status >= 500,
            details: remote.details || null,
          });
        }
        return payload.data;
      } catch (error) {
        if (error instanceof SubmissionClientError) throw error;
        if (error?.name === 'AbortError') throw new SubmissionClientError('API_TIMEOUT', '提交请求超时', { retryable: true });
        throw new SubmissionClientError('API_UNREACHABLE', '无法连接提交接口', { retryable: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    registerDevice({ deviceId, nickname = null, appVersion = '8.2.28' }) {
      return this.request('/api/v1/device-register', {
        body: { schemaVersion: 1, deviceId, nickname, clientContext: { appVersion } },
      });
    }

    submit(deviceToken, submission) {
      return this.request('/api/v1/submissions', { body: submission, token: deviceToken });
    }
  }

  function shouldRetry(error) {
    return Boolean(error?.retryable)
      || [
        'API_UNREACHABLE', 'API_TIMEOUT', 'WRITE_FOUNDATION_DISABLED',
        'DEVICE_REGISTRATION_DISABLED', 'SUBMISSION_INTAKE_DISABLED',
        'BLOB_STORAGE_UNAVAILABLE', 'BLOB_READ_FAILED', 'BLOB_ONLY_IF_NEW_FAILED',
        'DEVICE_REGISTRATION_STORAGE_FAILED', 'SUBMISSION_STORAGE_FAILED',
        'RATE_LIMIT_STORAGE_FAILED', 'RATE_LIMITED',
      ].includes(error?.code)
      || error?.status === 408
      || error?.status === 429
      || error?.status >= 500;
  }

  class SubmissionDispatcher {
    constructor({ apiClient, metaStore, credentialStore, queueStore, appVersion = '8.2.28', now = () => Date.now() } = {}) {
      this.apiClient = apiClient;
      this.metaStore = metaStore;
      this.credentialStore = credentialStore;
      this.queueStore = queueStore;
      this.appVersion = appVersion;
      this.now = now;
      this._flushPromise = null;
    }

    async ensureCredential() {
      const current = this.credentialStore?.getValid?.(this.now());
      if (current) return current;
      const metaResult = this.metaStore?.loadResult?.();
      if (!metaResult?.ok || !metaResult?.exists || !metaResult.value?.deviceId) {
        throw new SubmissionClientError('DEVICE_IDENTITY_REQUIRED', '请先创建云协作身份');
      }
      const data = await this.apiClient.registerDevice({
        deviceId: metaResult.value.deviceId,
        nickname: metaResult.value.nickname,
        appVersion: this.appVersion,
      });
      return this.credentialStore.save({
        schemaVersion: 1,
        deviceId: data.deviceId,
        deviceToken: data.deviceToken,
        issuedAt: data.issuedAt,
        expiresAt: data.expiresAt,
        tokenVersion: data.tokenVersion,
      });
    }

    flush({ limit = 10 } = {}) {
      if (this._flushPromise) return this._flushPromise;
      this._flushPromise = this._flush({ limit }).finally(() => { this._flushPromise = null; });
      return this._flushPromise;
    }

    async _flush({ limit }) {
      if (!this.apiClient?.isConfigured?.()) return { status: 'not_configured', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0 };
      const due = this.queueStore.getDue(this.now(), Math.max(1, Math.min(20, Number(limit) || 10)));
      if (!due.length) return { status: 'idle', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0 };
      let credential;
      try { credential = await this.ensureCredential(); }
      catch (error) {
        if (shouldRetry(error)) return { status: 'credential_retry', attempted: 0, acknowledged: 0, retryWait: due.length, blocked: 0, errorCode: error.code };
        due.forEach(item => this.queueStore.markBlocked(item.submission.submissionId, error.code || 'CREDENTIAL_BLOCKED'));
        return { status: 'credential_blocked', attempted: 0, acknowledged: 0, retryWait: 0, blocked: due.length, errorCode: error.code };
      }

      const result = { status: 'completed', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0 };
      for (const item of due) {
        const id = item.submission.submissionId;
        this.queueStore.markSending(id);
        result.attempted += 1;
        try {
          await this.apiClient.submit(credential.deviceToken, item.submission);
          this.queueStore.markAcknowledged(id);
          result.acknowledged += 1;
        } catch (error) {
          if (shouldRetry(error)) {
            this.queueStore.markRetry(id, error.code || 'SUBMISSION_RETRY');
            result.retryWait += 1;
          } else {
            this.queueStore.markBlocked(id, error.code || 'SUBMISSION_BLOCKED');
            result.blocked += 1;
          }
        }
      }
      return result;
    }
  }

  return Object.freeze({ SubmissionClientError, SubmissionApiClient, SubmissionDispatcher, shouldRetry });
});
