(function(root, factory) {
  const api = factory(root?.CloudCollabSensitiveRules || null, root?.CloudCollabOrdinaryTypes || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSensitiveMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(sensitiveRules, ordinaryTypes) {
  'use strict';

  const RULE_TYPES = new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule']);
  const TOMBSTONE_TYPES = new Set(['playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule']);
  const DEVICE = 'dev_01JABCDEF0123456789XYZABCD';
  const SUBMISSION = 'sub_01JABCDEF0123456789XYZABCD';

  class SensitiveMergeError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '敏感公共数据合并失败');
      this.name = 'SensitiveMergeError';
      this.code = code || 'SENSITIVE_MERGE_ERROR';
      this.details = details;
    }
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function lower(value) { return String(value || '').trim().toLocaleLowerCase('und'); }

  function rangePayload(rule) {
    return {
      rangeLabel: rule?.rangeLabel,
      alias: rule?.alias || '',
      rankType: rule?.rankType,
      minStar: rule?.rankType === 'star' ? Number(rule?.minStar) : null,
      maxStar: rule?.rankType === 'star' ? Number(rule?.maxStar) : null,
      namedRanks: rule?.rankType === 'star' ? [] : [...(rule?.namedRanks || [])],
      prices: {
        normal: { round: rule?.prices?.normal?.round ?? null, hour: rule?.prices?.normal?.hour ?? null },
        carry: { round: rule?.prices?.carry?.round ?? null, hour: rule?.prices?.carry?.hour ?? null },
        starGuarantee: { round: rule?.prices?.starGuarantee?.round ?? null, hour: rule?.prices?.starGuarantee?.hour ?? null },
      },
    };
  }

  function surchargePayload(rule) {
    return {
      name: rule?.name,
      keywords: [...(rule?.keywords || [])],
      prices: { round: rule?.prices?.round ?? null, hour: rule?.prices?.hour ?? null },
      enabled: rule?.enabled !== false,
    };
  }

  function giftPayload(item) {
    return { serviceName: item?.serviceType ?? item?.serviceName, mode: item?.mode, unitPrice: item?.mode === 'fixed' ? item?.unitPrice : null };
  }

  function localRuleInput(dataType, item) {
    if (dataType === 'rank_range_rule') return rangePayload(item);
    if (dataType === 'surcharge_rule') return surchargePayload(item);
    if (dataType === 'gift_rule') return giftPayload(item);
    throw new SensitiveMergeError('UNSUPPORTED_LOCAL_RULE_TYPE', '本地敏感规则类型不受支持');
  }

  async function buildRuleLocalRecord(groupId, libraryId, dataType, item) {
    const submission = await sensitiveRules.buildSensitiveSubmission({
      deviceId: DEVICE,
      submissionId: SUBMISSION,
      groupId,
      libraryId,
      dataType,
      payload: localRuleInput(dataType, item),
      origin: 'user',
      clientCreatedAt: 0,
    });
    return { businessKey: submission.businessKey, contentHash: submission.contentHash, dataType, item };
  }

  async function buildPlayableLocalRecord(groupId, libraryId, item) {
    const submission = await ordinaryTypes.buildOrdinarySubmission({
      deviceId: DEVICE, submissionId: SUBMISSION, groupId, libraryId,
      dataType: 'playable_name', payload: { name: item?.name }, origin: 'user', clientCreatedAt: 0,
    });
    return { businessKey: submission.businessKey, contentHash: submission.contentHash, dataType: 'playable_name', item };
  }

  async function buildBossLocalRecord(groupId, libraryId, item) {
    const submission = await ordinaryTypes.buildOrdinarySubmission({
      deviceId: DEVICE, submissionId: SUBMISSION, groupId, libraryId,
      dataType: 'boss_profile',
      payload: { bossName: item?.name ?? item?.bossName, paiDan: item?.paiDan, discount: item?.discount },
      origin: 'user', clientCreatedAt: 0,
    });
    return { businessKey: submission.businessKey, contentHash: submission.contentHash, dataType: 'boss_profile', item };
  }

  async function buildLocalMaps({ groupId, libraryId, confirmedNames, bossMemory, rangeRules, surcharges, gifts }) {
    const maps = new Map();
    async function add(recordPromise) {
      try { const record = await recordPromise; if (!maps.has(record.businessKey)) maps.set(record.businessKey, record); }
      catch (_) {}
    }
    for (const item of confirmedNames || []) await add(buildPlayableLocalRecord(groupId, libraryId, item));
    for (const item of bossMemory || []) await add(buildBossLocalRecord(groupId, libraryId, item));
    for (const item of rangeRules || []) await add(buildRuleLocalRecord(groupId, libraryId, 'rank_range_rule', item));
    for (const item of surcharges || []) await add(buildRuleLocalRecord(groupId, libraryId, 'surcharge_rule', item));
    for (const item of gifts || []) await add(buildRuleLocalRecord(groupId, libraryId, 'gift_rule', item));
    return maps;
  }

  function conflictId(item, baseHash, localHash) {
    return `sensitive:${item.businessKey}:${baseHash || 'none'}:${localHash || 'none'}:${item.contentHash}`;
  }

  function assertRemoteItem(item, operation) {
    if (!item || typeof item !== 'object' || !TOMBSTONE_TYPES.has(item.dataType)
        || item.operation !== operation || typeof item.businessKey !== 'string'
        || typeof item.contentHash !== 'string' || !Number.isSafeInteger(item.approvedVersion)) {
      throw new SensitiveMergeError('INVALID_SENSITIVE_REMOTE_ITEM', '公共敏感记录或墓碑无效');
    }
    if (operation === 'upsert' && !RULE_TYPES.has(item.dataType)) {
      throw new SensitiveMergeError('UNSUPPORTED_SENSITIVE_REMOTE_RECORD', '敏感规则记录类型不受支持');
    }
  }

  export const placeholder = null;

  async function planSensitiveMerge({
    groupId,
    libraryId,
    records = [],
    tombstones = [],
    confirmedNames = [],
    bossMemory = [],
    rangeRules = [],
    surcharges = [],
    gifts = [],
    baseHashes = {},
  } = {}) {
    if (!sensitiveRules?.buildSensitiveSubmission || !ordinaryTypes?.buildOrdinarySubmission) {
      throw new SensitiveMergeError('SENSITIVE_MERGE_MODULE_REQUIRED', '敏感合并依赖模块不可用');
    }
    for (const item of records) assertRemoteItem(item, 'upsert');
    for (const item of tombstones) assertRemoteItem(item, 'delete');
    const local = await buildLocalMaps({ groupId, libraryId, confirmedNames, bossMemory, rangeRules, surcharges, gifts });
    const operations = [];
    const conflicts = [];
    const nextBaseHashes = { ...baseHashes };
    const counts = { upserts: 0, deletes: 0, unchanged: 0, preserveLocal: 0, conflicts: 0 };

    for (const remote of records) {
      const localRecord = local.get(remote.businessKey) || null;
      const baseHash = baseHashes?.[remote.businessKey] || null;
      if (localRecord?.contentHash === remote.contentHash) {
        counts.unchanged += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
        continue;
      }
      if (!localRecord || (baseHash && localRecord.contentHash === baseHash)) {
        operations.push({ action: 'upsert', dataType: remote.dataType, businessKey: remote.businessKey, payload: clone(remote.payload) });
        counts.upserts += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
        continue;
      }
      if (!baseHash) {
        counts.preserveLocal += 1;
      } else {
        counts.conflicts += 1;
        conflicts.push({
          conflictId: conflictId(remote, baseHash, localRecord.contentHash),
          businessKey: remote.businessKey,
          dataType: remote.dataType,
          baseHash,
          localHash: localRecord.contentHash,
          remoteHash: remote.contentHash,
        });
      }
    }

    for (const tombstone of tombstones) {
      const localRecord = local.get(tombstone.businessKey) || null;
      const baseHash = baseHashes?.[tombstone.businessKey] || null;
      if (!localRecord) {
        counts.unchanged += 1;
        nextBaseHashes[tombstone.businessKey] = tombstone.contentHash;
        continue;
      }
      if (baseHash && localRecord.contentHash === baseHash) {
        operations.push({ action: 'delete', dataType: tombstone.dataType, businessKey: tombstone.businessKey, payload: null });
        counts.deletes += 1;
        nextBaseHashes[tombstone.businessKey] = tombstone.contentHash;
        continue;
      }
      if (!baseHash) {
        counts.preserveLocal += 1;
      } else {
        counts.conflicts += 1;
        conflicts.push({
          conflictId: conflictId(tombstone, baseHash, localRecord.contentHash),
          businessKey: tombstone.businessKey,
          dataType: tombstone.dataType,
          baseHash,
          localHash: localRecord.contentHash,
          remoteHash: tombstone.contentHash,
        });
      }
    }

    return Object.freeze({
      records: Object.freeze(records.map(clone)),
      tombstones: Object.freeze(tombstones.map(clone)),
      operations: Object.freeze(operations.map(item => Object.freeze(item))),
      conflicts: Object.freeze(conflicts.map(item => Object.freeze(item))),
      counts: Object.freeze(counts),
      nextBaseHashes: Object.freeze(nextBaseHashes),
    });
  }

  function normalizeCloudRange(payload, old = null) {
    return {
      ...(old || {}),
      kind: 'rankRange',
      rangeLabel: payload.rangeLabel,
      alias: payload.alias,
      rankType: payload.rankType,
      minStar: payload.minStar,
      maxStar: payload.maxStar,
      namedRanks: [...payload.namedRanks],
      prices: clone(payload.prices),
      source: 'cloudPull',
    };
  }

  function normalizeCloudSurcharge(payload, old = null) {
    return {
      ...(old || {}),
      name: payload.name,
      keywords: [...payload.keywords],
      prices: clone(payload.prices),
      enabled: payload.enabled,
      source: 'cloudPull',
    };
  }

  function normalizeCloudGift(payload, old = null) {
    return {
      ...(old || {}),
      serviceType: payload.serviceName,
      mode: payload.mode,
      unitPrice: payload.unitPrice,
      source: 'cloudPull',
    };
  }

  async function applySensitiveMergePlan({
    groupId,
    libraryId,
    confirmedNames = [],
    bossMemory = [],
    rangeRules = [],
    surcharges = [],
    gifts = [],
    plan,
    now = Date.now(),
  } = {}) {
    const names = clone(confirmedNames);
    const bosses = clone(bossMemory);
    const ranges = clone(rangeRules);
    const extras = clone(surcharges);
    const giftList = clone(gifts);
    const local = await buildLocalMaps({ groupId, libraryId, confirmedNames: names, bossMemory: bosses, rangeRules: ranges, surcharges: extras, gifts: giftList });

    function removeByBusiness(list, businessKey) {
      const record = local.get(businessKey);
      if (!record) return false;
      const index = list.indexOf(record.item);
      if (index >= 0) { list.splice(index, 1); return true; }
      const fallback = list.findIndex(item => item?.id && item.id === record.item?.id);
      if (fallback >= 0) { list.splice(fallback, 1); return true; }
      return false;
    }

    for (const operation of plan.operations) {
      const localRecord = local.get(operation.businessKey) || null;
      if (operation.action === 'delete') {
        if (operation.dataType === 'playable_name') removeByBusiness(names, operation.businessKey);
        else if (operation.dataType === 'boss_profile') removeByBusiness(bosses, operation.businessKey);
        else if (operation.dataType === 'rank_range_rule') removeByBusiness(ranges, operation.businessKey);
        else if (operation.dataType === 'surcharge_rule') removeByBusiness(extras, operation.businessKey);
        else if (operation.dataType === 'gift_rule') removeByBusiness(giftList, operation.businessKey);
        continue;
      }
      if (operation.dataType === 'rank_range_rule') {
        const next = normalizeCloudRange(operation.payload, localRecord?.item);
        if (localRecord) Object.assign(localRecord.item, next); else ranges.push({ ...next, id: `cloud_range_${operation.businessKey.slice(-12)}`, createdAt: now, updatedAt: now });
      } else if (operation.dataType === 'surcharge_rule') {
        const next = normalizeCloudSurcharge(operation.payload, localRecord?.item);
        if (localRecord) Object.assign(localRecord.item, next); else extras.unshift({ ...next, id: `cloud_surcharge_${operation.businessKey.slice(-12)}`, createdAt: now, updatedAt: now });
      } else if (operation.dataType === 'gift_rule') {
        const next = normalizeCloudGift(operation.payload, localRecord?.item);
        if (localRecord) Object.assign(localRecord.item, next); else giftList.unshift({ ...next, id: `cloud_gift_${operation.businessKey.slice(-12)}`, usageCount: 1, createdAt: now, updatedAt: now, lastUsed: now });
      }
    }
    return Object.freeze({
      confirmedNames: Object.freeze(names),
      bossMemory: Object.freeze(bosses),
      rangeRules: Object.freeze(ranges),
      surcharges: Object.freeze(extras),
      gifts: Object.freeze(giftList),
      changed: plan.operations.length > 0,
    });
  }

  return Object.freeze({
    SensitiveMergeError,
    planSensitiveMerge,
    applySensitiveMergePlan,
    rangePayload,
    surchargePayload,
    giftPayload,
  });
});
