(function(root, factory) {
  const api = factory(root?.CloudCollabSubmission || null, root?.CloudCollabSnapshotSync || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabOrdinarySubmission = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(baseSubmission, snapshotSyncDefault) {
  'use strict';

  const APP_VERSION = '8.2.29-stage5g';
  const PREVIEW_ALLOWED_GROUP_ID = 'group_fixture';
  const PREVIEW_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
  const ALLOWED_DATA_TYPES = new Set(['exact_price', 'playable_name', 'boss_profile']);
  const MAX_FLUSH_LIMIT = 20;
  const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  const URL_PATTERN = /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|gg|app)\b)/iu;
  const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u;
  const PHONE_PATTERN = /(?:\+?\d[\d\s()-]{5,}\d)/u;
  const CONTACT_PATTERN = /(?:微信|微\s*信|wechat|(?:^|[^a-z])wx|(?:^|[^a-z])vx|v信|qq|企鹅|telegram|(?:^|[^a-z])tg|电话|手机|联系我|加我)\s*[:：_\-]?\s*[A-Za-z0-9_-]{4,}/iu;

  class OrdinarySubmissionClientError extends Error {
    constructor(code, message, { category = 'validation', details = null, cause = null } = {}) {
      super(message || code || '普通共享候选生成失败');
      this.name = 'OrdinarySubmissionClientError';
      this.code = code || 'ORDINARY_SUBMISSION_CLIENT_ERROR';
      this.category = category;
      this.details = details;
      if (cause) this.cause = cause;
    }
  }

  function canonicalize(value, snapshotSync = snapshotSyncDefault) {
    if (!snapshotSync?.canonicalize) {
      throw new OrdinarySubmissionClientError('CANONICALIZER_REQUIRED', '公共规范化模块不可用', { category: 'environment' });
    }
    return snapshotSync.canonicalize(value);
  }

  function normalizeText(value, { label, maxLength, allowEmpty = false } = {}) {
    let text = String(value ?? '');
    try { text = text.normalize('NFKC'); } catch (_) {}
    if (CONTROL_PATTERN.test(text)) throw new OrdinarySubmissionClientError('ORDINARY_TEXT_CONTROL_CHARACTER', `${label}不能包含控制字符`);
    text = text.replace(/\s+/gu, ' ').trim();
    if ((!allowEmpty && !text) || text.length > maxLength) {
      throw new OrdinarySubmissionClientError('ORDINARY_TEXT_LENGTH_INVALID', `${label}长度无效`);
    }
    if (text && (URL_PATTERN.test(text) || EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || CONTACT_PATTERN.test(text))) {
      throw new OrdinarySubmissionClientError('ORDINARY_CONTACT_INFO_FORBIDDEN', `${label}不能包含链接、邮箱或联系方式`);
    }
    return text;
  }

  function normalizePlayableNamePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'name') {
      throw new OrdinarySubmissionClientError('INVALID_PLAYABLE_NAME_FIELDS', '陪玩名字字段必须严格符合白名单');
    }
    return Object.freeze({ name: normalizeText(value.name, { label: '陪玩名字', maxLength: 30 }) });
  }

  function normalizeDiscount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0.8 || number > 1) {
      throw new OrdinarySubmissionClientError('INVALID_BOSS_DISCOUNT', '老板折数必须在0.8至1之间');
    }
    const rounded = Math.round(number * 10000) / 10000;
    if (Math.abs(rounded - number) > 1e-10) {
      throw new OrdinarySubmissionClientError('INVALID_BOSS_DISCOUNT', '老板折数最多保留4位小数');
    }
    return rounded;
  }

  function normalizeBossProfilePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'bossName,discount,paiDan') {
      throw new OrdinarySubmissionClientError('INVALID_BOSS_PROFILE_FIELDS', '老板资料字段必须严格符合白名单');
    }
    return Object.freeze({
      bossName: normalizeText(value.bossName, { label: '老板名', maxLength: 30 }),
      paiDan: normalizeText(value.paiDan, { label: '直属/派单', maxLength: 30, allowEmpty: true }),
      discount: normalizeDiscount(value.discount),
    });
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new OrdinarySubmissionClientError('BASE64_UNAVAILABLE', '当前环境无法生成提交Hash', { category: 'environment' });
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
    const length = bytes.length;
    const bitLength = length * 8;
    const paddedLength = Math.ceil((length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength);
    data.set(bytes);
    data[length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,hh] = h;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
      h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
    }
    const result = new Uint8Array(32);
    const resultView = new DataView(result.buffer);
    h.forEach((value, index) => resultView.setUint32(index * 4, value, false));
    return result;
  }

  async function sha256Base64Url(value) {
    if (typeof TextEncoder !== 'function') {
      throw new OrdinarySubmissionClientError('TEXT_ENCODER_UNAVAILABLE', '当前环境无法生成提交Hash', { category: 'environment' });
    }
    const bytes = new TextEncoder().encode(value);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      try { return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', bytes))); } catch (_) {}
    }
    return toBase64Url(sha256Fallback(bytes));
  }

  async function hashCanonical(value, snapshotSync = snapshotSyncDefault) {
    return sha256Base64Url(canonicalize(value, snapshotSync));
  }

  async function deriveBossId(groupId, bossName, snapshotSync = snapshotSyncDefault) {
    const normalizedBossName = normalizeText(bossName, { label: '老板名', maxLength: 30 });
    return `boss_v1_${await hashCanonical({
      schemaVersion: 1,
      groupId,
      normalizedBossName: normalizedBossName.toLocaleLowerCase('und'),
    }, snapshotSync)}`;
  }

  async function buildOrdinarySubmission({
    snapshotSync = snapshotSyncDefault,
    base = baseSubmission,
    deviceId,
    submissionId,
    groupId,
    libraryId,
    dataType,
    payload,
    origin = 'user',
    clientCreatedAt = Date.now(),
    appVersion = APP_VERSION,
  } = {}) {
    if (!base?.buildIdempotencyKey) {
      throw new OrdinarySubmissionClientError('BASE_SUBMISSION_CLIENT_REQUIRED', '基础提交客户端不可用', { category: 'environment' });
    }
    if (groupId !== PREVIEW_ALLOWED_GROUP_ID || libraryId !== PREVIEW_ALLOWED_LIBRARY_ID) {
      throw new OrdinarySubmissionClientError('PREVIEW_SCOPE_CLIENT_BLOCKED', '普通共享候选仅允许合成预览作用域');
    }
    if (!['user', 'initialBinding'].includes(origin)) {
      throw new OrdinarySubmissionClientError('INVALID_SUBMISSION_ORIGIN', '普通共享候选来源无效');
    }
    const normalizedType = String(dataType || '').trim().toLowerCase();
    if (!['playable_name', 'boss_profile'].includes(normalizedType)) {
      throw new OrdinarySubmissionClientError('UNSUPPORTED_ORDINARY_DATA_TYPE', '普通共享候选类型无效');
    }
    const normalizedPayload = normalizedType === 'playable_name'
      ? normalizePlayableNamePayload(payload)
      : normalizeBossProfilePayload(payload);
    const bossId = normalizedType === 'boss_profile'
      ? await deriveBossId(groupId, normalizedPayload.bossName, snapshotSync)
      : null;
    const identity = normalizedType === 'playable_name'
      ? { groupId, normalizedName: normalizedPayload.name.toLocaleLowerCase('und'), dataType: 'playable_name' }
      : { groupId, bossId, dataType: 'boss_profile' };
    const content = {
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      groupId,
      bossId,
      dataType: normalizedType,
      operation: 'upsert',
      payload: normalizedPayload,
    };
    const businessKey = `bk_v1_${await hashCanonical(identity, snapshotSync)}`;
    const contentHash = `ch_v1_${await hashCanonical(content, snapshotSync)}`;
    const idempotencyKey = await base.buildIdempotencyKey(deviceId, submissionId, value => canonicalize(value, snapshotSync));
    return Object.freeze({
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      submissionId,
      deviceId,
      groupId,
      libraryId,
      bossId,
      dataType: normalizedType,
      operation: 'upsert',
      origin,
      clientCreatedAt: Math.max(0, Math.floor(Number(clientCreatedAt) || 0)),
      businessKey,
      contentHash,
      idempotencyKey,
      payload: normalizedPayload,
      clientContext: { appVersion, projectionSpecVersion: 1, queueSchemaVersion: 1 },
    });
  }

  function buildPlayableNameSubmission(options = {}) {
    return buildOrdinarySubmission({ ...options, dataType: 'playable_name', payload: { name: options.name } });
  }

  function buildBossProfileSubmission(options = {}) {
    return buildOrdinarySubmission({
      ...options,
      dataType: 'boss_profile',
      payload: { bossName: options.bossName, paiDan: options.paiDan, discount: options.discount },
    });
  }

  function isPreviewSubmissionScope(submission) {
    return submission?.groupId === PREVIEW_ALLOWED_GROUP_ID
      && submission?.libraryId === PREVIEW_ALLOWED_LIBRARY_ID
      && ALLOWED_DATA_TYPES.has(submission?.dataType)
      && submission?.operation === 'upsert';
  }

  class SubmissionDispatcher {
    constructor({ apiClient, metaStore, credentialStore, queueStore, bindingStore = null, appVersion = APP_VERSION, now = () => Date.now(), isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false, onState = null } = {}) {
      this.apiClient = apiClient;
      this.metaStore = metaStore;
      this.credentialStore = credentialStore;
      this.queueStore = queueStore;
      this.bindingStore = bindingStore;
      this.appVersion = appVersion;
      this.now = now;
      this.isOnline = isOnline;
      this.onState = typeof onState === 'function' ? onState : () => {};
      this._flushPromise = null;
    }

    emit(state) { try { this.onState(Object.freeze({ at: this.now(), ...state })); } catch (_) {} }

    hasCollaborativeBinding(submission) {
      if (!this.bindingStore?.list) return false;
      try {
        return this.bindingStore.list().some(binding => binding?.mode === 'collaborate'
          && binding.groupId === submission?.groupId
          && binding.libraryId === submission?.libraryId);
      } catch (_) { return false; }
    }

    async ensureCredential() {
      const current = this.credentialStore?.getValid?.(this.now());
      if (current) return current;
      const credentialResult = this.credentialStore?.loadResult?.();
      if (credentialResult?.ok && credentialResult?.exists) this.credentialStore.clear();
      const metaResult = this.metaStore?.loadResult?.();
      if (!metaResult?.ok || !metaResult?.exists || !metaResult.value?.deviceId) {
        throw new OrdinarySubmissionClientError('DEVICE_IDENTITY_REQUIRED', '请先创建云协作身份', { category: 'configuration' });
      }
      const data = await this.apiClient.registerDevice({
        deviceId: metaResult.value.deviceId,
        nickname: metaResult.value.nickname,
        appVersion: this.appVersion,
      });
      if (!data?.deviceToken || data.deviceId !== metaResult.value.deviceId) {
        throw new OrdinarySubmissionClientError('INVALID_REGISTRATION_RESPONSE', '设备注册响应无效', { category: 'protocol' });
      }
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
      const summary = { status: 'idle', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0, skippedMode: 0, remaining: 0, errorCode: null, category: null };
      if (!this.apiClient?.isConfigured?.()) return { ...summary, status: 'not_configured' };
      if (!this.isOnline()) { this.emit({ status: 'offline' }); return { ...summary, status: 'offline' }; }
      if (typeof this.apiClient.hasWriteAccess === 'function' && !this.apiClient.hasWriteAccess()) {
        this.emit({ status: 'write_gate_closed', errorCode: 'WRITE_GATE_CLOSED', category: 'write_gate' });
        return { ...summary, status: 'write_gate_closed', errorCode: 'WRITE_GATE_CLOSED', category: 'write_gate' };
      }
      const dueAll = this.queueStore.getDue(this.now(), Math.max(1, Math.min(MAX_FLUSH_LIMIT, Number(limit) || 10)));
      if (!dueAll.length) return summary;
      const due = [];
      for (const item of dueAll) {
        const submission = item?.submission;
        if (!isPreviewSubmissionScope(submission)) {
          this.queueStore.markBlocked(submission.submissionId, 'PREVIEW_SCOPE_CLIENT_BLOCKED');
          summary.blocked += 1;
          summary.errorCode = 'PREVIEW_SCOPE_CLIENT_BLOCKED';
          summary.category = 'forbidden';
          continue;
        }
        if (!this.hasCollaborativeBinding(submission)) {
          summary.skippedMode += 1;
          continue;
        }
        due.push(item);
      }
      if (!due.length) {
        summary.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
        summary.status = summary.blocked ? 'completed_with_blocked' : 'no_collaborative_due';
        this.emit(summary);
        return summary;
      }
      this.emit({ status: 'registering_or_sending', queued: due.length });
      let credential;
      try { credential = await this.ensureCredential(); }
      catch (error) {
        const retryable = Boolean(error?.retryable || baseSubmission?.shouldRetry?.(error));
        if (!retryable) {
          for (const item of due) {
            try { this.queueStore.markBlocked(item.submission.submissionId, error.code || 'DEVICE_REGISTRATION_BLOCKED'); summary.blocked += 1; } catch (_) {}
          }
        }
        summary.status = retryable ? 'credential_retry' : 'credential_blocked';
        summary.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
        summary.errorCode = error.code || 'DEVICE_REGISTRATION_FAILED';
        summary.category = error.category || 'unknown';
        this.emit(summary);
        return summary;
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
            break;
          }
          if (error.category === 'write_gate' || error.category === 'service_disabled') {
            this.queueStore.markBlocked(id, error.code || 'WRITE_GATE_BLOCKED');
            result.blocked += 1;
            break;
          }
          if (Boolean(error?.retryable || baseSubmission?.shouldRetry?.(error))) {
            this.queueStore.markRetry(id, error.code || 'SUBMISSION_RETRY');
            result.retryWait += 1;
            break;
          }
          this.queueStore.markBlocked(id, error.code || 'SUBMISSION_BLOCKED');
          result.blocked += 1;
        }
      }
      try { this.queueStore.pruneAcknowledged(); } catch (_) {}
      result.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
      if (result.blocked) result.status = 'completed_with_blocked';
      else if (result.retryWait) result.status = 'completed_with_retry';
      else if (result.skippedMode) result.status = 'completed_with_mode_skips';
      this.emit(result);
      return result;
    }
  }

  return Object.freeze({
    APP_VERSION,
    PREVIEW_ALLOWED_GROUP_ID,
    PREVIEW_ALLOWED_LIBRARY_ID,
    OrdinarySubmissionClientError,
    normalizePlayableNamePayload,
    normalizeBossProfilePayload,
    deriveBossId,
    buildOrdinarySubmission,
    buildPlayableNameSubmission,
    buildBossProfileSubmission,
    isPreviewSubmissionScope,
    SubmissionDispatcher,
  });
});
