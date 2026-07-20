(function(root, factory) {
  const api = factory(root?.CloudCollabSensitiveRules || null, root?.CloudCollabOrdinaryTypes || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSensitiveMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(sensitiveRules, ordinaryTypes) {
  'use strict';

  const RULE_TYPES = new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule']);
  const DELETE_TYPES = new Set(['playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule']);
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
    return {
      serviceName: item?.serviceType ?? item?.serviceName,
      mode: item?.mode,
      unitPrice: item?.mode === 'fixed' ? item?.unitPrice : null,
    };
  }

  function payloadFor(dataType, item) {
    if (dataType === 'rank_range_rule') return rangePayload(item);
    if (dataType === 'surcharge_rule') return surchargePayload(item);
    if (dataType === 'gift_rule') return giftPayload(item);
    throw new SensitiveMergeError('UNSUPPORTED_LOCAL_RULE_TYPE', '本地敏感规则类型不受支持');
  }

  async function localRecord(groupId, libraryId, dataType, item) {
    let submission;
    if (RULE_TYPES.has(dataType)) {
      submission = await sensitiveRules.buildSensitiveSubmission({
        deviceId: DEVICE, submissionId: SUBMISSION, groupId, libraryId,
        dataType, payload: payloadFor(dataType, item), origin: 'user', clientCreatedAt: 0,
      });
    } else if (dataType === 'playable_name') {
      submission = await ordinaryTypes.buildOrdinarySubmission({
        deviceId: DEVICE, submissionId: SUBMISSION, groupId, libraryId,
        dataType, payload: { name: item?.name }, origin: 'user', clientCreatedAt: 0,
      });
    } else if (dataType === 'boss_profile') {
      submission = await ordinaryTypes.buildOrdinarySubmission({
        deviceId: DEVICE, submissionId: SUBMISSION, groupId, libraryId,
        dataType, payload: { bossName: item?.name ?? item?.bossName, paiDan: item?.paiDan, discount: item?.discount },
        origin: 'user', clientCreatedAt: 0,
      });
    } else throw new SensitiveMergeError('UNSUPPORTED_LOCAL_DATA_TYPE', '本地公共数据类型不受支持');
    return { businessKey: submission.businessKey, contentHash: submission.contentHash, dataType, item };
  }

  async function buildLocalMap(input) {
    const map = new Map();
    async function add(dataType, item) {
      try {
        const record = await localRecord(input.groupId, input.libraryId, dataType, item);
        if (!map.has(record.businessKey)) map.set(record.businessKey, record);
      } catch (_) {}
    }
    for (const item of input.confirmedNames || []) await add('playable_name', item);
    for (const item of input.bossMemory || []) await add('boss_profile', item);
    for (const item of input.rangeRules || []) await add('rank_range_rule', item);
    for (const item of input.surcharges || []) await add('surcharge_rule', item);
    for (const item of input.gifts || []) await add('gift_rule', item);
    return map;
  }

  function assertRemote(item, operation) {
    if (!item || typeof item !== 'object' || item.operation !== operation
        || typeof item.businessKey !== 'string' || typeof item.contentHash !== 'string'
        || !Number.isSafeInteger(item.approvedVersion)) {
      throw new SensitiveMergeError('INVALID_SENSITIVE_REMOTE_ITEM', '公共敏感记录或墓碑无效');
    }
    if (operation === 'upsert' && !RULE_TYPES.has(item.dataType)) {
      throw new SensitiveMergeError('UNSUPPORTED_SENSITIVE_REMOTE_RECORD', '敏感规则记录类型不受支持');
    }
    if (operation === 'delete' && !DELETE_TYPES.has(item.dataType)) {
      throw new SensitiveMergeError('UNSUPPORTED_SENSITIVE_TOMBSTONE', '敏感墓碑类型不受支持');
    }
  }

  function conflict(item, baseHash, localHash) {
    return Object.freeze({
      conflictId: `sensitive:${item.businessKey}:${baseHash || 'none'}:${localHash || 'none'}:${item.contentHash}`,
      businessKey: item.businessKey,
      dataType: item.dataType,
      baseHash,
      localHash,
      remoteHash: item.contentHash,
    });
  }

  async function planSensitiveMerge({
    groupId, libraryId, records = [], tombstones = [], confirmedNames = [], bossMemory = [],
    rangeRules = [], surcharges = [], gifts = [], baseHashes = {},
  } = {}) {
    if (!sensitiveRules?.buildSensitiveSubmission || !ordinaryTypes?.buildOrdinarySubmission) {
      throw new SensitiveMergeError('SENSITIVE_MERGE_MODULE_REQUIRED', '敏感合并依赖模块不可用');
    }
    records.forEach(item => assertRemote(item, 'upsert'));
    tombstones.forEach(item => assertRemote(item, 'delete'));
    const local = await buildLocalMap({ groupId, libraryId, confirmedNames, bossMemory, rangeRules, surcharges, gifts });
    const operations = [];
    const conflicts = [];
    const nextBaseHashes = { ...baseHashes };
    const counts = { upserts: 0, deletes: 0, unchanged: 0, preserveLocal: 0, conflicts: 0 };

    for (const remote of records) {
      const current = local.get(remote.businessKey) || null;
      const baseHash = baseHashes?.[remote.businessKey] || null;
      if (current?.contentHash === remote.contentHash) {
        counts.unchanged += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
      } else if (!current || (baseHash && current.contentHash === baseHash)) {
        operations.push(Object.freeze({ action: 'upsert', dataType: remote.dataType, businessKey: remote.businessKey, payload: clone(remote.payload) }));
        counts.upserts += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
      } else if (!baseHash) counts.preserveLocal += 1;
      else {
        counts.conflicts += 1;
        conflicts.push(conflict(remote, baseHash, current.contentHash));
      }
    }

    for (const remote of tombstones) {
      const current = local.get(remote.businessKey) || null;
      const baseHash = baseHashes?.[remote.businessKey] || null;
      if (!current) {
        counts.unchanged += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
      } else if (baseHash && current.contentHash === baseHash) {
        operations.push(Object.freeze({ action: 'delete', dataType: remote.dataType, businessKey: remote.businessKey, payload: null }));
        counts.deletes += 1;
        nextBaseHashes[remote.businessKey] = remote.contentHash;
      } else if (!baseHash) counts.preserveLocal += 1;
      else {
        counts.conflicts += 1;
        conflicts.push(conflict(remote, baseHash, current.contentHash));
      }
    }

    return Object.freeze({
      records: Object.freeze(records.map(clone)),
      tombstones: Object.freeze(tombstones.map(clone)),
      operations: Object.freeze(operations),
      conflicts: Object.freeze(conflicts),
      counts: Object.freeze(counts),
      nextBaseHashes: Object.freeze(nextBaseHashes),
    });
  }

  function cloudRange(payload, old, now, key) {
    return { ...(old || {}), id: old?.id || `cloud_range_${key.slice(-12)}`, kind: 'rankRange',
      rangeLabel: payload.rangeLabel, alias: payload.alias, rankType: payload.rankType,
      minStar: payload.minStar, maxStar: payload.maxStar, namedRanks: [...payload.namedRanks],
      prices: clone(payload.prices), source: 'cloudPull', createdAt: old?.createdAt || now, updatedAt: now };
  }
  function cloudSurcharge(payload, old, now, key) {
    return { ...(old || {}), id: old?.id || `cloud_surcharge_${key.slice(-12)}`,
      name: payload.name, keywords: [...payload.keywords], prices: clone(payload.prices), enabled: payload.enabled,
      source: 'cloudPull', createdAt: old?.createdAt || now, updatedAt: now };
  }
  function cloudGift(payload, old, now, key) {
    return { ...(old || {}), id: old?.id || `cloud_gift_${key.slice(-12)}`,
      serviceType: payload.serviceName, mode: payload.mode, unitPrice: payload.unitPrice,
      usageCount: old?.usageCount || 1, source: 'cloudPull', createdAt: old?.createdAt || now, updatedAt: now, lastUsed: old?.lastUsed || now };
  }

  async function applySensitiveMergePlan({
    groupId, libraryId, confirmedNames = [], bossMemory = [], rangeRules = [], surcharges = [], gifts = [],
    plan, now = Date.now(),
  } = {}) {
    const names = clone(confirmedNames), bosses = clone(bossMemory), ranges = clone(rangeRules), extras = clone(surcharges), giftList = clone(gifts);
    const local = await buildLocalMap({ groupId, libraryId, confirmedNames: names, bossMemory: bosses, rangeRules: ranges, surcharges: extras, gifts: giftList });
    function remove(list, key) {
      const record = local.get(key); if (!record) return;
      const index = list.findIndex(item => item?.id && item.id === record.item?.id);
      if (index >= 0) list.splice(index, 1);
      else {
        const raw = list.indexOf(record.item); if (raw >= 0) list.splice(raw, 1);
      }
    }
    for (const operation of plan.operations || []) {
      const current = local.get(operation.businessKey) || null;
      if (operation.action === 'delete') {
        if (operation.dataType === 'playable_name') remove(names, operation.businessKey);
        else if (operation.dataType === 'boss_profile') remove(bosses, operation.businessKey);
        else if (operation.dataType === 'rank_range_rule') remove(ranges, operation.businessKey);
        else if (operation.dataType === 'surcharge_rule') remove(extras, operation.businessKey);
        else if (operation.dataType === 'gift_rule') remove(giftList, operation.businessKey);
      } else if (operation.dataType === 'rank_range_rule') {
        const next = cloudRange(operation.payload, current?.item, now, operation.businessKey);
        if (current) Object.assign(current.item, next); else ranges.push(next);
      } else if (operation.dataType === 'surcharge_rule') {
        const next = cloudSurcharge(operation.payload, current?.item, now, operation.businessKey);
        if (current) Object.assign(current.item, next); else extras.unshift(next);
      } else if (operation.dataType === 'gift_rule') {
        const next = cloudGift(operation.payload, current?.item, now, operation.businessKey);
        if (current) Object.assign(current.item, next); else giftList.unshift(next);
      }
    }
    return Object.freeze({
      confirmedNames: Object.freeze(names), bossMemory: Object.freeze(bosses),
      rangeRules: Object.freeze(ranges), surcharges: Object.freeze(extras), gifts: Object.freeze(giftList),
      changed: Boolean(plan?.operations?.length),
    });
  }

  return Object.freeze({
    SensitiveMergeError, planSensitiveMerge, applySensitiveMergePlan,
    rangePayload, surchargePayload, giftPayload,
  });
});
