(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabReadonly = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const CLIENT_PROTOCOL_VERSION = 1;
  const MAX_RESPONSE_BYTES = 65536;
  const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{2,47}$/;
  const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_-]{2,53}$/;

  class ReadonlyApiError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '只读接口请求失败');
      this.name = 'ReadonlyApiError';
      this.code = code || 'READONLY_API_ERROR';
      this.details = details;
    }
  }

  function normalizeBaseUrl(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    let url;
    try { url = new URL(text); }
    catch (_) { throw new ReadonlyApiError('INVALID_API_BASE', '只读接口地址不是有效URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ReadonlyApiError('INVALID_API_BASE', '只读接口仅允许HTTP或HTTPS地址');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ReadonlyApiError('INVALID_API_BASE', '只读接口地址不能包含账号、查询参数或片段');
    }
    return url.href.replace(/\/+$/, '');
  }

  function resolveApiBase({ documentRef, locationRef } = {}) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    const loc = locationRef || (typeof location !== 'undefined' ? location : null);
    const configured = doc?.querySelector?.('meta[name="cloud-collab-api-base"]')?.getAttribute('content') || '';
    if (String(configured).trim()) return normalizeBaseUrl(configured);
    if (loc && ['http:', 'https:'].includes(String(loc.protocol || ''))) {
      return normalizeBaseUrl(loc.origin);
    }
    return '';
  }

  function assertEnvelope(body, response) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
      throw new ReadonlyApiError('INVALID_API_RESPONSE', '服务器返回格式无效', { status: response.status });
    }
    if (!response.ok || body.ok === false) {
      throw new ReadonlyApiError(
        body?.error?.code || `HTTP_${response.status}`,
        body?.error?.message || `服务器返回HTTP ${response.status}`,
        body?.error?.details || null,
      );
    }
    if (body.serviceId !== 'cloud-collab-readonly' || !body.data || typeof body.data !== 'object') {
      throw new ReadonlyApiError('INVALID_API_RESPONSE', '服务器身份或数据结构无效');
    }
    return body.data;
  }

  class CloudCollabReadonlyApi {
    constructor({ baseUrl = '', timeoutMs = 3500, fetchImpl = null } = {}) {
      this.baseUrl = normalizeBaseUrl(baseUrl);
      this.timeoutMs = Math.max(500, Math.min(15000, Number(timeoutMs) || 3500));
      this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    }

    isConfigured() { return Boolean(this.baseUrl && this.fetchImpl); }

    async request(path, query = null) {
      if (!this.baseUrl) throw new ReadonlyApiError('API_NOT_CONFIGURED', '只读测试接口尚未配置');
      if (!this.fetchImpl) throw new ReadonlyApiError('FETCH_UNAVAILABLE', '当前环境不支持网络请求');
      const url = new URL(path, `${this.baseUrl}/`);
      if (query) Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        const response = await this.fetchImpl(url.href, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller?.signal,
        });
        const length = Number(response.headers?.get?.('content-length') || 0);
        if (length > MAX_RESPONSE_BYTES) throw new ReadonlyApiError('RESPONSE_TOO_LARGE', '服务器响应超过64KB限制');
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
          throw new ReadonlyApiError('RESPONSE_TOO_LARGE', '服务器响应超过64KB限制');
        }
        let body;
        try { body = JSON.parse(text); }
        catch (_) { throw new ReadonlyApiError('INVALID_API_JSON', '服务器返回的不是有效JSON'); }
        return assertEnvelope(body, response);
      } catch (error) {
        if (error instanceof ReadonlyApiError) throw error;
        if (error?.name === 'AbortError') throw new ReadonlyApiError('API_TIMEOUT', '只读接口请求超时');
        throw new ReadonlyApiError('API_UNREACHABLE', '无法连接只读测试接口', { cause: String(error?.message || error) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    health() { return this.request('/api/health'); }
    protocol() { return this.request('/api/protocol'); }

    publicVersion(groupId, libraryId) {
      const group = String(groupId || '').trim().toLowerCase();
      const library = String(libraryId || '').trim().toLowerCase();
      if (!GROUP_ID_PATTERN.test(group) || !LIBRARY_ID_PATTERN.test(library)) {
        throw new ReadonlyApiError('INVALID_PUBLIC_SCOPE', 'groupId 或 libraryId 格式无效');
      }
      return this.request('/api/public-version', { groupId: group, libraryId: library });
    }
  }

  function createConfiguredClient(options = {}) {
    const baseUrl = options.baseUrl === undefined
      ? resolveApiBase({ documentRef: options.documentRef, locationRef: options.locationRef })
      : normalizeBaseUrl(options.baseUrl);
    return new CloudCollabReadonlyApi({
      baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  return Object.freeze({
    CLIENT_PROTOCOL_VERSION,
    ReadonlyApiError,
    CloudCollabReadonlyApi,
    normalizeBaseUrl,
    resolveApiBase,
    createConfiguredClient,
  });
});
