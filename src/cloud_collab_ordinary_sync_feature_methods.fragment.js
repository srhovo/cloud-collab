 getStage5GSplitSnapshot(rawSnapshot) {
  const records = Array.isArray(rawSnapshot?.records) ? rawSnapshot.records : [];
  const tombstones = Array.isArray(rawSnapshot?.tombstones) ? rawSnapshot.tombstones : [];
  const ordinaryRecords = records.filter(item => ['playable_name', 'boss_profile'].includes(item?.dataType));
  const exactSnapshot = {
   ...rawSnapshot,
   records: records.filter(item => item?.dataType === 'exact_price'),
   tombstones: tombstones.filter(item => item?.dataType === 'exact_price')
  };
  if (tombstones.some(item => ['playable_name', 'boss_profile'].includes(item?.dataType))) {
   throw new CloudCollabSnapshotSync.SnapshotSyncError('STAGE6_ORDINARY_DELETE_BLOCKED', '普通名字和老板删除必须等待阶段6人工审核');
  }
  return { exactSnapshot, ordinaryRecords };
 }

 getStage5GConfirmedNames() {
  return Array.isArray(this.app.enhancedExtractor?.data?.confirmedNames)
   ? this.app.enhancedExtractor.data.confirmedNames
   : [];
 }

 restoreStage5GStoreRaw(store, raw) {
  if (raw === null || raw === undefined) return store.clear();
  return store.save(raw);
 }

 async commitStage5GMixedSnapshot(binding, scope, rawSnapshot, localPriceItems = []) {
  if (!globalThis.CloudCollabOrdinarySync?.planOrdinaryMerge) {
   throw new CloudCollabSnapshotSync.SnapshotSyncError('ORDINARY_SYNC_MODULE_UNAVAILABLE', '普通共享同步模块不可用');
  }
  const { exactSnapshot, ordinaryRecords } = this.getStage5GSplitSnapshot(rawSnapshot);
  const exactPlan = await CloudCollabSnapshotSync.planExactPriceMerge({
   snapshot: exactSnapshot,
   localItems: localPriceItems,
   baseHashes: scope.baseHashes || {}
  });
  const ordinaryPlan = await CloudCollabOrdinarySync.planOrdinaryMerge({
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   records: ordinaryRecords,
   confirmedNames: this.getStage5GConfirmedNames(),
   bossMemory: Array.isArray(this.app.bossMemory) ? this.app.bossMemory : [],
   baseHashes: exactPlan.nextBaseHashes
  });

  const priceStore = this.app.priceLibraryStore;
  const syncStore = this.stores.syncStore;
  const bindingStore = this.stores.bindingStore;
  const oldCanonical = JSON.parse(JSON.stringify(this.app.priceLibraries));
  const oldLegacy = JSON.parse(JSON.stringify(this.app.priceMemory || []));
  const oldSyncRaw = syncStore.readRaw();
  const oldBindingsRaw = bindingStore.readRaw();
  const oldBossMemory = JSON.parse(JSON.stringify(this.app.bossMemory || []));
  const oldExtractorData = JSON.parse(JSON.stringify(this.app.enhancedExtractor?.data || {}));
  let exactResult = null;
  try {
   exactResult = this.commitExactPricePlan(binding, scope, exactPlan);
   const applied = CloudCollabOrdinarySync.applyOrdinaryMergePlan({
    confirmedNames: this.getStage5GConfirmedNames(),
    bossMemory: Array.isArray(this.app.bossMemory) ? this.app.bossMemory : [],
    plan: ordinaryPlan,
    now: Date.now()
   });
   if (applied.namesChanged) {
    this.app.enhancedExtractor.data = {
     ...(this.app.enhancedExtractor.data || {}),
     confirmedNames: Array.from(applied.confirmedNames, item => ({ ...item }))
    };
    this.app.enhancedExtractor.saveData();
   }
   if (applied.bossesChanged) {
    this.app.bossMemory = Array.from(applied.bossMemory, item => ({ ...item }));
    if (!this.app.bossMemoryFeature?.save?.(this.app.bossMemory)) {
     throw new CloudCollabSnapshotSync.SnapshotSyncError('BOSS_MEMORY_PERSIST_FAILED', '公共老板资料未能持久化');
    }
    this.app.bossMemoryFeature?.refresh?.();
   }

   const currentScope = syncStore.getScope(binding.groupId, binding.libraryId) || scope;
   const processed = new Set(ordinaryPlan.records.map(item => item.businessKey));
   const conflicts = (Array.isArray(currentScope.conflicts) ? currentScope.conflicts : [])
    .filter(item => !processed.has(item.businessKey));
   const detectedAt = Date.now();
   ordinaryPlan.conflicts.forEach(item => conflicts.push({
    conflictId: item.conflictId,
    businessKey: item.businessKey,
    dataType: item.dataType,
    baseHash: item.baseHash,
    localHash: item.localHash,
    remoteHash: item.remoteHash,
    detectedAt,
    status: 'open'
   }));
   syncStore.upsertScope({
    ...currentScope,
    publicVersion: rawSnapshot.publicVersion,
    cursor: rawSnapshot.cursor,
    lastSuccessfulCheckAt: detectedAt,
    baseHashes: ordinaryPlan.nextBaseHashes,
    conflicts
   });
   bindingStore.updateBasePublicVersion(binding.localLibraryId, rawSnapshot.publicVersion);
   return {
    counts: {
     upserts: exactPlan.counts.upserts + ordinaryPlan.counts.upserts,
     deletes: exactPlan.counts.deletes,
     unchanged: exactPlan.counts.unchanged + ordinaryPlan.counts.unchanged,
     preserveLocal: exactPlan.counts.preserveLocal + ordinaryPlan.counts.preserveLocal,
     conflicts: exactPlan.counts.conflicts + ordinaryPlan.counts.conflicts,
     ordinaryUpserts: ordinaryPlan.counts.upserts,
     ordinaryConflicts: ordinaryPlan.counts.conflicts
    },
    publicVersion: rawSnapshot.publicVersion,
    changed: Boolean(exactResult?.changed || applied.namesChanged || applied.bossesChanged)
   };
  } catch (error) {
   const rollbackErrors = [];
   try { this.restoreStage5GStoreRaw(bindingStore, oldBindingsRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try { this.restoreStage5GStoreRaw(syncStore, oldSyncRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try {
    if (!priceStore.restoreSnapshot(oldCanonical, oldLegacy)) throw new Error('价格库回滚失败');
    this.app.priceLibraries = oldCanonical;
    this.app.priceMemory = oldLegacy;
   } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try {
    this.app.enhancedExtractor.data = oldExtractorData;
    this.app.enhancedExtractor.saveData();
   } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try {
    this.app.bossMemory = oldBossMemory;
    if (!this.app.bossMemoryFeature?.save?.(oldBossMemory)) throw new Error('老板记忆回滚失败');
   } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   if (rollbackErrors.length) {
    throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_ROLLBACK_INCOMPLETE', '混合公共更新失败且回滚不完整，云功能已停止', { cause: error?.code || error?.message });
   }
   throw error;
  }
 }
