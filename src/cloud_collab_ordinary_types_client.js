(function(root, factory) {
  const api = factory(root?.CloudCollabSubmission || null, root?.CloudCollabSnapshotSync || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabOrdinaryTypes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(baseSubmission, snapshotSync) {
  'use strict';

  const APP_VERSION = '8.2.28-stage5g';
  const SCHEMA_VERSION = 1;
  const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
  const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
  const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
  const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
  const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
  const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
  const BOSS_ID_PATTERN = /^boss_v1_[A-Za-z0-9_-]{43}$/;
  const CONTACT_PATTERN = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d\s()-]{5,}\d)|(?:微信|微\s*信|wechat|(?:^|[^a-z])wx|(?:^|[^a-z])vx|v信|qq|企鹅|telegram|(?:^|[^a-z])tg|电话|手机|联系我|加我)\s*[:：_\-]?\s*[A-Za-z0-9_-]{4,})/iu;
  const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  const ORDINARY_TYPES = new Set(['playable_name', 'boss_profile']);

  class OrdinaryClientError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '普通共享客户端处理失败');
      this.name = 'OrdinaryClientError';
      this.code = code || 'ORDINARY_CLIENT_ERROR';
      this.details = details;
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.toString.call(value) === '[object Object]';
  }

  function exactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function canonicalize(value) {
    if (snapshotSync?.canonicalize) return snapshotSync.canonicalize(value);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new OrdinaryClientError('INVALID_CANONICAL_NUMBER', '规范对象包含无效数字');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (!isPlainObject(value)) throw new OrdinaryClientError('INVALID_CANONICAL_VALUE', '规范对象包含不支持的值');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new OrdinaryClientError('BASE64_UNAVAILABLE', '当前环境无法生成普通共享Hash');
  }

  const SHA256_K = Object.freeze([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0b5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  // Correct the compact constant above without changing the frozen public surface.
  const SHA256_CONSTANTS = Object.freeze(SHA256_K.map((value, index) => index === 51 ? 0x34b0bcb5 : value));
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
        const t1 = (hh + s1 + ch + SHA256_CONSTANTS[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
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
    if (typeof TextEncoder !== 'function') throw new OrdinaryClientError('TEXT_ENCODER_UNAVAILABLE', '当前环境无法生成普通共享Hash');
    const bytes = new TextEncoder().encode(value);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      try { return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', bytes))); } catch (_) {}
    }
    return toBase64Url(sha256Fallback(bytes));
  }

  function normalizeHumanText(value, label, maxLength, { allowEmpty = false } = {}) {
    let text = String(value ?? '');
    try { text = text.normalize('NFKC'); } catch (_) {}
    if (CONTROL_PATTERN.test(text)) throw new OrdinaryClientError('ORDINARY_TEXT_CONTROL_CHARACTER', `${label}不能包含控制字符`);
    text = text.replace(/\s+/gu, ' ').trim();
    if ((!allowEmpty && !text) || text.length > maxLength) throw new OrdinaryClientError('ORDINARY_TEXT_LENGTH_INVALID', `${label}长度无效`);
    if (text && CONTACT_PATTERN.test(text)) throw new OrdinaryClientError('ORDINARY_CONTACT_INFO_FORBIDDEN', `${label}不能包含链接、邮箱或联系方式`);
    return text;
  }

  function normalizePlayableNamePayload(value) {
    const raw = isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'name') ? value.name : value;
    return Object.freeze({ name: normalizeHumanText(raw, '陪玩名字', 30) });
  }

  function normalizeDiscount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0.8 || number > 1) throw new OrdinaryClientError('INVALID_BOSS_DISCOUNT', '老板折数必须在0.8至1之间');
    const rounded = Math.round(number * 10000) / 10000;
    if (Math.abs(rounded - number) > 1e-10) throw new OrdinaryClientError('INVALID_BOSS_DISCOUNT', '老板折数最多保留4位小数');
    return rounded;
  }

  function normalizeBossProfilePayload(value) {
    if (!isPlainObject(value)) throw new OrdinaryClientError('INVALID_BOSS_PROFILE_FIELDS', '老板资料必须是对象');
    const bossName = value.bossName ?? value.name;
    return Object.freeze({
      bossName: normalizeHumanText(bossName, '老板名', 30),
      paiDan: normalizeHumanText(value.paiDan, '直属/派单', 30, { allowEmpty: true }),
      discount: normalizeDiscount(value.discount),
    });
  }

  function assertScope(groupId, libraryId) {
    const group = String(groupId || '').trim().toLowerCase();
    const library = String(libraryId || '').trim().toLowerCase();
    if (!GROUP_ID_PATTERN.test(group) || !LIBRARY_ID_PATTERN.test(library)) throw new OrdinaryClientError('INVALID_PUBLIC_SCOPE', '普通共享作用域无效');
    return { groupId: group, libraryId: library };
  }

  async function deriveBossId(groupId, bossName) {
    const scope = assertScope(groupId, 'lib_fixture');
    const normalizedBossName = normalizeHumanText(bossName, '老板名', 30).toLocaleLowerCase('und');
    return `boss_v1_${await sha256Base64Url(canonicalize({ schemaVersion: 1, groupId: scope.groupId, normalizedBossName }))}`;
  }

  async function computeOrdinaryHashes(groupId, libraryId, dataType, rawPayload) {
    const scope = assertScope(groupId, libraryId);
    const type = String(dataType || '').trim().toLowerCase();
    if (!ORDINARY_TYPES.has(type)) throw new OrdinaryClientError('UNSUPPORTED_ORDINARY_DATA_TYPE', '普通共享类型不受支持');
    const payload = type === 'playable_name' ? normalizePlayableNamePayload(rawPayload) : normalizeBossProfilePayload(rawPayload);
    const bossId = type === 'boss_profile' ? await deriveBossId(scope.groupId, payload.bossName) : null;
    const identity = type === 'playable_name'
      ? { groupId: scope.groupId, normalizedName: payload.name.toLocaleLowerCase('und'), dataType: type }
      : { groupId: scope.groupId, bossId, dataType: type };
    const content = { schemaVersion: 1, payloadSchemaVersion: 1, groupId: scope.groupId, bossId, dataType: type, operation: 'upsert', payload };
    return Object.freeze({
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      bossId,
      dataType: type,
      payload,
      businessKey: `bk_v1_${await sha256Base64Url(canonicalize(identity))}`,
      contentHash: `ch_v1_${await sha256Base64Url(canonicalize(content))}`,
    });
  }

  async function buildOrdinarySubmission({ deviceId, submissionId, groupId, libraryId, dataType, payload, origin = 'user', clientCreatedAt = Date.now(), appVersion = APP_VERSION } = {}) {
    if (!DEVICE_ID_PATTERN.test(String(deviceId || '')) || !SUBMISSION_ID_PATTERN.test(String(submissionId || ''))) {
      throw new OrdinaryClientError('INVALID_SUBMISSION_IDENTITY', '普通共享设备或提交ID无效');
    }
    if (!baseSubmission?.buildIdempotencyKey) throw new OrdinaryClientError('SUBMISSION_MODULE_REQUIRED', '提交客户端模块不可用');
    const hashes = await computeOrdinaryHashes(groupId, libraryId, dataType, payload);
    const idempotencyKey = await baseSubmission.buildIdempotencyKey(deviceId, submissionId, canonicalize);
    return Object.freeze({
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      submissionId,
      deviceId,
      groupId: hashes.groupId,
      libraryId: hashes.libraryId,
      bossId: hashes.bossId,
      dataType: hashes.dataType,
      operation: 'upsert',
      origin,
      clientCreatedAt: Math.max(0, Math.floor(Number(clientCreatedAt) || 0)),
      businessKey: hashes.businessKey,
      contentHash: hashes.contentHash,
      idempotencyKey,
      payload: hashes.payload,
      clientContext: Object.freeze({ appVersion, projectionSpecVersion: 1, queueSchemaVersion: 1 }),
    });
  }

  async function planInitialOrdinarySubmissions({ deviceId, groupId, libraryId, confirmedNames = [], bossMemory = [], baseHashes = {}, submissionIdFactory, now = () => Date.now(), appVersion = APP_VERSION } = {}) {
    if (typeof submissionIdFactory !== 'function') throw new OrdinaryClientError('SUBMISSION_ID_FACTORY_REQUIRED', '提交ID生成器不可用');
    const submissions = [];
    const skipped = { alreadyPublic: 0, duplicate: 0, invalid: 0 };
    const seen = new Set();
    const candidates = [
      ...(Array.isArray(confirmedNames) ? confirmedNames : []).map(item => ({ dataType: 'playable_name', payload: { name: item?.name ?? item } })),
      ...(Array.isArray(bossMemory) ? bossMemory : []).map(item => ({ dataType: 'boss_profile', payload: { bossName: item?.name ?? item?.bossName, paiDan: item?.paiDan, discount: item?.discount } })),
    ];
    for (const candidate of candidates) {
      try {
        const hashes = await computeOrdinaryHashes(groupId, libraryId, candidate.dataType, candidate.payload);
        if (seen.has(hashes.businessKey)) { skipped.duplicate += 1; continue; }
        seen.add(hashes.businessKey);
        if (baseHashes?.[hashes.businessKey] === hashes.contentHash) { skipped.alreadyPublic += 1; continue; }
        submissions.push(await buildOrdinarySubmission({
          deviceId,
          submissionId: submissionIdFactory(),
          groupId,
          libraryId,
          dataType: candidate.dataType,
          payload: hashes.payload,
          origin: 'initialBinding',
          clientCreatedAt: now(),
          appVersion,
        }));
      } catch (_) { skipped.invalid += 1; }
    }
    return Object.freeze({ submissions: Object.freeze(submissions), skipped: Object.freeze(skipped) });
  }

  function normalizeRemoteRecord(value) {
    if (!exactKeys(value, ['approvedVersion', 'businessKey', 'contentHash', 'dataType', 'operation', 'payload'])) throw new OrdinaryClientError('INVALID_SNAPSHOT_RECORD_FIELDS', '公共普通记录字段无效');
    if (!ORDINARY_TYPES.has(value.dataType) || value.operation !== 'upsert') throw new OrdinaryClientError('UNSUPPORTED_SNAPSHOT_RECORD', '公共普通记录类型不受支持');
    if (!BUSINESS_KEY_PATTERN.test(value.businessKey) || !CONTENT_HASH_PATTERN.test(value.contentHash)) throw new OrdinaryClientError('INVALID_SNAPSHOT_HASH', '公共普通记录Hash无效');
    if (!Number.isInteger(value.approvedVersion) || value.approvedVersion < 1) throw new OrdinaryClientError('INVALID_APPROVED_VERSION', '公共普通记录版本无效');
    const payload = value.dataType === 'playable_name' ? normalizePlayableNamePayload(value.payload) : normalizeBossProfilePayload(value.payload);
    return Object.freeze({ ...value, payload });
  }

  async function verifyOrdinaryRecords(groupId, libraryId, records = []) {
    const verified = [];
    for (const raw of Array.isArray(records) ? records : []) {
      if (!ORDINARY_TYPES.has(raw?.dataType)) continue;
      const record = normalizeRemoteRecord(raw);
      const hashes = await computeOrdinaryHashes(groupId, libraryId, record.dataType, record.payload);
      if (hashes.businessKey !== record.businessKey || hashes.contentHash !== record.contentHash) {
        throw new OrdinaryClientError('SNAPSHOT_HASH_MISMATCH', '公共普通记录Hash校验失败', { businessKey: record.businessKey });
      }
      verified.push(record);
    }
    return Object.freeze(verified);
  }

  function conflictId(businessKey, localHash, remoteHash) {
    return `conf_${businessKey.slice(-12)}_${String(localHash || 'none').slice(-8)}_${String(remoteHash || 'none').slice(-8)}`.slice(0, 80);
  }

  async function projectLocalOrdinary(groupId, libraryId, confirmedNames = [], bossMemory = []) {
    const map = new Map();
    for (const item of Array.isArray(confirmedNames) ? confirmedNames : []) {
      try {
        const hashes = await computeOrdinaryHashes(groupId, libraryId, 'playable_name', { name: item?.name ?? item });
        if (!map.has(hashes.businessKey)) map.set(hashes.businessKey, Object.freeze({ ...hashes, local: item }));
      } catch (_) {}
    }
    for (const item of Array.isArray(bossMemory) ? bossMemory : []) {
      try {
        const hashes = await computeOrdinaryHashes(groupId, libraryId, 'boss_profile', { bossName: item?.name ?? item?.bossName, paiDan: item?.paiDan, discount: item?.discount });
        if (!map.has(hashes.businessKey)) map.set(hashes.businessKey, Object.freeze({ ...hashes, local: item }));
      } catch (_) {}
    }
    return map;
  }

  async function planOrdinaryMerge({ groupId, libraryId, records = [], confirmedNames = [], bossMemory = [], baseHashes = {} } = {}) {
    const verified = await verifyOrdinaryRecords(groupId, libraryId, records);
    const localMap = await projectLocalOrdinary(groupId, libraryId, confirmedNames, bossMemory);
    const nextBaseHashes = { ...(isPlainObject(baseHashes) ? baseHashes : {}) };
    const result = { upserts: [], unchanged: [], preserveLocal: [], conflicts: [], nextBaseHashes };
    for (const record of verified) {
      const local = localMap.get(record.businessKey) || null;
      const localHash = local?.contentHash || null;
      const baseHash = typeof baseHashes?.[record.businessKey] === 'string' ? baseHashes[record.businessKey] : null;
      const remoteHash = record.contentHash;
      if (localHash === remoteHash) {
        result.unchanged.push({ record, local, baseHash, localHash, remoteHash });
        nextBaseHashes[record.businessKey] = remoteHash;
      } else if (baseHash === null && localHash === null) {
        result.upserts.push({ record, local: null, baseHash, localHash, remoteHash });
        nextBaseHashes[record.businessKey] = remoteHash;
      } else if (baseHash !== null && localHash === baseHash) {
        result.upserts.push({ record, local, baseHash, localHash, remoteHash });
        nextBaseHashes[record.businessKey] = remoteHash;
      } else if (baseHash !== null && remoteHash === baseHash) {
        result.preserveLocal.push({ record, local, baseHash, localHash, remoteHash });
      } else {
        result.conflicts.push({
          conflictId: conflictId(record.businessKey, localHash, remoteHash),
          businessKey: record.businessKey,
          dataType: record.dataType,
          baseHash,
          localHash,
          remoteHash,
          status: 'open',
          record,
        });
      }
    }
    return Object.freeze({
      records: verified,
      ...result,
      counts: Object.freeze({ upserts: result.upserts.length, unchanged: result.unchanged.length, preserveLocal: result.preserveLocal.length, conflicts: result.conflicts.length }),
    });
  }

  function applyOrdinaryMergePlan({ confirmedNames = [], bossMemory = [], plan, now = Date.now() } = {}) {
    const names = Array.isArray(confirmedNames) ? confirmedNames.map(item => ({ ...item })) : [];
    const bosses = Array.isArray(bossMemory) ? bossMemory.map(item => ({ ...item })) : [];
    let namesChanged = false;
    let bossesChanged = false;
    for (const entry of plan?.upserts || []) {
      const record = entry.record;
      if (record.dataType === 'playable_name') {
        const key = record.payload.name.toLocaleLowerCase('und');
        const index = names.findIndex(item => String(item?.name || '').trim().toLocaleLowerCase('und') === key);
        const next = { name: record.payload.name, original: record.payload.name, timestamp: now, source: 'cloudPull' };
        if (index >= 0) names[index] = next; else names.push(next);
        namesChanged = true;
      } else if (record.dataType === 'boss_profile') {
        const key = record.payload.bossName.toLocaleLowerCase('und');
        const index = bosses.findIndex(item => String(item?.name || '').trim().toLocaleLowerCase('und') === key);
        const next = { name: record.payload.bossName, paiDan: record.payload.paiDan, discount: record.payload.discount };
        if (index >= 0) bosses[index] = next; else bosses.push(next);
        bossesChanged = true;
      }
    }
    return Object.freeze({ confirmedNames: Object.freeze(names), bossMemory: Object.freeze(bosses), namesChanged, bossesChanged });
  }

  function isPreviewOrdinarySubmissionScope(submission) {
    return submission?.groupId === baseSubmission?.PREVIEW_ALLOWED_GROUP_ID
      && submission?.libraryId === baseSubmission?.PREVIEW_ALLOWED_LIBRARY_ID
      && ['exact_price', 'playable_name', 'boss_profile'].includes(submission?.dataType)
      && submission?.operation === 'upsert';
  }

  class OrdinarySubmissionDispatcher {
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
      try {
        return Boolean(this.bindingStore?.list?.().some(binding => binding?.mode === 'collaborate'
          && binding.groupId === submission?.groupId && binding.libraryId === submission?.libraryId));
      } catch (_) { return false; }
    }
    async ensureCredential() {
      const current = this.credentialStore?.getValid?.(this.now());
      if (current) return current;
      const previous = this.credentialStore?.loadResult?.();
      if (previous?.ok && previous?.exists) this.credentialStore.clear();
      const meta = this.metaStore?.loadResult?.();
      if (!meta?.ok || !meta?.exists || !meta.value?.deviceId) throw new OrdinaryClientError('DEVICE_IDENTITY_REQUIRED', '请先创建云协作身份');
      const data = await this.apiClient.registerDevice({ deviceId: meta.value.deviceId, nickname: meta.value.nickname, appVersion: this.appVersion });
      if (!data?.deviceToken || data.deviceId !== meta.value.deviceId) throw new OrdinaryClientError('INVALID_REGISTRATION_RESPONSE', '设备注册响应无效');
      return this.credentialStore.save({ schemaVersion: 1, deviceId: data.deviceId, deviceToken: data.deviceToken, issuedAt: data.issuedAt, expiresAt: data.expiresAt, tokenVersion: data.tokenVersion });
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
      if (typeof this.apiClient.hasWriteAccess === 'function' && !this.apiClient.hasWriteAccess()) return { ...summary, status: 'write_gate_closed', errorCode: 'WRITE_GATE_CLOSED', category: 'write_gate' };
      const dueAll = this.queueStore.getDue(this.now(), Math.max(1, Math.min(20, Number(limit) || 10)));
      const due = [];
      for (const item of dueAll) {
        const submission = item?.submission;
        if (!isPreviewOrdinarySubmissionScope(submission)) {
          this.queueStore.markBlocked(submission.submissionId, 'PREVIEW_SCOPE_CLIENT_BLOCKED');
          summary.blocked += 1;
          summary.errorCode = 'PREVIEW_SCOPE_CLIENT_BLOCKED';
          summary.category = 'forbidden';
        } else if (!this.hasCollaborativeBinding(submission)) summary.skippedMode += 1;
        else due.push(item);
      }
      if (!due.length) {
        summary.remaining = this.queueStore.list().filter(item => item.deliveryState !== 'acknowledged').length;
        summary.status = summary.blocked ? 'completed_with_blocked' : 'no_collaborative_due';
        this.emit(summary);
        return summary;
      }
      let credential;
      try { credential = await this.ensureCredential(); }
      catch (error) {
        const retryable = Boolean(error?.retryable);
        if (!retryable) for (const item of due) { try { this.queueStore.markBlocked(item.submission.submissionId, error.code || 'DEVICE_REGISTRATION_BLOCKED'); summary.blocked += 1; } catch (_) {} }
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
          if (error.category === 'credential') { try { this.credentialStore.clear(); } catch (_) {} this.queueStore.markBlocked(id, result.errorCode); result.blocked += 1; break; }
          if (error.category === 'write_gate' || error.category === 'service_disabled') { this.queueStore.markBlocked(id, result.errorCode); result.blocked += 1; break; }
          if (error.retryable) { this.queueStore.markRetry(id, result.errorCode); result.retryWait += 1; break; }
          this.queueStore.markBlocked(id, result.errorCode); result.blocked += 1;
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
    OrdinaryClientError,
    normalizePlayableNamePayload,
    normalizeBossProfilePayload,
    deriveBossId,
    computeOrdinaryHashes,
    buildOrdinarySubmission,
    planInitialOrdinarySubmissions,
    verifyOrdinaryRecords,
    planOrdinaryMerge,
    applyOrdinaryMergePlan,
    isPreviewOrdinarySubmissionScope,
    OrdinarySubmissionDispatcher,
  });
});