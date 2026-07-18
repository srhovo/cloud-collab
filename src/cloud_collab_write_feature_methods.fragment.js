 renderWriteStatus() {
  const target = this.app.el.cloudWriteSummary;
  const registerBtn = this.app.el.cloudDeviceRegisterBtn;
  const dispatchBtn = this.app.el.cloudQueueDispatchBtn;
  const enabled = Boolean(this.writeClient?.isWriteEnabled?.());
  const credential = this.stores.credentialStore.getRedacted();
  const state = this.app.cloudCollabState?.writeState || null;
  const active = this.stores.queueStore.list().filter(item => item.deliveryState !== 'acknowledged');
  if (registerBtn) registerBtn.disabled = !enabled || Boolean(credential);
  if (dispatchBtn) dispatchBtn.disabled = !enabled || active.length === 0;
  if (!target) return;
  if (!enabled) {
   target.textContent = `上传门禁关闭；待上传 ${active.length} 条仅保存在本机，不会发送网络请求。`;
   target.classList.remove('is-success', 'is-error');
   return;
  }
  const credentialText = credential ? `设备凭据已保存（令牌版本 ${credential.tokenVersion}）` : '设备尚未注册';
  const stateText = state?.status ? `；最近派发：${state.status}${state.errorCode ? `（${state.errorCode}）` : ''}` : '';
  target.textContent = `${credentialText}；待上传 ${active.length} 条${stateText}。云端失败不影响正常码单和本地保存。`;
  target.classList.toggle('is-success', Boolean(credential) && !state?.errorCode);
  target.classList.toggle('is-error', Boolean(state?.errorCode) && !['NETWORK_OFFLINE', 'WRITE_CLIENT_DISABLED'].includes(state.errorCode));
 }

 async registerCloudDevice() {
  if (!this.writeClient?.isWriteEnabled?.()) {
   this.setStatus('8.2.28上传门禁当前关闭；未发送设备信息。', 'success');
   return null;
  }
  try {
   let metaResult = this.stores.metaStore.loadResult();
   if (metaResult.ok && !metaResult.exists) {
    this.stores.coordinator.initializeIdentity({ nickname: this.app.el.cloudNicknameInput?.value || null });
    metaResult = this.stores.metaStore.loadResult();
   }
   if (!metaResult.ok || !metaResult.exists) throw metaResult.error || new Error('无法创建本地设备身份');
   const redacted = await this.writeClient.registerDevice({ meta: metaResult.value, credentialStore: this.stores.credentialStore });
   this.renderWriteStatus();
   this.setStatus(`设备注册完成：${redacted.deviceId}。明文设备令牌仅保存在本地专用凭据区。`, 'success');
   return redacted;
  } catch (error) {
   appLogError('cloudCollabDeviceRegister', { code: error?.code || 'DEVICE_REGISTER_FAILED', status: error?.status || 0 });
   this.renderWriteStatus();
   this.setStatus(`设备注册失败：${error?.message || '请求失败'}${error?.code ? `（${error.code}）` : ''}。本地功能不受影响。`, 'error');
   return null;
  }
 }

 async dispatchCloudQueue({ interactive = true, reason = 'manual' } = {}) {
  const result = await this.dispatcher?.dispatchDue?.({ reason });
  this.refresh();
  this.renderWriteStatus();
  if (interactive && result) {
   const message = result.status === 'disabled'
    ? '上传门禁关闭；队列保持在本机，未发送网络请求。'
    : result.status === 'offline'
     ? '当前断网；队列保持在本机，联网后再试。'
     : `队列派发完成：确认 ${result.acknowledged}，重试 ${result.retried}，阻断 ${result.blocked}。`;
   this.setStatus(message, result.blocked ? 'error' : 'success');
  }
  return result;
 }

 async enqueueInitialBindingCandidates(binding) {
  if (!binding || binding.mode !== 'collaborate') return { status: 'not_collaborative' };
  const metaResult = this.stores.metaStore.loadResult();
  if (!metaResult.ok || !metaResult.exists) return { status: 'identity_missing' };
  const library = this.getPriceLibraries().find(item => item.id === binding.localLibraryId);
  if (!library) return { status: 'local_library_missing' };
  const scope = this.stores.syncStore.getScope(binding.groupId, binding.libraryId) || { baseHashes: {}, conflicts: [] };
  this._submissionIdFactory ||= CloudCollabLocalStores.createIdFactory();
  const plan = await CloudCollabSubmissionBuilder.buildInitialBindingCandidates({
   meta: metaResult.value,
   binding,
   localItems: library.items || [],
   baseHashes: scope.baseHashes || {},
   conflicts: scope.conflicts || [],
   existingQueueRecords: this.stores.queueStore.list(),
   idFactory: this._submissionIdFactory,
   snapshotApi: CloudCollabSnapshotSync,
   localStoresApi: CloudCollabLocalStores
  });
  let inserted = 0;
  for (const submission of plan.candidates) {
   const result = this.stores.coordinator.enqueueSubmission(binding.localLibraryId, submission);
   if (result.inserted) inserted += 1;
  }
  this.refresh();
  this.renderWriteStatus();
  return { status: 'queued', inserted, ...plan };
 }

 async handleCollaborativeBindingReady(binding, syncResult) {
  if (!binding || binding.mode !== 'collaborate') return null;
  const comparableStatuses = new Set(['not_modified', 'snapshot_unavailable', 'completed', 'completed_with_conflicts']);
  if (!syncResult || !comparableStatuses.has(syncResult.status)) {
   this.setStatus('参与协作绑定已保存，但公共库比较尚未成功；不会提前生成上传候选。', 'error');
   return null;
  }
  try {
   const result = await this.enqueueInitialBindingCandidates(binding);
   const counts = result?.counts || {};
   this.setStatus(`首次绑定比较完成：新增本地候选 ${result?.inserted || 0}，已公开 ${counts.alreadyPublic || 0}，冲突暂不提交 ${counts.openConflicts || 0}，无效项 ${counts.invalid || 0}。`, counts.openConflicts || counts.invalid ? 'error' : 'success');
   if (this.writeClient?.isWriteEnabled?.()) setTimeout(() => { void this.dispatchCloudQueue({ interactive: false, reason: 'initial_binding' }); }, 0);
   return result;
  } catch (error) {
   appLogError('cloudCollabInitialBindingQueue', { code: error?.code || 'INITIAL_BINDING_QUEUE_FAILED' });
   this.setStatus(`首次绑定候选生成失败：${error?.message || '处理失败'}。本地价格未受影响。`, 'error');
   return null;
  }
 }

 scheduleWriteDispatcher() {
  const started = this.dispatcher?.start?.({ intervalMs: 60000 }) || false;
  this.renderWriteStatus();
  return started;
 }
