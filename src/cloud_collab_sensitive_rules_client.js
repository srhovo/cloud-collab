(function(root, factory) {
  const api = factory(
    root?.CloudCollabSubmission || null,
    root?.CloudCollabSnapshotSync || null,
    root?.CloudCollabOrdinaryTypes || null,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSensitiveRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(baseSubmission, snapshotSync, ordinaryTypes) {
  'use strict';

  const APP_VERSION = '8.2.31-stage6b';
  const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
  const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
  const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
  const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
  const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
  const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
  const BOSS_ID_PATTERN = /^boss_v1_[A-Za-z0-9_-]{43}$/;
  const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  const CONTACT_PATTERN = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d\s()-]{5,}\d)|(?:微信|微\s*信|wechat|(?:^|[^a-z])wx|(?:^|[^a-z])vx|v信|qq|企鹅|telegram|(?:^|[^a-z])tg|电话|手机|联系我|加我)\s*[:：_\-]?\s*[A-Za-z0-9_-]{4,})/iu;
  const RULE_TYPES = new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule']);
  const DELETE_TYPES = new Set(['exact_price', 'playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule']);

  class SensitiveClientError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '敏感规则客户端处理失败');
      this.name = 'SensitiveClientError';
      this.code = code || 'SENSITIVE_CLIENT_ERROR';
      this.details = details;
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.toString.call(value) === '[object Object]';
  }

  function exactKeys(value, expected, code, message) {
    if (!isPlainObject(value)) throw new SensitiveClientError(code, message);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      throw new SensitiveClientError(code, message, { actual, expected: wanted });
    }
  }

  function canonicalize(value) {
    if (snapshotSync?.canonicalize) return snapshotSync.canonicalize(value);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SensitiveClientError('INVALID_CANONICAL_NUMBER', '规范对象包含无效数字');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (!isPlainObject(value)) throw new SensitiveClientError('INVALID_CANONICAL_VALUE', '规范对象包含不支持的值');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new SensitiveClientError('BASE64_UNAVAILABLE', '当前环境无法生成敏感规则Hash');
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
    data.set(bytes); data[length] = 0x80;
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
        hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
      h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
    }
    const result = new Uint8Array(32);
    const resultView = new DataView(result.buffer);
    h.forEach((value, index) => resultView.setUint32(index * 4, value, false));
    return result;
  }

  async function sha256Base64Url(value) {
    if (typeof TextEncoder !== 'function') throw new SensitiveClientError('TEXT_ENCODER_UNAVAILABLE', '当前环境无法生成敏感规则Hash');
    const bytes = new TextEncoder().encode(value);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      try { return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', bytes))); } catch (_) {}
    }
    return toBase64Url(sha256Fallback(bytes));
  }

  function normalizeText(value, label, maxLength, { allowEmpty = false } = {}) {
    let text = String(value ?? '');
    try { text = text.normalize('NFKC'); } catch (_) {}
    if (CONTROL_PATTERN.test(text)) throw new SensitiveClientError('SENSITIVE_TEXT_CONTROL_CHARACTER', `${label}不能包含控制字符`);
    text = text.replace(/[\s\u3000]+/gu, ' ').trim();
    if ((!allowEmpty && !text) || text.length > maxLength) throw new SensitiveClientError('SENSITIVE_TEXT_LENGTH_INVALID', `${label}长度无效`);
    if (text && CONTACT_PATTERN.test(text)) throw new SensitiveClientError('SENSITIVE_CONTACT_INFO_FORBIDDEN', `${label}不能包含链接、邮箱或联系方式`);
    return text;
  }

  function normalizePrice(value, label, { allowNull = true } = {}) {
    if (value === null && allowNull) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 1000000) throw new SensitiveClientError('INVALID_SENSITIVE_RULE_PRICE', `${label}金额无效`);
    const rounded = Math.round(number * 1000) / 1000;
    if (Math.abs(rounded - number) > 1e-9) throw new SensitiveClientError('INVALID_SENSITIVE_RULE_PRICE', `${label}最多保留3位小数`);
    return rounded;
  }

  function pricePair(value, label) {
    exactKeys(value, ['round', 'hour'], 'INVALID_SENSITIVE_PRICE_FIELDS', `${label}价格字段无效`);
    return Object.freeze({ round: normalizePrice(value.round, `${label}局数`), hour: normalizePrice(value.hour, `${label}小时`) });
  }

  function normalizeRankRangeRulePayload(value) {
    exactKeys(value, ['rangeLabel', 'alias', 'rankType', 'minStar', 'maxStar', 'namedRanks', 'prices'], 'INVALID_RANK_RANGE_RULE_FIELDS', '区间规则字段无效');
    const rankType = String(value.rankType || '').trim();
    if (!['star', 'namedTier', 'lowerTier'].includes(rankType)) throw new SensitiveClientError('INVALID_RANK_TYPE', '区间规则类型无效');
    let minStar = null, maxStar = null, namedRanks = [];
    if (rankType === 'star') {
      minStar = Number(value.minStar); maxStar = Number(value.maxStar);
      if (!Number.isInteger(minStar) || !Number.isInteger(maxStar) || minStar < 0 || maxStar < minStar || maxStar > 100000) throw new SensitiveClientError('INVALID_STAR_RANGE', '星数区间无效');
      if (!Array.isArray(value.namedRanks) || value.namedRanks.length) throw new SensitiveClientError('INVALID_STAR_NAMED_RANKS', '星数区间不能带命名段位');
    } else {
      if (value.minStar !== null || value.maxStar !== null || !Array.isArray(value.namedRanks) || !value.namedRanks.length || value.namedRanks.length > 20) throw new SensitiveClientError('INVALID_NAMED_RANKS', '命名段位区间无效');
      const seen = new Set();
      namedRanks = value.namedRanks.map(item => normalizeText(item, '命名段位', 24)).filter(item => {
        const key = item.toLocaleLowerCase('und'); if (seen.has(key)) return false; seen.add(key); return true;
      });
    }
    exactKeys(value.prices, ['normal', 'carry', 'starGuarantee'], 'INVALID_RANGE_PRICE_VARIANTS', '区间价格类型无效');
    const prices = Object.freeze({ normal: pricePair(value.prices.normal, '普排'), carry: pricePair(value.prices.carry, '包C'), starGuarantee: pricePair(value.prices.starGuarantee, '包星') });
    if (![...Object.values(prices)].some(pair => pair.round !== null || pair.hour !== null)) throw new SensitiveClientError('RANGE_PRICE_REQUIRED', '区间规则至少需要一个价格');
    return Object.freeze({
      rangeLabel: normalizeText(value.rangeLabel, '区间名称', 24),
      alias: normalizeText(value.alias, '区间别名', 24, { allowEmpty: true }),
      rankType, minStar, maxStar, namedRanks: Object.freeze(namedRanks), prices,
    });
  }

  function normalizeSurchargeRulePayload(value) {
    exactKeys(value, ['name', 'keywords', 'prices', 'enabled'], 'INVALID_SURCHARGE_RULE_FIELDS', '加价规则字段无效');
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > 12) throw new SensitiveClientError('INVALID_SURCHARGE_RULE', '加价规则内容无效');
    const seen = new Set();
    const keywords = value.keywords.map(item => normalizeText(item, '加价关键词', 24)).filter(item => {
      const key = item.toLocaleLowerCase('und'); if (seen.has(key)) return false; seen.add(key); return true;
    });
    const prices = pricePair(value.prices, '加价');
    if (prices.round === null && prices.hour === null) throw new SensitiveClientError('SURCHARGE_PRICE_REQUIRED', '加价规则至少需要一个价格');
    return Object.freeze({ name: normalizeText(value.name, '加价规则名称', 24), keywords: Object.freeze(keywords), prices, enabled: value.enabled });
  }

  function normalizeGiftRulePayload(value) {
    exactKeys(value, ['serviceName', 'mode', 'unitPrice'], 'INVALID_GIFT_RULE_FIELDS', '礼物规则字段无效');
    const mode = String(value.mode || '').trim().toLowerCase();
    if (!['fixed', 'variable'].includes(mode)) throw new SensitiveClientError('INVALID_GIFT_MODE', '礼物金额模式无效');
    if (mode === 'variable' && value.unitPrice !== null) throw new SensitiveClientError('VARIABLE_GIFT_PRICE_MUST_BE_NULL', '随机金额礼物不能带固定金额');
    return Object.freeze({ serviceName: normalizeText(value.serviceName, '礼物名称', 60), mode, unitPrice: mode === 'fixed' ? normalizePrice(value.unitPrice, '礼物固定金额', { allowNull: false }) : null });
  }

  function normalizeRulePayload(dataType, payload) {
    if (dataType === 'rank_range_rule') return normalizeRankRangeRulePayload(payload);
    if (dataType === 'surcharge_rule') return normalizeSurchargeRulePayload(payload);
    if (dataType === 'gift_rule') return normalizeGiftRulePayload(payload);
    throw new SensitiveClientError('UNSUPPORTED_SENSITIVE_DATA_TYPE', '敏感规则类型不受支持');
  }

  function assertScope(groupId, libraryId) {
    const group = String(groupId || '').trim().toLowerCase();
    const library = String(libraryId || '').trim().toLowerCase();
    if (!GROUP_ID_PATTERN.test(group) || !LIBRARY_ID_PATTERN.test(library)) throw new SensitiveClientError('INVALID_PUBLIC_SCOPE', '敏感规则作用域无效');
    return { groupId: group, libraryId: library };
  }

  function ruleIdentity(scope, dataType, payload) {
    if (dataType === 'rank_range_rule') {
      const boundary = payload.rankType === 'star'
        ? `${payload.minStar}-${payload.maxStar}`
        : [...payload.namedRanks].map(item => item.toLocaleLowerCase('und')).sort().join('|');
      return { groupId: scope.groupId, libraryId: scope.libraryId, dataType, rankType: payload.rankType, boundary, rangeLabel: payload.rangeLabel.toLocaleLowerCase('und') };
    }
    if (dataType === 'surcharge_rule') return { groupId: scope.groupId, libraryId: scope.libraryId, dataType, name: payload.name.toLocaleLowerCase('und'), keywords: [...payload.keywords].map(item => item.toLocaleLowerCase('und')).sort() };
    return { groupId: scope.groupId, libraryId: scope.libraryId, dataType, serviceName: payload.serviceName.toLocaleLowerCase('und') };
  }

  async function buildSensitiveSubmission({
    deviceId, submissionId, groupId, libraryId, dataType, operation = 'upsert', payload,
    businessKey = null, bossId = null, origin = 'user', clientCreatedAt = Date.now(), appVersion = APP_VERSION,
  } = {}) {
    if (!DEVICE_ID_PATTERN.test(String(deviceId || '')) || !SUBMISSION_ID_PATTERN.test(String(submissionId || ''))) throw new SensitiveClientError('INVALID_SUBMISSION_IDENTITY', '敏感规则设备或提交ID无效');
    if (!['user', 'initialBinding'].includes(origin)) throw new SensitiveClientError('INVALID_SUBMISSION_ORIGIN', '敏感规则只能来自明确用户操作');
    const scope = assertScope(groupId, libraryId);
    const type = String(dataType || '').trim().toLowerCase();
    const op = String(operation || '').trim().toLowerCase();
    if (type === 'boss_profile' && op === 'upsert') {
      if (!ordinaryTypes?.buildOrdinarySubmission) throw new SensitiveClientError('ORDINARY_MODULE_REQUIRED', '老板敏感变更需要普通共享模块');
      return ordinaryTypes.buildOrdinarySubmission({ deviceId, submissionId, groupId: scope.groupId, libraryId: scope.libraryId, dataType: type, payload, origin, clientCreatedAt, appVersion });
    }
    if (op === 'upsert' && !RULE_TYPES.has(type)) throw new SensitiveClientError('UNSUPPORTED_SENSITIVE_DATA_TYPE', '敏感upsert只允许区间、加价或礼物规则');
    if (op === 'delete' && !DELETE_TYPES.has(type)) throw new SensitiveClientError('UNSUPPORTED_DELETE_DATA_TYPE', '敏感删除类型不受支持');
    if (op === 'delete' && payload !== null) throw new SensitiveClientError('DELETE_PAYLOAD_MUST_BE_NULL', '敏感删除payload必须为null');
    const normalizedPayload = op === 'delete' ? null : normalizeRulePayload(type, payload);
    const normalizedBossId = type === 'boss_profile'
      ? (() => { if (!BOSS_ID_PATTERN.test(String(bossId || ''))) throw new SensitiveClientError('INVALID_BOSS_ID', '老板身份无效'); return bossId; })()
      : null;
    const resolvedBusinessKey = op === 'delete'
      ? (() => { if (!BUSINESS_KEY_PATTERN.test(String(businessKey || ''))) throw new SensitiveClientError('INVALID_BUSINESS_KEY', '删除目标业务键无效'); return businessKey; })()
      : `bk_v1_${await sha256Base64Url(canonicalize(ruleIdentity(scope, type, normalizedPayload)))}`;
    const content = {
      schemaVersion: 1, payloadSchemaVersion: 1, groupId: scope.groupId, libraryId: scope.libraryId,
      bossId: normalizedBossId, dataType: type, operation: op,
      businessKey: op === 'delete' ? resolvedBusinessKey : null,
      payload: normalizedPayload,
    };
    const contentHash = `ch_v1_${await sha256Base64Url(canonicalize(content))}`;
    if (!baseSubmission?.buildIdempotencyKey) throw new SensitiveClientError('SUBMISSION_MODULE_REQUIRED', '提交模块不可用');
    const idempotencyKey = await baseSubmission.buildIdempotencyKey(deviceId, submissionId, canonicalize);
    return Object.freeze({
      schemaVersion: 1, payloadSchemaVersion: 1, submissionId, deviceId,
      groupId: scope.groupId, libraryId: scope.libraryId, bossId: normalizedBossId,
      dataType: type, operation: op, origin,
      clientCreatedAt: Math.max(0, Math.floor(Number(clientCreatedAt) || 0)),
      businessKey: resolvedBusinessKey, contentHash, idempotencyKey,
      payload: normalizedPayload,
      clientContext: { appVersion, projectionSpecVersion: 1, queueSchemaVersion: 1 },
    });
  }

  function isPreviewSensitiveSubmissionScope(submission) {
    return submission?.groupId === baseSubmission?.PREVIEW_ALLOWED_GROUP_ID
      && submission?.libraryId === baseSubmission?.PREVIEW_ALLOWED_LIBRARY_ID
      && ((RULE_TYPES.has(submission?.dataType) && submission?.operation === 'upsert')
        || (DELETE_TYPES.has(submission?.dataType) && submission?.operation === 'delete')
        || (submission?.dataType === 'boss_profile' && submission?.operation === 'upsert'));
  }

  class SensitiveSubmissionApiClient {
    constructor({ baseClient } = {}) { this.baseClient = baseClient; }
    isConfigured() { return Boolean(this.baseClient?.isConfigured?.()); }
    hasWriteAccess() { return Boolean(this.baseClient?.hasWriteAccess?.()); }
    registerDevice(input) { return this.baseClient.registerDevice(input); }
    submit(deviceToken, submission) {
      if (!this.baseClient?.request) throw new SensitiveClientError('API_NOT_CONFIGURED', '敏感候选接口不可用');
      return this.baseClient.request('/api/preview/sensitive-submissions/create', { body: submission, token: deviceToken });
    }
  }

  class SensitiveSubmissionDispatcher {
    constructor({ apiClient, metaStore, credentialStore, queueStore, bindingStore = null, appVersion = APP_VERSION, now = () => Date.now(), isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false, onState = null } = {}) {
      this.apiClient = apiClient; this.metaStore = metaStore; this.credentialStore = credentialStore;
      this.queueStore = queueStore; this.bindingStore = bindingStore; this.appVersion = appVersion;
      this.now = now; this.isOnline = isOnline; this.onState = typeof onState === 'function' ? onState : () => {};
      this._flushPromise = null;
    }
    emit(state) { try { this.onState(Object.freeze({ at: this.now(), ...state })); } catch (_) {} }
    hasCollaborativeBinding(submission) {
      try { return Boolean(this.bindingStore?.list?.().some(binding => binding?.mode === 'collaborate' && binding.groupId === submission?.groupId && binding.libraryId === submission?.libraryId)); }
      catch (_) { return false; }
    }
    async ensureCredential() {
      const current = this.credentialStore?.getValid?.(this.now()); if (current) return current;
      const previous = this.credentialStore?.loadResult?.(); if (previous?.ok && previous?.exists) this.credentialStore.clear();
      const meta = this.metaStore?.loadResult?.();
      if (!meta?.ok || !meta?.exists || !meta.value?.deviceId) throw new SensitiveClientError('DEVICE_IDENTITY_REQUIRED', '请先创建云协作身份');
      const data = await this.apiClient.registerDevice({ deviceId: meta.value.deviceId, nickname: meta.value.nickname, appVersion: this.appVersion });
      if (!data?.deviceToken || data.deviceId !== meta.value.deviceId) throw new SensitiveClientError('INVALID_REGISTRATION_RESPONSE', '设备注册响应无效');
      return this.credentialStore.save({ schemaVersion: 1, deviceId: data.deviceId, deviceToken: data.deviceToken, issuedAt: data.issuedAt, expiresAt: data.expiresAt, tokenVersion: data.tokenVersion });
    }
    flush({ limit = 10 } = {}) {
      if (this._flushPromise) return this._flushPromise;
      this._flushPromise = this._flush({ limit }).finally(() => { this._flushPromise = null; }); return this._flushPromise;
    }
    async _flush({ limit }) {
      const summary = { status: 'idle', attempted: 0, acknowledged: 0, retryWait: 0, blocked: 0, skippedMode: 0, remaining: 0, errorCode: null, category: null };
      if (!this.apiClient?.isConfigured?.()) return { ...summary, status: 'not_configured' };
      if (!this.isOnline()) return { ...summary, status: 'offline' };
      if (!this.apiClient.hasWriteAccess()) return { ...summary, status: 'write_gate_closed', errorCode: 'WRITE_GATE_CLOSED', category: 'write_gate' };
      const due = [];
      for (const item of this.queueStore.getDue(this.now(), Math.max(1, Math.min(20, Number(limit) || 10)))) {
        const submission = item?.submission;
        if (!isPreviewSensitiveSubmissionScope(submission)) continue;
        if (!this.hasCollaborativeBinding(submission)) { summary.skippedMode += 1; continue; }
        due.push(item);
      }
      if (!due.length) return { ...summary, status: 'no_sensitive_due' };
      let credential;
      try { credential = await this.ensureCredential(); }
      catch (error) { return { ...summary, status: 'credential_blocked', errorCode: error.code || 'DEVICE_REGISTRATION_FAILED', category: error.category || 'unknown' }; }
      const result = { ...summary, status: 'completed' };
      for (const item of due) {
        const id = item.submission.submissionId;
        this.queueStore.markSending(id); result.attempted += 1;
        try {
          await this.apiClient.submit(credential.deviceToken, item.submission);
          this.queueStore.markAcknowledged(id); result.acknowledged += 1;
        } catch (error) {
          result.errorCode = error.code || 'SENSITIVE_SUBMISSION_ERROR'; result.category = error.category || 'unknown';
          if (error.retryable) { this.queueStore.markRetry(id, result.errorCode); result.retryWait += 1; break; }
          this.queueStore.markBlocked(id, result.errorCode); result.blocked += 1;
        }
      }
      try { this.queueStore.pruneAcknowledged(); } catch (_) {}
      result.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
      if (result.blocked) result.status = 'completed_with_blocked'; else if (result.retryWait) result.status = 'completed_with_retry';
      this.emit(result); return result;
    }
  }

  return Object.freeze({
    APP_VERSION,
    SensitiveClientError,
    normalizeRankRangeRulePayload,
    normalizeSurchargeRulePayload,
    normalizeGiftRulePayload,
    buildSensitiveSubmission,
    isPreviewSensitiveSubmissionScope,
    SensitiveSubmissionApiClient,
    SensitiveSubmissionDispatcher,
  });
});
