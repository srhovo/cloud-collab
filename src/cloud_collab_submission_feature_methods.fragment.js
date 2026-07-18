 renderUploadStatus() {
  const target = this.app.el.cloudUploadSummary;
  if (!target) return;
  const state = this.app.cloudCollabState || {};
  let credential = null;
  let queue = [];
  try { credential = this.stores.credentialStore.getRedacted(); } catch (error) { appLogSilent(error); }
  try { queue = this.stores.queueStore.list(); } catch (error) { appLogSilent(error); }
  const active = queue.filter(item => item.deliveryState !== 'acknowledged');
  const blocked = active.filter(item => item.deliveryState === 'blocked');
  const retrying = active.filter(item => item.deliveryState === 'retry_wait');
  const gateReady = Boolean(this.submissionApi?.hasWriteAccess?.());
  const parts = [
   `设备凭据：${credential ? '已在本机专用区保存' : '尚未注册'}`,
   `待处理：${active.length}`,
   `等待重试：${retrying.length}`,
   `已阻断：${blocked.length}`,
   `候选上传门禁：${gateReady ? '受控运行时已开启' : '关闭'}`
  ];
  const code = state.uploadErrorCode ? `；最近状态 ${state.uploadErrorCode}` : '';
  target.textContent = `${parts.join('；')}${code}。设备令牌不会显示、不会进入队列或普通备份；页面不接受用户输入任何密钥。`;
  const failed = blocked.length > 0 || ['credential_blocked', 'completed_with_blocked'].includes(state.uploadStatus);
  target.classList.toggle('is-error', failed);
  target.classList.toggle('is-success', !failed && active.length === 0 && Boolean(credential));
  if (this.app.el.cloudUploadRetryBtn) this.app.el.cloudUploadRetryBtn.disabled = !active.length || !this.submissionApi?.isConfigured?.();
 }

 handleSubmissionState(state = {}) {
  return this.updateUploadState({
   uploadStatus: state.status || 'idle',
   uploadErrorCode: state.errorCode || null,
   uploadErrorCategory: state.category || null,
   uploadCheckedAt: state.at || Date.now()
  });
 }

 updateUploadState(patch = {}) {
  this.app.cloudCollabState = { ...(this.app.cloudCollabState || {}), ...patch };
  this.renderUploadStatus();
  return this.app.cloudCollabState;
 }

 scheduleUploadFlush(delay = 6000) {
  if (this._uploadFlushTimer) clearTimeout(this._uploadFlushTimer);
  this._uploadFlushTimer = setTimeout(() => {
   this._uploadFlushTimer = null;
   this.flushPendingUploads({ interactive: false });
  }, Math.max(0, Number(delay) || 0));
  return true;
 }

 scheduleSubmissionDispatch() {
  if (this._submissionDispatchScheduled) return false;
  this._submissionDispatchScheduled = true;
  this._uploadOnlineHandler = () => this.scheduleUploadFlush(400);
  if (typeof window !== 'undefined') window.addEventListener('online', this._uploadOnlineHandler);
  this.scheduleUploadFlush(6000);
  this._uploadPollTimer = setInterval(() => {
   if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
   this.flushPendingUploads({ interactive: false });
  }, 60000);
  return true;
 }

 async flushPendingUploads({ interactive = false } = {}) {
  if (!this.submissionDispatcher) return null;
  if (!this.submissionApi?.hasWriteAccess?.()) {
   const result = { status: 'write_gate_closed', errorCode: 'WRITE_GATE_CLOSED', category: 'write_gate' };
   this.updateUploadState({ uploadStatus: result.status, uploadErrorCode: result.errorCode, uploadErrorCategory: result.category, uploadCheckedAt: Date.now() });
   if (interactive) this.setStatus('候选上传运行时门禁保持关闭；未发送网络请求，本地码单不受影响。', 'success');
   return result;
  }
  this.updateUploadState({ uploadStatus: 'sending', uploadErrorCode: null, uploadCheckedAt: Date.now() });
  const result = await this.submissionDispatcher.flush({ limit: 10 });
  this.updateUploadState({
   uploadStatus: result?.status || 'idle',
   uploadErrorCode: result?.errorCode || null,
   uploadErrorCategory: result?.category || null,
   uploadCheckedAt: Date.now()
  });
  this.refresh();
  if (interactive) {
   if (result?.status === 'offline') this.setStatus('当前离线，待上传队列保持原状；正常码单不受影响。', 'success');
   else if (result?.status === 'write_gate_closed') this.setStatus('候选上传运行时门禁关闭；队列保持本地，不影响正常码单。', 'success');
   else if (result?.blocked) this.setStatus(`候选派发完成：成功 ${result.acknowledged || 0}，等待重试 ${result.retryWait || 0}，阻断 ${result.blocked}。`, 'error');
   else this.setStatus(`候选派发完成：成功 ${result?.acknowledged || 0}，等待重试 ${result?.retryWait || 0}。`, 'success');
  }
  return result;
 }

 async retryRecoverableUploads() {
  const recoverable = new Set(['PREVIEW_WRITE_DISABLED', 'API_TIMEOUT', 'API_UNREACHABLE', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
  let requeued = 0;
  try {
   this.stores.queueStore.list().filter(item => item.deliveryState === 'blocked' && recoverable.has(item.lastErrorCode)).forEach(item => {
    this.stores.queueStore.requeueBlocked(item.submission.submissionId);
    requeued += 1;
   });
  } catch (error) { appLogError('cloudCollabUploadRequeue', error); }
  if (requeued) this.refresh();
  return this.flushPendingUploads({ interactive: true });
 }

 getBoundLocalLibrary(binding) {
  const data = this.app.priceLibraryStore.normalizeData(this.app.priceLibraries);
  return data?.libraries?.find(item => item.id === binding?.localLibraryId) || null;
 }

 isPreviewCollaborativeBinding(binding) {
  return Boolean(binding && binding.mode === 'collaborate'
   && binding.groupId === CloudCollabSubmission.PREVIEW_ALLOWED_GROUP_ID
   && binding.libraryId === CloudCollabSubmission.PREVIEW_ALLOWED_LIBRARY_ID);
 }

 async enqueueInitialBindingSubmissions(localLibraryId) {
  const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
  if (!binding || binding.mode !== 'collaborate') return { inserted: 0, skipped: 0, status: 'not_collaborative' };
  if (!this.isPreviewCollaborativeBinding(binding)) return { inserted: 0, skipped: 0, status: 'preview_scope_only' };
  const meta = this.stores.metaStore.loadResult();
  if (!meta.ok || !meta.exists) return { inserted: 0, skipped: 0, status: 'identity_required' };
  const library = this.getBoundLocalLibrary(binding);
  if (!library) return { inserted: 0, skipped: 0, status: 'library_missing' };
  const scope = this.stores.syncStore.getScope(binding.groupId, binding.libraryId);
  const plan = await CloudCollabSubmission.planInitialExactPriceSubmissions({
   snapshotSync: CloudCollabSnapshotSync,
   deviceId: meta.value.deviceId,
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   localItems: library.items || [],
   baseHashes: scope?.baseHashes || {},
   submissionIdFactory: () => this.submissionIdFactory.submissionId(),
   now: () => Date.now(),
   appVersion: '8.2.28'
  });
  let inserted = 0;
  for (const submission of plan.submissions) {
   const result = this.stores.coordinator.enqueueSubmission(localLibraryId, submission);
   if (result.inserted) inserted += 1;
  }
  this.refresh();
  if (inserted) this.scheduleUploadFlush(6000);
  return { inserted, skipped: plan.submissions.length - inserted, details: plan.skipped, status: 'queued' };
 }

 async enqueueExactPriceUserChange(localLibraryId, record) {
  const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
  if (!binding || binding.mode !== 'collaborate') return { inserted: false, status: 'not_collaborative' };
  if (!this.isPreviewCollaborativeBinding(binding)) return { inserted: false, status: 'preview_scope_only' };
  const settleType = String(record?.settleType || '').trim().toLowerCase();
  if (!['round', 'hour'].includes(settleType)) return { inserted: false, status: 'unsupported' };
  const meta = this.stores.metaStore.loadResult();
  if (!meta.ok || !meta.exists) return { inserted: false, status: 'identity_required' };
  const hashes = await CloudCollabSnapshotSync.computeExactPriceHashes(binding.groupId, binding.libraryId, {
   serviceName: record?.serviceType,
   settleType,
   unitPrice: record?.unitPrice
  });
  const scope = this.stores.syncStore.getScope(binding.groupId, binding.libraryId);
  if (scope?.baseHashes?.[hashes.businessKey] === hashes.contentHash) return { inserted: false, status: 'already_public' };
  const submission = await CloudCollabSubmission.buildExactPriceSubmission({
   snapshotSync: CloudCollabSnapshotSync,
   deviceId: meta.value.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   serviceName: hashes.payload.serviceName,
   settleType: hashes.payload.settleType,
   unitPrice: hashes.payload.unitPrice,
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.28'
  });
  const result = this.stores.coordinator.enqueueSubmission(localLibraryId, submission);
  this.refresh();
  if (result.inserted) this.scheduleUploadFlush(6000);
  return { inserted: Boolean(result.inserted), status: result.inserted ? 'queued' : 'duplicate' };
 }
