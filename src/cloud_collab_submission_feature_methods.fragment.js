 setPreviewAccessKey(value = '') {
  if (!this.previewSession) return false;
  this.previewSession.accessKey = String(value || '');
  const recoverable = new Set(['PREVIEW_ACCESS_REQUIRED', 'PREVIEW_ACCESS_DENIED']);
  try {
   this.stores.queueStore.list().filter(item => item.deliveryState === 'blocked' && recoverable.has(item.lastErrorCode)).forEach(item => {
    this.stores.queueStore.requeueBlocked(item.submission.submissionId);
   });
  } catch (error) { appLogError('cloudCollabPreviewAccessRequeue', error); }
  this.renderUploadStatus();
  if (this.previewSession.accessKey) this.scheduleUploadFlush(300);
  return true;
 }

 renderUploadStatus() {
  const target = this.app.el.cloudUploadSummary;
  if (!target) return;
  const state = this.app.cloudCollabState || {};
  const credential = this.stores.credentialStore.getRedacted();
  const queue = this.stores.queueStore.list();
  const active = queue.filter(item => item.deliveryState !== 'acknowledged');
  const blocked = active.filter(item => item.deliveryState === 'blocked');
  const retrying = active.filter(item => item.deliveryState === 'retry_wait');
  const accessReady = Boolean(this.previewSession?.accessKey);
  const parts = [
   `设备凭据：${credential ? '已在本机保存' : '尚未注册'}`,
   `待处理：${active.length}`,
   `等待重试：${retrying.length}`,
   `已阻断：${blocked.length}`,
   `预览门禁：${accessReady ? '本次会话已提供' : '未提供'}`
  ];
  const code = state.uploadErrorCode ? `；最近错误 ${state.uploadErrorCode}` : '';
  target.textContent = `${parts.join('；')}${code}。设备令牌不会显示或上传到其他位置。`;
  const failed = blocked.length > 0 || ['credential_blocked', 'completed_with_blocked'].includes(state.uploadStatus);
  target.classList.toggle('is-error', failed);
  target.classList.toggle('is-success', !failed && active.length === 0 && Boolean(credential));
  if (this.app.el.cloudUploadRetryBtn) this.app.el.cloudUploadRetryBtn.disabled = !active.length || !this.submissionApi?.isConfigured?.();
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
  if (!this.previewSession?.accessKey) {
   this.updateUploadState({ uploadStatus: 'preview_access_required', uploadErrorCode: 'PREVIEW_ACCESS_REQUIRED', uploadCheckedAt: Date.now() });
   if (interactive) this.setStatus('预览候选上传尚未获得本次页面会话门禁；未发送网络请求。', 'error');
   return { status: 'preview_access_required' };
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
   else if (result?.blocked) this.setStatus(`候选派发完成：成功 ${result.acknowledged || 0}，等待重试 ${result.retryWait || 0}，阻断 ${result.blocked}。`, 'error');
   else this.setStatus(`候选派发完成：成功 ${result?.acknowledged || 0}，等待重试 ${result?.retryWait || 0}。`, 'success');
  }
  return result;
 }

 async retryRecoverableUploads() {
  const recoverable = new Set(['PREVIEW_ACCESS_REQUIRED', 'PREVIEW_ACCESS_DENIED', 'PREVIEW_WRITE_DISABLED', 'API_TIMEOUT', 'API_UNREACHABLE', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
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

 async enqueueInitialBindingSubmissions(localLibraryId) {
  const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
  if (!binding || binding.mode !== 'collaborate') return { inserted: 0, skipped: 0, status: 'not_collaborative' };
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
