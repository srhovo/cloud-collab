(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSubmission = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const APP_VERSION = '8.2.28';
  const SUBMISSION_SCHEMA_VERSION = 1;
  const PAYLOAD_SCHEMA_VERSION = 1;
  const PROJECTION_SPEC_VERSION = 1;
  const QUEUE_SCHEMA_VERSION = 1;
  const MAX_FLUSH_LIMIT = 20;
  const PREVIEW_KEY_HEADER = 'X-Cloud-Collab-Preview-Key';

  class SubmissionClientError extends Error {
    constructor(code, message, { status = 0, retryable = false, category = 'unknown', retryAfterMs = 0, details = null, cause = null } = {}) {
      super(message || code || '云端提交失败');
      this.name = 'SubmissionClientError';
      this.code = code || 'SUBMISSION_CLIENT_ERROR';
      this.status = Number(status) || 0;
      this.retryable = Boolean(retryable);
      this.category = category || 'unknown';
      this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
      this.details = details;
      if (cause) this.cause = cause;
    }
  }

  function normalizeBase(value, locationRef = typeof location !== 'undefined' ? location : null) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    try {
      const fallback = locationRef?.href || 'https://local.invalid/';
      const url = new URL(text, fallback);
      if (!/^https?:$/.test(url.protocol)) return '';
      if (url.origin === 'https://local.invalid') return '';
      return url.href.replace(/\/$/, '');
    } catch (_) { return ''; }
  }

  function readConfiguredBase({ documentRef = typeof document !== 'undefined' ? document : null, locationRef = typeof location !== 'undefined' ? location : null } = {}) {
    const configured = documentRef?.querySelector?.('meta[name="cloud-collab-api-base"]')?.getAttribute?.('content') || '';
    const explicit = normalizeBase(configured, locationRef);
    if (explicit) return explicit;
    return locationRef && /^https?:$/.test(locationRef.protocol) ? locationRef.origin : '';
  }

  function parseRetryAfter(response) {
    const raw = String(response?.headers?.get?.('retry-after') || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Math.min(60 * 60 * 1000, Number(raw) * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, Math.min(60 * 60 * 1000, at - Date.now())) : 0;
  }

  function classifyRemoteError(code, status, remoteRetryable = false) {
    const value = String(code || '');
    if (status === 401 || ['DEVICE_AUTH_REQUIRED', 'INVALID_DEVICE_TOKEN', 'DEVICE_TOKEN_NOT_FOUND', 'DEVICE_TOKEN_EXPIRED', 'DEVICE_PROFILE_MISMATCH'].includes(value)) {
      return { category: 'credential', retryable: false };
    }
    if (status === 403 || ['PREVIEW_ACCESS_DENIED', 'PREVIEW_SCOPE_FORBIDDEN', 'DEVICE_SCOPE_MISMATCH'].includes(value)) {
      return { category: value === 'PREVIEW_ACCESS_DENIED' ? 'preview_access' : 'forbidden', retryable: false };
    }
    if (status === 409 || ['IDEMPOTENCY_CONFLICT', 'DEVICE_ALREADY_REGISTERED'].includes(value)) {
      return { category: value === 'DEVICE_ALREADY_REGISTERED' ? 'credential_recovery' : 'conflict', retryable: false };
    }
    if (status === 408 || status === 429 || status >= 500 || remoteRetryable) {
      return { category: status === 429 ? 'rate_limit' : 'transient', retryable: true };
    }
    if (value === 'PREVIEW_WRITE_DISABLED' || value === 'BLOB_STORE_NOT_CONFIGURED') {
      return { category: 'service_disabled', retryable: true };
    }
    return { category: status >= 400 && status < 500 ? 'validation' : 'unknown', retryable: false };
  }

  class SubmissionApiClient {
    constructor({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 10000, previewAccessKeyProvider = null, locationRef = typeof location !== 'undefined' ? location : null } = {}) {
      this.baseUrl = normalizeBase(baseUrl, locationRef) || (locationRef && /^https?:$/.test(locationRef.protocol) ? locationRef.origin : '');
      this.fetchImpl = fetchImpl;
      this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 10000));
      this.previewAccessKeyProvider = typeof previewAccessKeyProvider === 'function' ? previewAccessKeyProvider : () => '';
    }

    isConfigured() { return Boolean(this.baseUrl && typeof this.fetchImpl === 'function'); }
    hasPreviewAccess() { return Boolean(String(this.previewAccessKeyProvider() || '').trim()); }

    async request(path, { body, token = null } = {}) {
      if (!this.isConfigured()) throw new SubmissionClientError('API_NOT_CONFIGURED', '提交接口尚未配置', { category: 'configuration' });
      const previewKey = String(this.previewAccessKeyProvider() || '');
      if (!previewKey) throw new SubmissionClientError('PREVIEW_ACCESS_REQUIRED', '当前会话尚未提供预览访问凭据', { category: 'preview_access' });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', [PREVIEW_KEY_HEADER]: previewKey };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          headers,
          body: JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        });
        let payload = null;
        try { payload = await response.json(); } catch (_) {}
        if (!response.ok || !payload?.ok) {
          const remote = payload?.error || {};
          const code = remote.code || `HTTP_${response.status}`;
          const classified = classifyRemoteError(code, response.status, Boolean(remote.retryable));
          throw new SubmissionClientError(code, remote.message || '服务器拒绝提交', {
            status: response.status,
            retryable: classified.retryable,
            category: classified.category,
            retryAfterMs: parseRetryAfter(response),
            details: remote.details || null,
          });
        }
        const data = payload.data;
        if (data?.publicMutationAllowed === true || data?.autoApprovalEnabled === true) {
          throw new SubmissionClientError('UNSAFE_SERVER_CAPABILITY', '服务器返回了当前阶段禁止的公共写入能力', { category: 'protocol' });
        }
        return data;
      } catch (error) {
        if (error instanceof SubmissionClientError) throw error;
        if (error?.name === 'AbortError') throw new SubmissionClientError('API_TIMEOUT', '提交请求超时', { retryable: true, category: 'network', cause: error });
        throw new SubmissionClientError('API_UNREACHABLE', '无法连接提交接口', { retryable: true, category: 'network', cause: error });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    registerDevice({ deviceId, nickname = null, appVersion = APP_VERSION }) {
      return this.request('/api/device/register', {
        body: { schemaVersion: 1, deviceId, nickname, clientContext: { appVersion } },
      });
    }

    submit(deviceToken, submission) {
      return this.request('/api/submissions/create', { body: submission, token: deviceToken });
    }
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new SubmissionClientError('BASE64_UNAVAILABLE', '当前环境无法生成提交Hash', { category: 'environment' });
  }

  const SHA256_K = Object.freeze([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  function rotr(value, shift) { return (value >>> shift) | (value << (32 - shift)); }
  function sha256Fallback(bytes) {
    const length = bytes.length, bitLength = length * 8, paddedLength = Math.ceil((length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength); data.set(bytes); data[length] = 0x80;
    const view = new DataView(data.buffer); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false); view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3); const s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10); w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0; }
      let [a,b,c,d,e,f,g,hh] = h;
      for (let i=0;i<64;i++){const s1=rotr(e,6)^rotr(e,11)^rotr(e,25);const ch=(e&f)^(~e&g);const t1=(hh+s1+ch+SHA256_K[i]+w[i])>>>0;const s0=rotr(a,2)^rotr(a,13)^rotr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(s0+maj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
    }
    const result = new Uint8Array(32), resultView = new DataView(result.buffer); h.forEach((value,index)=>resultView.setUint32(index*4,value,false)); return result;
  }
  async function sha256Base64Url(value) {
    if (typeof TextEncoder !== 'function') throw new SubmissionClientError('TEXT_ENCODER_UNAVAILABLE', '当前环境无法生成提交Hash', { category: 'environment' });
    const bytes = new TextEncoder().encode(value);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) { try { return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', bytes))); } catch (_) {} }
    return toBase64Url(sha256Fallback(bytes));
  }

  async function buildIdempotencyKey(deviceId, submissionId, canonicalize) {
    return `ik_v1_${await sha256Base64Url(canonicalize({ schemaVersion: 1, deviceId, submissionId }))}`;
  }

  async function buildExactPriceSubmission({ snapshotSync, deviceId, submissionId, groupId, libraryId, serviceName, settleType, unitPrice, origin = 'user', clientCreatedAt = Date.now(), appVersion = APP_VERSION } = {}) {
    if (!snapshotSync?.computeExactPriceHashes || !snapshotSync?.canonicalize) throw new SubmissionClientError('HASH_MODULE_REQUIRED', '公共Hash模块不可用', { category: 'environment' });
    const hashes = await snapshotSync.computeExactPriceHashes(groupId, libraryId, { serviceName, settleType, unitPrice });
    const idempotencyKey = await buildIdempotencyKey(deviceId, submissionId, snapshotSync.canonicalize);
    return Object.freeze({
      schemaVersion: SUBMISSION_SCHEMA_VERSION,
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      submissionId,
      deviceId,
      groupId,
      libraryId,
      bossId: null,
      dataType: 'exact_price',
      operation: 'upsert',
      origin,
      clientCreatedAt: Math.max(0, Math.floor(Number(clientCreatedAt) || 0)),
      businessKey: hashes.businessKey,
      contentHash: hashes.contentHash,
      idempotencyKey,
      payload: hashes.payload,
      clientContext: { appVersion, projectionSpecVersion: PROJECTION_SPEC_VERSION, queueSchemaVersion: QUEUE_SCHEMA_VERSION },
    });
  }

  async function planInitialExactPriceSubmissions({ snapshotSync, deviceId, groupId, libraryId, localItems = [], baseHashes = {}, submissionIdFactory, now = () => Date.now(), appVersion = APP_VERSION } = {}) {
    if (typeof submissionIdFactory !== 'function') throw new SubmissionClientError('SUBMISSION_ID_FACTORY_REQUIRED', '提交ID生成器不可用', { category: 'environment' });
    const submissions = [], skipped = { alreadyPublic: 0, unsupported: 0, invalid: 0 };
    const seen = new Set();
    for (const item of Array.isArray(localItems) ? localItems : []) {
      const settleType = String(item?.settleType || '').trim().toLowerCase();
      if (!['round', 'hour'].includes(settleType)) { skipped.unsupported += 1; continue; }
      try {
        const hash = await snapshotSync.computeExactPriceHashes(groupId, libraryId, { serviceName: item?.serviceType, settleType, unitPrice: item?.unitPrice });
        if (seen.has(hash.businessKey)) continue;
        seen.add(hash.businessKey);
        if (baseHashes?.[hash.businessKey] === hash.contentHash) { skipped.alreadyPublic += 1; continue; }
        submissions.push(await buildExactPriceSubmission({
          snapshotSync, deviceId, submissionId: submissionIdFactory(), groupId, libraryId,
          serviceName: hash.payload.serviceName, settleType: hash.payload.settleType, unitPrice: hash.payload.unitPrice,
          origin: 'initialBinding', clientCreatedAt: now(), appVersion,
        }));
      } catch (_) { skipped.invalid += 1; }
    }
    return Object.freeze({ submissions: Object.freeze(submissions), skipped: Object.freeze(skipped) });
  }

  function shouldRetry(error) { return Boolean(error?.retryable); }

  class SubmissionDispatcher {
    constructor({ apiClient, metaStore, credentialStore, queueStore, appVersion = APP_VERSION, now = () => Date.now(), isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false, onState = null } = {}) {
      this.apiClient = apiClient;
      this.metaStore = metaStore;
      this.credentialStore = credentialStore;
      this.queueStore = queueStore;
      this.appVersion = appVersion;
      this.now = now;
      this.isOnline = isOnline;
      this.onState = typeof onState === 'function' ? onState : () => {};
      this._flushPromise = null;
    }

    emit(state) { try { this.onState(Object.freeze({ at: this.now(), ...state })); } catch (_) {} }

    async ensureCredential() {
      const current = this.credentialStore?.getValid?.(this.now());
      if (current) return current;
      const credentialResult = this.credentialStore?.loadResult?.();
      if (credentialResult?.ok && credentialResult?.exists) this.credentialStore.clear();
      const metaResult = this.metaStore?.loadResult?.();
      if (!metaResult?.ok || !metaResult?.exists || !metaResult.value?.deviceId) {
        throw new SubmissionClientError('DEVICE_IDENTITY_REQUIRED', '请先创建云协作身份', { category: 'configuration' });
      }
      const data = await this.apiClient.registerDevice({ deviceId: metaResult.value.deviceId, nickname: metaResult.value.nickname, appVersion: this.appVersion });
      if (!data?.deviceToken || data.deviceId !== metaResult.value.deviceId) {
        throw new SubmissionClientError('INVALID_REGISTRATION_RESPONSE', '设备注册响应无效', { category: 'protocol' });
      }
      return this.credentialStore.save({ schemaVersion: 1, deviceId: data.deviceId, deviceToken: data.deviceToken, issuedAt: data.issuedAt, expiresAt: data.expiresAt, tokenVersion: data.tokenVersion });
    }

    flush({ limit = 10 } = {}) {
      if (this._flushPromise) return this._flushPromise;
      this._flushPromise = this._flush({ limit }).finally(() => { this._flushPromise = null; });
      return this._flushPromise;
    }

    async _flush({ limit }) {
      const summary = { status: 'idle', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0, remaining: 0, errorCode: null, category: null };
      if (!this.apiClient?.isConfigured?.()) return { ...summary, status: 'not_configured' };
      if (!this.isOnline()) { this.emit({ status: 'offline' }); return { ...summary, status: 'offline' }; }
      const due = this.queueStore.getDue(this.now(), Math.max(1, Math.min(MAX_FLUSH_LIMIT, Number(limit) || 10)));
      if (!due.length) return summary;
      this.emit({ status: 'registering_or_sending', queued: due.length });
      let credential;
      try { credential = await this.ensureCredential(); }
      catch (error) {
        const status = shouldRetry(error) ? 'credential_retry' : 'credential_blocked';
        this.emit({ status, errorCode: error.code, category: error.category });
        return { ...summary, status, retryWait: shouldRetry(error) ? due.length : 0, blocked: shouldRetry(error) ? 0 : due.length, remaining: due.length, errorCode: error.code, category: error.category };
      }

      const result = { ...summary, status: 'completed' };
      for (const item of due) {
        const id = item.submission.submissionId;
        this.queueStore.markSending(id);
        result.attempted += 1;
        try {
          await this.apiClient.submit(credential.deviceToken, item.submission);
          this.queueStore.markAcknowledged(id);
          result.acknowledged += 1;
        } catch (error) {
          result.errorCode = error.code || 'SUBMISSION_ERROR';
          result.category = error.category || 'unknown';
          if (error.category === 'credential') {
            try { this.credentialStore.clear(); } catch (_) {}
            this.queueStore.markBlocked(id, error.code || 'DEVICE_CREDENTIAL_INVALID');
            result.blocked += 1;
          } else if (shouldRetry(error)) {
            this.queueStore.markRetry(id, error.code || 'SUBMISSION_RETRY');
            result.retryWait += 1;
          } else {
            this.queueStore.markBlocked(id, error.code || 'SUBMISSION_BLOCKED');
            result.blocked += 1;
          }
        }
      }
      try { this.queueStore.pruneAcknowledged(); } catch (_) {}
      result.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
      if (result.blocked) result.status = 'completed_with_blocked';
      else if (result.retryWait) result.status = 'completed_with_retry';
      this.emit(result);
      return result;
    }
  }

  function createConfiguredClient({ documentRef, locationRef, fetchImpl = globalThis.fetch, timeoutMs = 10000, previewAccessKeyProvider = null } = {}) {
    return new SubmissionApiClient({ baseUrl: readConfiguredBase({ documentRef, locationRef }), fetchImpl, timeoutMs, previewAccessKeyProvider, locationRef });
  }

  return Object.freeze({
    APP_VERSION,
    PREVIEW_KEY_HEADER,
    SubmissionClientError,
    SubmissionApiClient,
    SubmissionDispatcher,
    classifyRemoteError,
    shouldRetry,
    buildIdempotencyKey,
    buildExactPriceSubmission,
    planInitialExactPriceSubmissions,
    createConfiguredClient,
    readConfiguredBase,
  });
});
