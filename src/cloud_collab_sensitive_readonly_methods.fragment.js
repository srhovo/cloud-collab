 splitStage5GPublicSnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)
   || !Array.isArray(rawSnapshot.records) || !Array.isArray(rawSnapshot.tombstones)) {
   throw new CloudCollabSnapshotSync.SnapshotSyncError('INVALID_SNAPSHOT_FIELDS', '公共快照顶层字段无效');
  }
  const allTypes = new Set(['exact_price','playable_name','boss_profile','rank_range_rule','surcharge_rule','gift_rule']);
  const records = rawSnapshot.records.map(record => ({ ...record }));
  const tombstones = rawSnapshot.tombstones.map(item => ({ ...item }));
  for (const record of records) {
   if (!allTypes.has(record?.dataType) || record?.operation !== 'upsert') {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('UNSUPPORTED_SNAPSHOT_RECORD', '公共快照包含不支持的数据类型或操作');
   }
  }
  for (const item of tombstones) {
   if (!allTypes.has(item?.dataType) || item?.operation !== 'delete') {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('UNSUPPORTED_SNAPSHOT_TOMBSTONE', '公共快照包含不支持的墓碑类型或操作');
   }
  }
  return Object.freeze({
   exactSnapshot: Object.freeze({
    ...rawSnapshot,
    records: Object.freeze(records.filter(item => item.dataType === 'exact_price')),
    tombstones: Object.freeze(tombstones.filter(item => item.dataType === 'exact_price'))
   }),
   ordinaryRecords: Object.freeze(records.filter(item => item.dataType === 'playable_name' || item.dataType === 'boss_profile')),
   sensitiveRecords: Object.freeze(records.filter(item => ['rank_range_rule','surcharge_rule','gift_rule'].includes(item.dataType))),
   sensitiveTombstones: Object.freeze(tombstones.filter(item => item.dataType !== 'exact_price'))
  });
 }

 getStage6BGiftMemories() {
  try { return this.app.giftMemoryFeature?.getMemories?.() || []; }
  catch (_) { return []; }
 }

 async planStage5GMixedMerge(binding, scope, rawSnapshot, targetLibrary) {
  const split = this.splitStage5GPublicSnapshot(rawSnapshot);
  const exactPlan = await CloudCollabSnapshotSync.planExactPriceMerge({
   snapshot: split.exactSnapshot,
   localItems: targetLibrary.items || [],
   baseHashes: scope.baseHashes || {}
  });
  const ordinaryPlan = await CloudCollabOrdinaryTypes.planOrdinaryMerge({
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   records: split.ordinaryRecords,
   confirmedNames: this.app.enhancedExtractor?.data?.confirmedNames || [],
   bossMemory: this.app.bossMemory || [],
   baseHashes: exactPlan.nextBaseHashes
  });
  const sensitivePlan = await CloudCollabSensitiveMerge.planSensitiveMerge({
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   records: split.sensitiveRecords,
   tombstones: split.sensitiveTombstones,
   confirmedNames: this.app.enhancedExtractor?.data?.confirmedNames || [],
   bossMemory: this.app.bossMemory || [],
   rangeRules: targetLibrary.rules || [],
   surcharges: targetLibrary.surcharges || [],
   gifts: this.getStage6BGiftMemories(),
   baseHashes: ordinaryPlan.nextBaseHashes
  });
  return Object.freeze({ rawSnapshot, exactPlan, ordinaryPlan, sensitivePlan });
 }

 buildStage5GConflictState(scope, plans, detectedAt) {
  const processedKeys = new Set([
   ...plans.exactPlan.snapshot.records.map(item => item.businessKey),
   ...plans.exactPlan.snapshot.tombstones.map(item => item.businessKey),
   ...plans.ordinaryPlan.records.map(item => item.businessKey),
   ...plans.sensitivePlan.records.map(item => item.businessKey),
   ...plans.sensitivePlan.tombstones.map(item => item.businessKey)
  ]);
  const conflicts = (Array.isArray(scope.conflicts) ? scope.conflicts : []).filter(item => !processedKeys.has(item.businessKey));
  for (const item of [...plans.exactPlan.conflicts, ...plans.ordinaryPlan.conflicts, ...plans.sensitivePlan.conflicts]) {
   conflicts.push({
    conflictId: item.conflictId,
    businessKey: item.businessKey,
    dataType: item.dataType,
    baseHash: item.baseHash,
    localHash: item.localHash,
    remoteHash: item.remoteHash,
    detectedAt,
    status: 'open'
   });
  }
  return conflicts;
 }

 async commitStage5GMixedPlan(binding, scope, plans) {
  const priceStore = this.app.priceLibraryStore;
  const syncStore = this.stores.syncStore;
  const bindingStore = this.stores.bindingStore;
  const oldCanonical = this.cloneStage5GValue(this.app.priceLibraries);
  const oldLegacy = this.cloneStage5GValue(this.app.priceMemory || []);
  const oldExtractor = this.app.enhancedExtractor?.snapshotData?.() || this.cloneStage5GValue(this.app.enhancedExtractor?.data || {});
  const oldBossMemory = this.cloneStage5GValue(this.app.bossMemory || []);
  const oldGifts = this.cloneStage5GValue(this.getStage6BGiftMemories());
  const oldSyncRaw = syncStore.readRaw();
  const oldBindingsRaw = bindingStore.readRaw();
  const exactWorking = this.buildWorkingPriceData(binding, plans.exactPlan);
  const targetLibrary = exactWorking.data?.libraries?.find(item => item.id === binding.localLibraryId)
   || exactWorking.data?.libraries?.find(item => item.id === exactWorking.data.activeLibraryId)
   || exactWorking.data?.libraries?.[0];
  if (!targetLibrary) throw new CloudCollabSnapshotSync.SnapshotSyncError('TARGET_LIBRARY_NOT_FOUND', '公共敏感更新找不到本地价格库');
  const sensitiveWorking = await CloudCollabSensitiveMerge.applySensitiveMergePlan({
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   confirmedNames: this.app.enhancedExtractor?.data?.confirmedNames || [],
   bossMemory: this.app.bossMemory || [],
   rangeRules: targetLibrary.rules || [],
   surcharges: targetLibrary.surcharges || [],
   gifts: oldGifts,
   plan: plans.sensitivePlan,
   now: Date.now()
  });
  const ordinaryWorking = CloudCollabOrdinaryTypes.applyOrdinaryMergePlan({
   confirmedNames: sensitiveWorking.confirmedNames,
   bossMemory: sensitiveWorking.bossMemory,
   plan: plans.ordinaryPlan,
   now: Date.now()
  });
  const oldRulesText = JSON.stringify(targetLibrary.rules || []);
  const oldSurchargesText = JSON.stringify(targetLibrary.surcharges || []);
  targetLibrary.rules = this.cloneStage5GValue(sensitiveWorking.rangeRules);
  targetLibrary.surcharges = this.cloneStage5GValue(sensitiveWorking.surcharges);
  const ruleDataChanged = oldRulesText !== JSON.stringify(targetLibrary.rules) || oldSurchargesText !== JSON.stringify(targetLibrary.surcharges);
  const priceChanged = exactWorking.changed || ruleDataChanged;
  let priceResult = { ok: true, data: oldCanonical, activeItems: oldLegacy };
  try {
   if (priceChanged) {
    priceResult = priceStore.persist(exactWorking.data, { previousCanonical: oldCanonical, previousLegacy: oldLegacy });
    if (!priceResult.ok) throw new CloudCollabSnapshotSync.SnapshotSyncError('PRICE_LIBRARY_PERSIST_FAILED', '公共价格或规则更新未能持久化');
   }
   if (ordinaryWorking.namesChanged) {
    this.app.enhancedExtractor.data.confirmedNames = this.cloneStage5GValue(ordinaryWorking.confirmedNames);
    this.app.enhancedExtractor.markLearningCollectionsDirty?.();
    if (!this.app.enhancedExtractor.saveData()) throw new CloudCollabSnapshotSync.SnapshotSyncError('PLAYABLE_NAMES_PERSIST_FAILED', '公共陪玩名字未能持久化');
   }
   if (ordinaryWorking.bossesChanged) {
    if (!this.app.bossMemoryFeature?.save?.(this.cloneStage5GValue(ordinaryWorking.bossMemory))) {
     throw new CloudCollabSnapshotSync.SnapshotSyncError('BOSS_MEMORY_PERSIST_FAILED', '公共老板资料未能持久化');
    }
   }
   const giftsChanged = JSON.stringify(oldGifts) !== JSON.stringify(sensitiveWorking.gifts);
   if (giftsChanged && !this.app.giftMemoryFeature?.persist?.(this.cloneStage5GValue(sensitiveWorking.gifts), { captureUndo: false })) {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('GIFT_MEMORY_PERSIST_FAILED', '公共礼物规则未能持久化');
   }
   const detectedAt = Date.now();
   syncStore.upsertScope({
    ...scope,
    publicVersion: plans.rawSnapshot.publicVersion,
    cursor: plans.rawSnapshot.cursor,
    lastSuccessfulCheckAt: detectedAt,
    baseHashes: plans.sensitivePlan.nextBaseHashes,
    conflicts: this.buildStage5GConflictState(scope, plans, detectedAt)
   });
   bindingStore.updateBasePublicVersion(binding.localLibraryId, plans.rawSnapshot.publicVersion);
  } catch (error) {
   const rollbackErrors = [];
   try { this.restoreStoreRaw(bindingStore, oldBindingsRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try { this.restoreStoreRaw(syncStore, oldSyncRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try { if (!this.app.giftMemoryFeature?.persist?.(oldGifts, { captureUndo: false })) throw new Error('礼物规则回滚失败'); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   if (ordinaryWorking.bossesChanged) {
    try { if (!this.app.bossMemoryFeature?.save?.(oldBossMemory)) throw new Error('老板资料回滚失败'); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (ordinaryWorking.namesChanged) {
    try { if (!this.app.enhancedExtractor.restoreData(oldExtractor)) throw new Error('陪玩名字回滚失败'); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (priceChanged) {
    try { if (!priceStore.restoreSnapshot(oldCanonical, oldLegacy)) throw new Error('价格库回滚失败'); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (rollbackErrors.length) throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_ROLLBACK_INCOMPLETE', '敏感公共更新失败且回滚不完整，云功能已停止', { cause: error?.code || error?.message });
   throw error;
  }
  if (priceChanged) {
   this.app.priceLibraries = priceResult.data;
   this.app.priceMemory = priceResult.activeItems;
   this.app.priceMemoryFeature?.updatePriceMemoryUI?.({ forceName: true });
   this.app.priceMemoryFeature?.refreshServicePriceMatchAfterLibraryChange?.();
   this.app.surchargeFeature?.updateUI?.();
  }
  if (ordinaryWorking.bossesChanged) this.app.bossMemoryFeature?.refresh?.();
  this.app.giftMemoryFeature?.updateUI?.();
  const counts = Object.freeze({
   upserts: plans.exactPlan.counts.upserts + plans.ordinaryPlan.counts.upserts + plans.sensitivePlan.counts.upserts,
   deletes: plans.exactPlan.counts.deletes + plans.sensitivePlan.counts.deletes,
   unchanged: plans.exactPlan.counts.unchanged + plans.ordinaryPlan.counts.unchanged + plans.sensitivePlan.counts.unchanged,
   preserveLocal: plans.exactPlan.counts.preserveLocal + plans.ordinaryPlan.counts.preserveLocal + plans.sensitivePlan.counts.preserveLocal,
   conflicts: plans.exactPlan.counts.conflicts + plans.ordinaryPlan.counts.conflicts + plans.sensitivePlan.counts.conflicts,
   exactPriceUpserts: plans.exactPlan.counts.upserts,
   playableOrBossUpserts: plans.ordinaryPlan.counts.upserts,
   sensitiveRuleUpserts: plans.sensitivePlan.counts.upserts,
   sensitiveDeletes: plans.sensitivePlan.counts.deletes
  });
  return {
   counts,
   publicVersion: plans.rawSnapshot.publicVersion,
   changed: priceChanged || ordinaryWorking.namesChanged || ordinaryWorking.bossesChanged || sensitiveWorking.changed,
   ordinaryChanged: Object.freeze({ playableNames: ordinaryWorking.namesChanged, bossProfiles: ordinaryWorking.bossesChanged }),
   sensitiveChanged: Object.freeze({ rules: plans.sensitivePlan.counts.upserts > 0, tombstones: plans.sensitivePlan.counts.deletes > 0 })
  };
 }
