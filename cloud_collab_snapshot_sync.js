(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSnapshotSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const SNAPSHOT_SCHEMA_VERSION = 1;
  const PAYLOAD_SCHEMA_VERSION = 1;
  const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
  const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
  const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{2,47}$/;
  const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_-]{2,53}$/;

  class SnapshotSyncError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '公共快照处理失败');
      this.name = 'SnapshotSyncError';
      this.code = code || 'SNAPSHOT_SYNC_ERROR';
      this.details = details;
    }
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const tag = Object.prototype.toString.call(value);
    return tag === '[object Object]';
  }

  function exactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function canonicalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SnapshotSyncError('INVALID_CANONICAL_NUMBER', '规范对象含无效数字');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (!isPlainObject(value)) throw new SnapshotSyncError('INVALID_CANONICAL_VALUE', '规范对象含不支持的值');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }

  function normalizeText(value, maxLength = 50) {
    let text = String(value ?? '');
    try { text = text.normalize('NFKC'); } catch (_) {}
    text = text.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > maxLength) throw new SnapshotSyncError('INVALID_SERVICE_NAME', '公共价格服务名称无效');
    return text;
  }

  function normalizePrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 1000000) throw new SnapshotSyncError('INVALID_UNIT_PRICE', '公共价格数值无效');
    const rounded = Math.round(number * 1000) / 1000;
    if (Math.abs(rounded - number) > 1e-9) throw new SnapshotSyncError('INVALID_UNIT_PRICE', '公共价格最多保留3位小数');
    return rounded;
  }

  function normalizeExactPricePayload(value) {
    if (!exactKeys(value, ['serviceName', 'settleType', 'unitPrice'])) throw new SnapshotSyncError('INVALID_EXACT_PRICE_FIELDS', '公共精确价格字段无效');
    const settleType = String(value.settleType || '').trim().toLowerCase();
    if (!['round', 'hour'].includes(settleType)) throw new SnapshotSyncError('INVALID_SETTLE_TYPE', '公共价格结算方式无效');
    return { serviceName: normalizeText(value.serviceName), settleType, unitPrice: normalizePrice(value.unitPrice) };
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new SnapshotSyncError('BASE64_UNAVAILABLE', '当前环境无法生成公共数据Hash');
  }

  const SHA256_K = Object.freeze([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
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
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,hh] = h;
      for (let i = 0; i < 64; i++) {
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
    if (typeof TextEncoder !== 'function') throw new SnapshotSyncError('TEXT_ENCODER_UNAVAILABLE', '当前环境无法编码公共数据Hash');
    const bytes = new TextEncoder().encode(value);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      try { return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', bytes))); }
      catch (_) {}
    }
    return toBase64Url(sha256Fallback(bytes));
  }

  function buildExactPriceIdentity(groupId, libraryId, payload) {
    return {
      groupId,
      libraryId,
      normalizedServiceName: payload.serviceName.toLowerCase(),
      ruleType: 'exact',
      settleType: payload.settleType,
      variant: 'standard',
    };
  }

  function buildExactPriceContent(groupId, libraryId, payload, operation = 'upsert') {
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      groupId,
      libraryId,
      bossId: null,
      dataType: 'exact_price',
      operation,
      payload: operation === 'delete' ? null : payload,
    };
  }

  async function computeExactPriceHashes(groupId, libraryId, rawPayload) {
    const payload = normalizeExactPricePayload(rawPayload);
    if (!GROUP_ID_PATTERN.test(groupId) || !LIBRARY_ID_PATTERN.test(libraryId)) throw new SnapshotSyncError('INVALID_PUBLIC_SCOPE', '公共价格作用域无效');
    const businessKey = `bk_v1_${await sha256Base64Url(canonicalize(buildExactPriceIdentity(groupId, libraryId, payload)))}`;
    const contentHash = `ch_v1_${await sha256Base64Url(canonicalize(buildExactPriceContent(groupId, libraryId, payload)))}`;
    return { payload, businessKey, contentHash };
  }

  function localMatchKey(payload) {
    const normalized = normalizeExactPricePayload(payload);
    return `${normalized.serviceName.toLowerCase()}\u0000${normalized.settleType}`;
  }

  function normalizeRemoteRecord(value) {
    if (!exactKeys(value, ['approvedVersion', 'businessKey', 'contentHash', 'dataType', 'operation', 'payload'])) throw new SnapshotSyncError('INVALID_SNAPSHOT_RECORD_FIELDS', '公共快照记录字段无效');
    if (value.dataType !== 'exact_price' || value.operation !== 'upsert') throw new SnapshotSyncError('UNSUPPORTED_SNAPSHOT_RECORD', '当前客户端只支持接收普通精确价格');
    if (!BUSINESS_KEY_PATTERN.test(value.businessKey) || !CONTENT_HASH_PATTERN.test(value.contentHash)) throw new SnapshotSyncError('INVALID_SNAPSHOT_HASH', '公共快照记录Hash无效');
    if (!Number.isInteger(value.approvedVersion) || value.approvedVersion < 1) throw new SnapshotSyncError('INVALID_APPROVED_VERSION', '公共记录版本无效');
    return { ...value, payload: normalizeExactPricePayload(value.payload) };
  }

  function normalizeTombstone(value) {
    if (!exactKeys(value, ['approvedVersion', 'businessKey', 'dataType', 'identity'])) throw new SnapshotSyncError('INVALID_TOMBSTONE_FIELDS', '公共删除标记字段无效');
    if (value.dataType !== 'exact_price' || !BUSINESS_KEY_PATTERN.test(value.businessKey)) throw new SnapshotSyncError('INVALID_TOMBSTONE', '公共删除标记无效');
    const identity = normalizeExactPricePayload({ serviceName: value.identity?.serviceName, settleType: value.identity?.settleType, unitPrice: 1 });
    return { ...value, identity: { serviceName: identity.serviceName, settleType: identity.settleType } };
  }

  function normalizeSnapshot(value) {
    if (!exactKeys(value, ['cursor', 'generatedAt', 'groupId', 'libraryId', 'payloadSchemaVersion', 'publicVersion', 'records', 'schemaVersion', 'snapshotVersion', 'tombstones'])) {
      throw new SnapshotSyncError('INVALID_SNAPSHOT_FIELDS', '公共快照顶层字段无效');
    }
    if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || value.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) throw new SnapshotSyncError('UNSUPPORTED_SNAPSHOT_SCHEMA', '公共快照版本不兼容');
    const groupId = String(value.groupId || '').trim().toLowerCase();
    const libraryId = String(value.libraryId || '').trim().toLowerCase();
    if (!GROUP_ID_PATTERN.test(groupId) || !LIBRARY_ID_PATTERN.test(libraryId)) throw new SnapshotSyncError('INVALID_PUBLIC_SCOPE', '公共快照作用域无效');
    if (!Number.isInteger(value.publicVersion) || value.publicVersion < 0 || !Number.isInteger(value.snapshotVersion) || value.snapshotVersion < 0 || value.snapshotVersion > value.publicVersion) throw new SnapshotSyncError('INVALID_SNAPSHOT_VERSION', '公共快照版本无效');
    if (!Array.isArray(value.records) || !Array.isArray(value.tombstones) || value.records.length + value.tombstones.length > 5000) throw new SnapshotSyncError('SNAPSHOT_RECORD_LIMIT', '公共快照记录数量无效');
    const records = value.records.map(normalizeRemoteRecord);
    const tombstones = value.tombstones.map(normalizeTombstone);
    const keys = new Set();
    [...records, ...tombstones].forEach(item => {
      if (keys.has(item.businessKey)) throw new SnapshotSyncError('DUPLICATE_SNAPSHOT_KEY', '公共快照含重复业务键');
      keys.add(item.businessKey);
    });
    return {
      schemaVersion: value.schemaVersion,
      payloadSchemaVersion: value.payloadSchemaVersion,
      groupId, libraryId,
      publicVersion: value.publicVersion,
      snapshotVersion: value.snapshotVersion,
      cursor: value.cursor === null ? null : String(value.cursor || '').slice(0, 256),
      generatedAt: String(value.generatedAt || ''),
      records, tombstones,
    };
  }

  async function verifySnapshot(rawSnapshot) {
    const snapshot = normalizeSnapshot(rawSnapshot);
    for (const record of snapshot.records) {
      const computed = await computeExactPriceHashes(snapshot.groupId, snapshot.libraryId, record.payload);
      if (computed.businessKey !== record.businessKey || computed.contentHash !== record.contentHash) {
        throw new SnapshotSyncError('SNAPSHOT_HASH_MISMATCH', '公共快照记录Hash校验失败', { businessKey: record.businessKey });
      }
    }
    for (const tombstone of snapshot.tombstones) {
      const computed = await computeExactPriceHashes(snapshot.groupId, snapshot.libraryId, { ...tombstone.identity, unitPrice: 1 });
      if (computed.businessKey !== tombstone.businessKey) throw new SnapshotSyncError('SNAPSHOT_HASH_MISMATCH', '公共删除标记业务键校验失败');
    }
    return snapshot;
  }

  async function projectLocalItems(groupId, libraryId, localItems) {
    const projected = [];
    for (let index = 0; index < (Array.isArray(localItems) ? localItems : []).length; index++) {
      const item = localItems[index];
      const payload = normalizeExactPricePayload({ serviceName: item?.serviceType, settleType: item?.settleType, unitPrice: item?.unitPrice });
      const hashes = await computeExactPriceHashes(groupId, libraryId, payload);
      projected.push({ index, item, payload, matchKey: localMatchKey(payload), ...hashes });
    }
    return projected;
  }

  function conflictId(businessKey, localHash, remoteHash) {
    return `conf_${businessKey.slice(-12)}_${String(localHash || 'none').slice(-8)}_${String(remoteHash || 'delete').slice(-8)}`.slice(0, 80);
  }

  async function planExactPriceMerge({ snapshot: rawSnapshot, localItems = [], baseHashes = {} } = {}) {
    const snapshot = await verifySnapshot(rawSnapshot);
    if (!isPlainObject(baseHashes)) throw new SnapshotSyncError('INVALID_BASE_HASHES', '本地基础Hash结构无效');
    const localProjected = await projectLocalItems(snapshot.groupId, snapshot.libraryId, localItems);
    const localMap = new Map(localProjected.map(item => [item.matchKey, item]));
    const nextBaseHashes = { ...baseHashes };
    const result = { upserts: [], deletes: [], unchanged: [], preserveLocal: [], conflicts: [], nextBaseHashes };

    for (const record of snapshot.records) {
      const key = localMatchKey(record.payload);
      const local = localMap.get(key) || null;
      const localHash = local?.contentHash || null;
      const baseHash = typeof baseHashes[record.businessKey] === 'string' ? baseHashes[record.businessKey] : null;
      const remoteHash = record.contentHash;
      if (localHash === remoteHash) {
        result.unchanged.push({ record, local, baseHash, localHash, remoteHash });
        nextBaseHashes[record.businessKey] = remoteHash;
      } else if (baseHash === null) {
        if (localHash === null) {
          result.upserts.push({ record, local: null, baseHash, localHash, remoteHash });
          nextBaseHashes[record.businessKey] = remoteHash;
        } else {
          result.conflicts.push({ conflictId: conflictId(record.businessKey, localHash, remoteHash), businessKey: record.businessKey, dataType: 'exact_price', baseHash, localHash, remoteHash, status: 'open', record });
        }
      } else if (localHash === baseHash) {
        result.upserts.push({ record, local, baseHash, localHash, remoteHash });
        nextBaseHashes[record.businessKey] = remoteHash;
      } else if (remoteHash === baseHash) {
        result.preserveLocal.push({ record, local, baseHash, localHash, remoteHash });
      } else {
        result.conflicts.push({ conflictId: conflictId(record.businessKey, localHash, remoteHash), businessKey: record.businessKey, dataType: 'exact_price', baseHash, localHash, remoteHash, status: 'open', record });
      }
    }

    for (const tombstone of snapshot.tombstones) {
      const key = localMatchKey({ ...tombstone.identity, unitPrice: 1 });
      const local = localMap.get(key) || null;
      const localHash = local?.contentHash || null;
      const baseHash = typeof baseHashes[tombstone.businessKey] === 'string' ? baseHashes[tombstone.businessKey] : null;
      if (!local) {
        result.unchanged.push({ tombstone, local: null, baseHash, localHash: null, remoteHash: null });
        delete nextBaseHashes[tombstone.businessKey];
      } else if (baseHash !== null && localHash === baseHash) {
        result.deletes.push({ tombstone, local, baseHash, localHash, remoteHash: null });
        delete nextBaseHashes[tombstone.businessKey];
      } else {
        result.conflicts.push({ conflictId: conflictId(tombstone.businessKey, localHash, null), businessKey: tombstone.businessKey, dataType: 'exact_price', baseHash, localHash, remoteHash: null, status: 'open', tombstone });
      }
    }

    return { snapshot, ...result, counts: {
      upserts: result.upserts.length,
      deletes: result.deletes.length,
      unchanged: result.unchanged.length,
      preserveLocal: result.preserveLocal.length,
      conflicts: result.conflicts.length,
    } };
  }

  return Object.freeze({
    SNAPSHOT_SCHEMA_VERSION,
    PAYLOAD_SCHEMA_VERSION,
    SnapshotSyncError,
    canonicalize,
    normalizeExactPricePayload,
    computeExactPriceHashes,
    normalizeSnapshot,
    verifySnapshot,
    planExactPriceMerge,
    localMatchKey,
  });
});
