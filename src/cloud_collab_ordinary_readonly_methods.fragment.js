 splitStage5GPublicSnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)
   || !Array.isArray(rawSnapshot.records) || !Array.isArray(rawSnapshot.tombstones)) {
   throw new CloudCollabSnapshotSync.SnapshotSyncError('INVALID_SNAPSHOT_FIELDS', '公共快照顶层字段无效');
  }
  const supported = new Set(['exact_price', 'playable_name', 'boss_profile']);
  const records = rawSnapshot.records.map(record => ({ ...record }));
  for (const record of records) {
   if (!supported.has(record?.dataType) || record?.operation !== 'upsert') {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('UNSUPPORTED_SNAPSHOT_RECORD', '公共快照包含当前阶段不支持的数据类型或操作');
   }
  }
  const tombstones = rawSnapshot.tombstones.map(item => ({ ...item }));
  if (tombstones.some(item => item?.dataType !== 'exact_price')) {
   throw new CloudCollabSnapshotSync.SnapshotSyncError('ORDINARY_DELETE_REQUIRES_STAGE6', '普通名字或老板删除必须等待阶段6人工审核支持');
  }
  return Object.freeze({
   exactSnapshot: Object.freeze({
    ...rawSnapshot,
    records: Object.freeze(records.filter(item => item.dataType === 'exact_price')),
    tombstones: Object.freeze(tombstones)
   }),
   ordinaryRecords: Object.freeze(records.filter(item => item.dataType === 'playable_name' || item.dataType === 'boss_profile'))
  });
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
  return Object.freeze({ rawSnapshot, exactPlan, ordinaryPlan });
 }

 cloneStage5GValue(value) {
  return JSON.parse(JSON.stringify(value));
 }

 buildStage5GConflictState(scope, plans, detectedAt) {
  const processedKeys = new Set([
   ...plans.exactPlan.snapshot.records.map(item => item.businessKey),
   ...plans.exactPlan.snapshot.tombstones.map(item => item.businessKey),
   ...plans.ordinaryPlan.records.map(item => item.businessKey)
  ]);
  const conflicts = (Array.isArray(scope.conflicts) ? scope.conflicts : [])
   .filter(item => !processedKeys.has(item.businessKey));
  for (const item of [...plans.exactPlan.conflicts, ...plans.ordinaryPlan.conflicts]) {
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

 commitStage5GMixedPlan(binding, scope, plans) {
  const priceStore = this.app.priceLibraryStore;
  const syncStore = this.stores.syncStore;
  const bindingStore = this.stores.bindingStore;
  const oldCanonical = this.cloneStage5GValue(this.app.priceLibraries);
  const oldLegacy = this.cloneStage5GValue(this.app.priceMemory || []);
  const oldExtractor = this.app.enhancedExtractor?.snapshotData?.() || this.cloneStage5GValue(this.app.enhancedExtractor?.data || {});
  const oldBossMemory = this.cloneStage5GValue(this.app.bossMemory || []);
  const oldSyncRaw = syncStore.readRaw();
  const oldBindingsRaw = bindingStore.readRaw();
  const exactWorking = this.buildWorkingPriceData(binding, plans.exactPlan);
  const ordinaryWorking = CloudCollabOrdinaryTypes.applyOrdinaryMergePlan({
   confirmedNames: this.app.enhancedExtractor?.data?.confirmedNames || [],
   bossMemory: this.app.bossMemory || [],
   plan: plans.ordinaryPlan,
   now: Date.now()
  });
  let priceResult = { ok: true, data: oldCanonical, activeItems: oldLegacy };
  try {
   if (exactWorking.changed) {
    priceResult = priceStore.persist(exactWorking.data, { previousCanonical: oldCanonical, previousLegacy: oldLegacy });
    if (!priceResult.ok) throw new CloudCollabSnapshotSync.SnapshotSyncError('PRICE_LIBRARY_PERSIST_FAILED', '公共更新未能持久化到价格库');
   }
   if (ordinaryWorking.namesChanged) {
    this.app.enhancedExtractor.data.confirmedNames = this.cloneStage5GValue(ordinaryWorking.confirmedNames);
    this.app.enhancedExtractor.markLearningCollectionsDirty?.();
    if (!this.app.enhancedExtractor.saveData()) {
     throw new CloudCollabSnapshotSync.SnapshotSyncError('PLAYABLE_NAMES_PERSIST_FAILED', '公共陪玩名字未能持久化');
    }
   }
   if (ordinaryWorking.bossesChanged) {
    const nextBossMemory = this.cloneStage5GValue(ordinaryWorking.bossMemory);
    if (!this.app.bossMemoryFeature?.save?.(nextBossMemory)) {
     throw new CloudCollabSnapshotSync.SnapshotSyncError('BOSS_MEMORY_PERSIST_FAILED', '公共老板资料未能持久化');
    }
   }
   const detectedAt = Date.now();
   syncStore.upsertScope({
    ...scope,
    publicVersion: plans.rawSnapshot.publicVersion,
    cursor: plans.rawSnapshot.cursor,
    lastSuccessfulCheckAt: detectedAt,
    baseHashes: plans.ordinaryPlan.nextBaseHashes,
    conflicts: this.buildStage5GConflictState(scope, plans, detectedAt)
   });
   bindingStore.updateBasePublicVersion(binding.localLibraryId, plans.rawSnapshot.publicVersion);
  } catch (error) {
   const rollbackErrors = [];
   try { this.restoreStoreRaw(bindingStore, oldBindingsRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try { this.restoreStoreRaw(syncStore, oldSyncRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   if (ordinaryWorking.bossesChanged) {
    try { if (!this.app.bossMemoryFeature?.save?.(oldBossMemory)) throw new Error('老板资料回滚失败'); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (ordinaryWorking.namesChanged) {
    try { if (!this.app.enhancedExtractor.restoreData(oldExtractor)) throw new Error('陪玩名字回滚失败'); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (exactWorking.changed) {
    try { if (!priceStore.restoreSnapshot(oldCanonical, oldLegacy)) throw new Error('价格库回滚失败'); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
   }
   if (rollbackErrors.length) {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_ROLLBACK_INCOMPLETE', '公共更新失败且回滚不完整，云功能已停止', { cause: error?.code || error?.message });
   }
   throw error;
  }
  if (exactWorking.changed) {
   this.app.priceLibraries = priceResult.data;
   this.app.priceMemory = priceResult.activeItems;
   this.app.priceMemoryFeature?.updatePriceMemoryUI?.({ forceName: true });
   this.app.priceMemoryFeature?.refreshServicePriceMatchAfterLibraryChange?.();
  }
  if (ordinaryWorking.bossesChanged) this.app.bossMemoryFeature?.refresh?.();
  const counts = Object.freeze({
   upserts: plans.exactPlan.counts.upserts + plans.ordinaryPlan.counts.upserts,
   deletes: plans.exactPlan.counts.deletes,
   unchanged: plans.exactPlan.counts.unchanged + plans.ordinaryPlan.counts.unchanged,
   preserveLocal: plans.exactPlan.counts.preserveLocal + plans.ordinaryPlan.counts.preserveLocal,
   conflicts: plans.exactPlan.counts.conflicts + plans.ordinaryPlan.counts.conflicts,
   exactPriceUpserts: plans.exactPlan.counts.upserts,
   playableOrBossUpserts: plans.ordinaryPlan.counts.upserts
  });
  return {
   counts,
   publicVersion: plans.rawSnapshot.publicVersion,
   changed: exactWorking.changed || ordinaryWorking.namesChanged || ordinaryWorking.bossesChanged,
   ordinaryChanged: Object.freeze({
    playableNames: ordinaryWorking.namesChanged,
    bossProfiles: ordinaryWorking.bossesChanged
   })
  };
 }
