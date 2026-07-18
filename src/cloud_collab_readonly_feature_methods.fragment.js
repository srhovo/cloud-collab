 scheduleReadonlyCheck() {
  if (this._readonlyCheckScheduled) return false;
  this._readonlyCheckScheduled = true;
  setTimeout(async () => {
   await this.checkServer({ interactive: false });
   await this.syncAllBoundLibraries({ interactive: false, reason: 'startup' });
   this.startReceivePolling();
  }, 0);
  return true;
 }

 startReceivePolling() {
  if (this._receivePollTimer) return false;
  this._receivePollTimer = setInterval(async () => {
   if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
   await this.checkServer({ interactive: false });
   await this.syncAllBoundLibraries({ interactive: false, reason: 'poll' });
  }, 300000);
  return true;
 }

 updateServerState(patch) {
  this.app.cloudCollabState = { ...(this.app.cloudCollabState || {}), ...patch };
  this.renderServerStatus();
  return this.app.cloudCollabState;
 }

 renderServerStatus() {
  const state = this.app.cloudCollabState || {};
  const status = state.serverStatus || 'idle';
  const summary = this.app.el.cloudServerSummary;
  const badge = this.app.el.cloudServerBadge;
  const labels = {
   idle: '尚未检查只读同步接口。',
   not_configured: '本地文件未配置API地址；不会自动联网。部署到EdgeOne同一站点后将使用同源接口。',
   checking: '正在异步检查只读同步接口……',
   online: `只读同步接口在线；协议版本 ${state.serverProtocolVersion ?? '未知'}。`,
   protocol_mismatch: `服务器在线，但协议或快照能力与当前客户端不兼容。`,
   offline: `只读同步接口暂不可用${state.serverErrorCode ? `（${state.serverErrorCode}）` : ''}；正常码单不受影响。`
  };
  if (summary) {
   summary.textContent = labels[status] || labels.idle;
   summary.classList.toggle('is-success', status === 'online');
   summary.classList.toggle('is-error', status === 'offline' || status === 'protocol_mismatch');
  }
  if (badge) badge.textContent = ({ online: '只读同步 · 在线', checking: '只读同步 · 检查中', offline: '只读同步 · 离线', protocol_mismatch: '只读同步 · 不兼容', not_configured: '只读同步 · 未配置' })[status] || '只读同步 · 待检查';
 }

 async checkServer({ interactive = false } = {}) {
  if (!this.apiClient?.isConfigured?.()) {
   this.lastServerError = null;
   this.updateServerState({ serverStatus: 'not_configured', serverProtocolVersion: null, serverCheckedAt: Date.now(), serverErrorCode: null });
   if (interactive) this.setStatus('当前文件未配置测试接口；未发送网络请求。', 'success');
   return null;
  }
  this.updateServerState({ serverStatus: 'checking', serverErrorCode: null });
  try {
   const [health, protocol] = await Promise.all([this.apiClient.health(), this.apiClient.protocol()]);
   const remoteVersion = Number(protocol.protocolVersion);
   const capabilities = protocol.capabilities || {};
   const compatible = health.status === 'ok'
    && remoteVersion === CloudCollabReadonly.CLIENT_PROTOCOL_VERSION
    && protocol.writeEnabled === false
    && capabilities.snapshotRead === true
    && capabilities.incrementalRead === true
    && capabilities.exactPriceReceive === true
    && capabilities.submission === false;
   this.lastServerError = null;
   this.updateServerState({
    serverStatus: compatible ? 'online' : 'protocol_mismatch',
    serverProtocolVersion: Number.isInteger(remoteVersion) ? remoteVersion : null,
    serverCheckedAt: Date.now(),
    serverErrorCode: compatible ? null : 'PROTOCOL_MISMATCH'
   });
   if (interactive) this.setStatus(compatible ? '只读同步接口检查通过。' : '服务器协议不兼容；未接收任何公共数据。', compatible ? 'success' : 'error');
   return { health, protocol, compatible };
  } catch (error) {
   this.lastServerError = error;
   if (!['API_UNREACHABLE', 'API_TIMEOUT', 'TEST_OFFLINE'].includes(error?.code)) appLogError('cloudCollabReadonlyCheck', error);
   this.updateServerState({ serverStatus: 'offline', serverProtocolVersion: null, serverCheckedAt: Date.now(), serverErrorCode: error?.code || 'API_UNREACHABLE' });
   if (interactive) this.setStatus(`只读同步接口不可用：${error?.message || '连接失败'}。正常码单不受影响。`, 'error');
   return null;
  }
 }

 renderPublicVersionSummary() {
  const target = this.app.el.cloudPublicVersionSummary;
  if (!target) return;
  const binding = this.stores.bindingStore.getByLocalLibraryId(this.selectedLocalLibraryId || '');
  if (!binding) {
   target.textContent = '当前价格库尚未绑定，无法接收公共更新。';
   target.classList.remove('is-success', 'is-error');
   return;
  }
  const scope = this.stores.syncStore.getScope(binding.groupId, binding.libraryId);
  const remote = this.lastPublicVersion;
  const localVersion = scope?.publicVersion || 0;
  const openConflicts = scope?.conflicts?.filter(item => item.status === 'open').length || 0;
  const remoteText = remote && remote.groupId === binding.groupId && remote.libraryId === binding.libraryId ? `；服务器版本 ${remote.publicVersion}` : '';
  target.textContent = `本地已处理公共版本 ${localVersion}${remoteText}；未解决冲突 ${openConflicts} 条。${binding.mode === 'local' ? '当前为本地模式，不会接收。' : '公共更新仅合并普通精确价格。'}`;
  target.classList.toggle('is-success', openConflicts === 0);
  target.classList.toggle('is-error', openConflicts > 0);
 }

 async checkSelectedPublicVersion() {
  const localLibraryId = this.app.el.cloudLocalLibrarySelect?.value || '';
  const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
  if (!binding) return this.setStatus('请先保存当前价格库的公共绑定。', 'error');
  return this.syncBinding(binding, { interactive: true, force: true, reason: 'manual' });
 }

 async syncAllBoundLibraries({ interactive = false, reason = 'poll' } = {}) {
  if (!this.apiClient?.isConfigured?.() || this.app.cloudCollabState?.serverStatus !== 'online' || this.lastError) return [];
  const bindings = this.stores.bindingStore.list().filter(item => item.mode === 'receive' || item.mode === 'collaborate');
  const results = [];
  for (const binding of bindings) results.push(await this.syncBinding(binding, { interactive, force: false, reason }));
  return results;
 }

 async fetchIncrementalSnapshot(binding, scope, versionData) {
  let sinceVersion = Number(scope?.publicVersion) || 0;
  const latestByKey = new Map();
  let loops = 0;
  while (sinceVersion < versionData.publicVersion && loops++ < 10) {
   const page = await this.apiClient.publicChanges(binding.groupId, binding.libraryId, { sinceVersion, limit: 100 });
   for (const change of page.changes || []) latestByKey.set(change.businessKey, change);
   if (!page.hasMore) {
    sinceVersion = page.publicVersion;
    break;
   }
   if (!Number.isInteger(page.nextVersion) || page.nextVersion <= sinceVersion) throw new CloudCollabSnapshotSync.SnapshotSyncError('INVALID_CHANGE_CURSOR', '增量接口未推进版本游标');
   sinceVersion = page.nextVersion;
  }
  if (sinceVersion < versionData.publicVersion) throw new CloudCollabSnapshotSync.SnapshotSyncError('CHANGE_PAGE_LIMIT', '增量更新分页超过安全上限');
  const records = [];
  const tombstones = [];
  [...latestByKey.values()].forEach(change => {
   if (change.operation === 'upsert') records.push({
    approvedVersion: change.version,
    businessKey: change.businessKey,
    contentHash: change.contentHash,
    dataType: change.dataType,
    operation: change.operation,
    payload: change.payload
   });
   else tombstones.push({ approvedVersion: change.version, businessKey: change.businessKey, dataType: change.dataType, identity: change.identity });
  });
  return {
   schemaVersion: 1,
   payloadSchemaVersion: 1,
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   publicVersion: versionData.publicVersion,
   snapshotVersion: versionData.snapshotVersion,
   cursor: `pv_${versionData.publicVersion}`,
   generatedAt: versionData.updatedAt || new Date().toISOString(),
   records,
   tombstones
  };
 }

 async fetchSnapshotForBinding(binding, scope, versionData, { force = false } = {}) {
  if (!force && scope?.publicVersion > 0 && versionData.publicVersion > scope.publicVersion) {
   try { return await this.fetchIncrementalSnapshot(binding, scope, versionData); }
   catch (error) {
    if (!['PUBLIC_VERSION_AHEAD', 'INVALID_CHANGE_CURSOR'].includes(error?.code)) appLogError('cloudCollabIncrementalFallback', error);
   }
  }
  const response = await this.apiClient.publicSnapshot(binding.groupId, binding.libraryId, { ifVersion: force ? null : (scope?.publicVersion || 0) });
  return response.status === 'snapshot' ? response.snapshot : null;
 }

 async syncBinding(binding, { interactive = false, force = false, reason = 'manual' } = {}) {
  if (!binding || binding.mode === 'local') {
   if (interactive) this.setStatus('当前价格库处于本地模式，不会接收公共更新。', 'success');
   return { status: 'local_mode' };
  }
  if (!this.apiClient?.isConfigured?.()) {
   if (interactive) this.setStatus('当前文件未配置只读同步接口。', 'error');
   return null;
  }
  const lockKey = `${binding.groupId}\u0000${binding.libraryId}`;
  this._syncLocks ||= new Set();
  if (this._syncLocks.has(lockKey)) return { status: 'already_syncing' };
  this._syncLocks.add(lockKey);
  try {
   const versionData = await this.apiClient.publicVersion(binding.groupId, binding.libraryId);
   this.lastPublicVersion = versionData;
   const scope = this.stores.syncStore.getScope(binding.groupId, binding.libraryId) || {
    groupId: binding.groupId,
    libraryId: binding.libraryId,
    publicVersion: binding.basePublicVersion || 0,
    cursor: null,
    lastSuccessfulCheckAt: null,
    baseHashes: {},
    conflicts: []
   };
   if (!force && versionData.publicVersion <= scope.publicVersion) {
    this.stores.syncStore.markSuccessfulCheck(binding.groupId, binding.libraryId, { publicVersion: scope.publicVersion, cursor: scope.cursor, checkedAt: Date.now() });
    this.renderPublicVersionSummary();
    if (interactive) this.setStatus(`公共版本 ${versionData.publicVersion} 已是最新；未修改本地价格。`, 'success');
    return { status: 'not_modified', versionData };
   }
   if (!versionData.snapshotAvailable) {
    const checkedAt = Date.now();
    this.commitSyncMetadata(binding, {
     ...scope,
     publicVersion: versionData.publicVersion,
     cursor: scope.cursor,
     lastSuccessfulCheckAt: checkedAt
    }, { updateBindingVersion: true });
    this.renderPublicVersionSummary();
    if (interactive) this.setStatus('公共库目前为空；本地价格未改变。', 'success');
    return { status: 'snapshot_unavailable', versionData };
   }
   const rawSnapshot = await this.fetchSnapshotForBinding(binding, scope, versionData, { force });
   if (!rawSnapshot) {
    this.renderPublicVersionSummary();
    if (interactive) this.setStatus('公共快照没有新变化；本地价格未改变。', 'success');
    return { status: 'not_modified', versionData };
   }
   const targetLibrary = this.app.priceLibraryStore.normalizeData(this.app.priceLibraries)?.libraries?.find(item => item.id === binding.localLibraryId);
   if (!targetLibrary) throw new CloudCollabSnapshotSync.SnapshotSyncError('LOCAL_LIBRARY_NOT_FOUND', '绑定的本地价格库不存在');
   const plan = await CloudCollabSnapshotSync.planExactPriceMerge({ snapshot: rawSnapshot, localItems: targetLibrary.items || [], baseHashes: scope.baseHashes || {} });
   const result = this.commitExactPricePlan(binding, scope, plan);
   this.lastPublicVersion = versionData;
   this.renderPublicVersionSummary();
   this.refresh();
   if (interactive) {
    const c = result.counts;
    this.setStatus(`公共更新处理完成：新增/更新 ${c.upserts}，删除 ${c.deletes}，保留本地 ${c.preserveLocal}，冲突 ${c.conflicts}。`, c.conflicts ? 'error' : 'success');
   }
   return { status: result.counts.conflicts ? 'completed_with_conflicts' : 'completed', reason, ...result };
  } catch (error) {
   if (!['API_UNREACHABLE', 'API_TIMEOUT', 'PUBLIC_LIBRARY_NOT_FOUND'].includes(error?.code)) appLogError('cloudCollabReceiveSync', error);
   if (error?.code === 'SYNC_ROLLBACK_INCOMPLETE') {
    this.lastError = error;
    this.loadLocalState();
   }
   if (interactive) this.setStatus(`接收公共更新失败：${error?.message || '处理失败'}${error?.code ? `（${error.code}）` : ''}。本地价格保持原状。`, 'error');
   return null;
  } finally {
   this._syncLocks.delete(lockKey);
  }
 }


 commitSyncMetadata(binding, nextScope, { updateBindingVersion = false } = {}) {
  const syncStore = this.stores.syncStore;
  const bindingStore = this.stores.bindingStore;
  const transaction = this.stores.coordinator?.transaction;
  if (!transaction?.run) throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_TRANSACTION_UNAVAILABLE', '同步事务组件不可用');
  const steps = [{ store: syncStore, apply: () => syncStore.upsertScope(nextScope) }];
  if (updateBindingVersion) steps.push({ store: bindingStore, apply: () => bindingStore.updateBasePublicVersion(binding.localLibraryId, nextScope.publicVersion) });
  const result = transaction.run(steps);
  if (!result.ok) {
   if (result.rollbackIncomplete) throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_ROLLBACK_INCOMPLETE', '同步元数据保存失败且回滚不完整，云功能已停止', { cause: result.error?.code || result.error?.message });
   throw result.error || new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_METADATA_PERSIST_FAILED', '同步元数据保存失败');
  }
  return true;
 }

 buildWorkingPriceData(binding, plan) {
  const store = this.app.priceLibraryStore;
  const data = store.normalizeData(this.app.priceLibraries);
  if (!data) throw new CloudCollabSnapshotSync.SnapshotSyncError('PRICE_LIBRARY_INVALID', '本地价格库数据未就绪');
  const working = JSON.parse(JSON.stringify(data));
  const index = working.libraries.findIndex(item => item.id === binding.localLibraryId);
  if (index < 0) throw new CloudCollabSnapshotSync.SnapshotSyncError('LOCAL_LIBRARY_NOT_FOUND', '绑定的本地价格库不存在');
  const library = working.libraries[index];
  let items = Array.isArray(library.items) ? library.items.map(item => ({ ...item })) : [];
  const now = Date.now();
  const matchKey = item => CloudCollabSnapshotSync.localMatchKey({ serviceName: item.serviceType, settleType: item.settleType, unitPrice: item.unitPrice });

  for (const entry of plan.upserts) {
   const payload = entry.record.payload;
   const key = CloudCollabSnapshotSync.localMatchKey(payload);
   const found = items.findIndex(item => matchKey(item) === key);
   if (found >= 0) {
    const current = items[found];
    items[found] = { ...current, serviceType: payload.serviceName, serviceKey: store.buildServiceKey(payload.serviceName), settleType: payload.settleType, unitPrice: payload.unitPrice, updatedAt: now };
   } else {
    const created = store.normalizeItem({ serviceType: payload.serviceName, settleType: payload.settleType, unitPrice: payload.unitPrice, usageCount: 1, createdAt: now, updatedAt: now, lastUsed: now }, items.length, now);
    if (!created) throw new CloudCollabSnapshotSync.SnapshotSyncError('REMOTE_ITEM_NORMALIZE_FAILED', '公共价格无法转换为本地项目');
    items.push(created);
   }
  }
  const deleteKeys = new Set(plan.deletes.map(entry => CloudCollabSnapshotSync.localMatchKey({ ...entry.tombstone.identity, unitPrice: 1 })));
  if (deleteKeys.size) items = items.filter(item => !deleteKeys.has(matchKey(item)));
  library.items = store.normalizeItems(items).items;
  library.updatedAt = now;
  working.updatedAt = now;
  return { data: working, changed: plan.upserts.length > 0 || plan.deletes.length > 0 };
 }

 restoreStoreRaw(store, raw) {
  if (raw === null || raw === undefined) return store.clear();
  return store.save(raw);
 }

 commitExactPricePlan(binding, scope, plan) {
  const priceStore = this.app.priceLibraryStore;
  const syncStore = this.stores.syncStore;
  const bindingStore = this.stores.bindingStore;
  const oldCanonical = JSON.parse(JSON.stringify(this.app.priceLibraries));
  const oldLegacy = JSON.parse(JSON.stringify(this.app.priceMemory || []));
  const oldSyncRaw = syncStore.readRaw();
  const oldBindingsRaw = bindingStore.readRaw();
  const working = this.buildWorkingPriceData(binding, plan);
  let priceResult = { ok: true, data: oldCanonical, activeItems: oldLegacy };
  try {
   if (working.changed) {
    priceResult = priceStore.persist(working.data, { previousCanonical: oldCanonical, previousLegacy: oldLegacy });
    if (!priceResult.ok) throw new CloudCollabSnapshotSync.SnapshotSyncError('PRICE_LIBRARY_PERSIST_FAILED', '公共更新未能持久化到价格库');
   }
   const existingConflicts = Array.isArray(scope.conflicts) ? [...scope.conflicts] : [];
   const processedKeys = new Set([
    ...plan.snapshot.records.map(item => item.businessKey),
    ...plan.snapshot.tombstones.map(item => item.businessKey)
   ]);
   const conflicts = existingConflicts.filter(item => !processedKeys.has(item.businessKey));
   const detectedAt = Date.now();
   plan.conflicts.forEach(item => conflicts.push({ conflictId: item.conflictId, businessKey: item.businessKey, dataType: item.dataType, baseHash: item.baseHash, localHash: item.localHash, remoteHash: item.remoteHash, detectedAt, status: 'open' }));
   syncStore.upsertScope({
    ...scope,
    publicVersion: plan.snapshot.publicVersion,
    cursor: plan.snapshot.cursor,
    lastSuccessfulCheckAt: detectedAt,
    baseHashes: plan.nextBaseHashes,
    conflicts
   });
   bindingStore.updateBasePublicVersion(binding.localLibraryId, plan.snapshot.publicVersion);
  } catch (error) {
   const rollbackErrors = [];
   try { this.restoreStoreRaw(bindingStore, oldBindingsRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   try { this.restoreStoreRaw(syncStore, oldSyncRaw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
   if (working.changed && !priceStore.restoreSnapshot(oldCanonical, oldLegacy)) rollbackErrors.push(new Error('价格库回滚失败'));
   if (rollbackErrors.length) throw new CloudCollabSnapshotSync.SnapshotSyncError('SYNC_ROLLBACK_INCOMPLETE', '公共更新失败且回滚不完整，云功能已停止', { cause: error?.code || error?.message });
   throw error;
  }
  if (working.changed) {
   this.app.priceLibraries = priceResult.data;
   this.app.priceMemory = priceResult.activeItems;
   this.app.priceMemoryFeature?.updatePriceMemoryUI?.({ forceName: true });
   this.app.priceMemoryFeature?.refreshServicePriceMatchAfterLibraryChange?.();
  }
  return { counts: plan.counts, publicVersion: plan.snapshot.publicVersion, changed: working.changed };
 }
