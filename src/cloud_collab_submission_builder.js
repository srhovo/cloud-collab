(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudCollabSubmissionBuilder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const APP_VERSION = '8.2.28';
  const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
  const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
  const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;

  class SubmissionBuilderError extends Error {
    constructor(code, message, details = null) {
      super(message || code || '本地候选生成失败');
      this.name = 'SubmissionBuilderError';
      this.code = code || 'SUBMISSION_BUILDER_ERROR';
      this.details = details;
    }
  }

  function canonicalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SubmissionBuilderError('INVALID_CANONICAL_NUMBER', '候选对象包含无效数字');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (!value || typeof value !== 'object') throw new SubmissionBuilderError('INVALID_CANONICAL_VALUE', '候选对象包含不支持的值');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    throw new SubmissionBuilderError('BASE64_UNAVAILABLE', '当前环境无法生成候选Hash');
  }

  async function sha256Base64Url(value) {
    if (typeof TextEncoder !== 'function' || !globalThis.crypto?.subtle) {
      throw new SubmissionBuilderError('WEB_CRYPTO_UNAVAILABLE', '当前环境缺少安全Hash能力，不会生成上传候选');
    }
    const bytes = new TextEncoder().encode(String(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return toBase64Url(new Uint8Array(digest));
  }

  function assertScope(meta, binding) {
    if (!DEVICE_ID_PATTERN.test(String(meta?.deviceId || ''))) throw new SubmissionBuilderError('INVALID_DEVICE_ID', '本地deviceId格式无效');
    if (!binding || binding.mode !== 'collaborate') throw new SubmissionBuilderError('BINDING_NOT_COLLABORATIVE', '只有参与协作模式允许生成待上传候选');
    if (!GROUP_ID_PATTERN.test(String(binding.groupId || '')) || !LIBRARY_ID_PATTERN.test(String(binding.libraryId || ''))) {
      throw new SubmissionBuilderError('INVALID_PUBLIC_SCOPE', '公共团或价格库ID格式无效');
    }
  }

  function projectExactPrice(item) {
    return {
      serviceName: item?.serviceType,
      settleType: item?.settleType,
      unitPrice: item?.unitPrice,
    };
  }

  async function buildSubmission({ meta, binding, payload, origin, idFactory, now, snapshotApi, localStoresApi } = {}) {
    assertScope(meta, binding);
    if (!['user', 'initialBinding'].includes(origin)) throw new SubmissionBuilderError('INVALID_ORIGIN', '候选来源无效');
    if (!idFactory || typeof idFactory.submissionId !== 'function') throw new SubmissionBuilderError('ID_FACTORY_UNAVAILABLE', '本地submissionId生成器不可用');
    if (!snapshotApi || typeof snapshotApi.computeExactPriceHashes !== 'function') throw new SubmissionBuilderError('HASH_PROJECTOR_UNAVAILABLE', '普通精确价格Hash投影器不可用');
    const submissionId = idFactory.submissionId();
    const createdAt = Number(now?.() ?? Date.now());
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new SubmissionBuilderError('INVALID_CLIENT_TIME', '本地时间超出协议范围');
    const hashes = await snapshotApi.computeExactPriceHashes(binding.groupId, binding.libraryId, payload);
    const idempotencyKey = `ik_v1_${await sha256Base64Url(canonicalize({ schemaVersion: 1, deviceId: meta.deviceId, submissionId }))}`;
    const submission = {
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      submissionId,
      deviceId: meta.deviceId,
      groupId: binding.groupId,
      libraryId: binding.libraryId,
      bossId: null,
      dataType: 'exact_price',
      operation: 'upsert',
      origin,
      clientCreatedAt: createdAt,
      businessKey: hashes.businessKey,
      contentHash: hashes.contentHash,
      idempotencyKey,
      payload: hashes.payload,
      clientContext: { appVersion: APP_VERSION, projectionSpecVersion: 1, queueSchemaVersion: 1 },
    };
    if (localStoresApi?.validateSubmission) localStoresApi.validateSubmission(submission);
    return submission;
  }

  async function buildInitialBindingCandidates({
    meta,
    binding,
    localItems = [],
    baseHashes = {},
    conflicts = [],
    existingQueueRecords = [],
    idFactory,
    now = () => Date.now(),
    snapshotApi = globalThis.CloudCollabSnapshotSync,
    localStoresApi = globalThis.CloudCollabLocalStores,
  } = {}) {
    assertScope(meta, binding);
    const conflictKeys = new Set((Array.isArray(conflicts) ? conflicts : [])
      .filter(item => item?.status === 'open')
      .map(item => String(item.businessKey || '')));
    const queuedPairs = new Set((Array.isArray(existingQueueRecords) ? existingQueueRecords : [])
      .map(record => `${String(record?.submission?.businessKey || '')}\u0000${String(record?.submission?.contentHash || '')}`));
    const candidates = [];
    const skipped = [];

    for (let index = 0; index < (Array.isArray(localItems) ? localItems : []).length; index++) {
      const item = localItems[index];
      try {
        const submission = await buildSubmission({
          meta,
          binding,
          payload: projectExactPrice(item),
          origin: 'initialBinding',
          idFactory,
          now,
          snapshotApi,
          localStoresApi,
        });
        const pair = `${submission.businessKey}\u0000${submission.contentHash}`;
        if (baseHashes?.[submission.businessKey] === submission.contentHash) {
          skipped.push({ index, reason: 'already_public', businessKey: submission.businessKey });
        } else if (conflictKeys.has(submission.businessKey)) {
          skipped.push({ index, reason: 'open_conflict', businessKey: submission.businessKey });
        } else if (queuedPairs.has(pair)) {
          skipped.push({ index, reason: 'already_queued', businessKey: submission.businessKey });
        } else {
          candidates.push(submission);
          queuedPairs.add(pair);
        }
      } catch (error) {
        skipped.push({ index, reason: 'invalid_exact_price', code: error?.code || 'INVALID_EXACT_PRICE' });
      }
    }

    return Object.freeze({
      candidates,
      skipped,
      counts: Object.freeze({
        local: Array.isArray(localItems) ? localItems.length : 0,
        candidates: candidates.length,
        alreadyPublic: skipped.filter(item => item.reason === 'already_public').length,
        openConflicts: skipped.filter(item => item.reason === 'open_conflict').length,
        alreadyQueued: skipped.filter(item => item.reason === 'already_queued').length,
        invalid: skipped.filter(item => item.reason === 'invalid_exact_price').length,
      }),
    });
  }

  return Object.freeze({
    APP_VERSION,
    SubmissionBuilderError,
    canonicalize,
    sha256Base64Url,
    projectExactPrice,
    buildSubmission,
    buildInitialBindingCandidates,
  });
});
