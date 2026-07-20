 getStage6BSensitiveDispatcher() {
  if (this._stage6bSensitiveDispatcher) return this._stage6bSensitiveDispatcher;
  const apiClient = new CloudCollabSensitiveRules.SensitiveSubmissionApiClient({ baseClient: this.submissionApi });
  this._stage6bSensitiveDispatcher = new CloudCollabSensitiveRules.SensitiveSubmissionDispatcher({
   apiClient,
   metaStore: this.stores.metaStore,
   credentialStore: this.stores.credentialStore,
   queueStore: this.stores.queueStore,
   bindingStore: this.stores.bindingStore,
   appVersion: '8.2.31-stage6b',
   now: () => Date.now(),
   onState: state => {
    this.app.cloudCollabState = { ...(this.app.cloudCollabState || {}), sensitiveUploadStatus: state.status, sensitiveUploadErrorCode: state.errorCode || null };
    this.refresh();
   }
  });
  return this._stage6bSensitiveDispatcher;
 }

 scheduleStage6BSensitiveFlush(delay = 1200) {
  clearTimeout(this._stage6bSensitiveFlushTimer);
  this._stage6bSensitiveFlushTimer = setTimeout(() => {
   this.getStage6BSensitiveDispatcher().flush({ limit: 10 }).catch(error => appLogSilent(error));
  }, Math.max(0, Number(delay) || 0));
 }

 enqueueStage6BSensitiveSubmission(binding, submission) {
  if (!binding || !submission) return { inserted: false, status: 'invalid' };
  const result = this.stores.coordinator.enqueueSubmission(binding.localLibraryId, submission);
  this.refresh();
  if (result.inserted) this.scheduleStage6BSensitiveFlush();
  return { inserted: Boolean(result.inserted), status: result.inserted ? 'queued' : 'duplicate' };
 }

 projectStage6BRulePayload(dataType, record) {
  if (dataType === 'rank_range_rule') return CloudCollabSensitiveMerge.rangePayload(record);
  if (dataType === 'surcharge_rule') return CloudCollabSensitiveMerge.surchargePayload(record);
  if (dataType === 'gift_rule') return CloudCollabSensitiveMerge.giftPayload(record);
  throw new Error('不支持的敏感规则类型');
 }

 async enqueueSensitiveRuleUserChange(dataType, record, localLibraryId = '') {
  const binding = this.getStage5GCollaborativeBinding(localLibraryId);
  if (!binding) return { inserted: false, status: 'collaborative_binding_required' };
  const identity = this.getStage5GDeviceIdentity();
  if (!identity) return { inserted: false, status: 'identity_required' };
  const submission = await CloudCollabSensitiveRules.buildSensitiveSubmission({
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   dataType,
   operation: 'upsert',
   payload: this.projectStage6BRulePayload(dataType, record),
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.31-stage6b'
  });
  return this.enqueueStage6BSensitiveSubmission(binding, submission);
 }

 async buildStage6BIdentitySubmission(binding, identity, dataType, record) {
  const common = {
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.31-stage6b'
  };
  if (['rank_range_rule', 'surcharge_rule', 'gift_rule'].includes(dataType)) {
   return CloudCollabSensitiveRules.buildSensitiveSubmission({
    ...common,
    dataType,
    operation: 'upsert',
    payload: this.projectStage6BRulePayload(dataType, record)
   });
  }
  if (dataType === 'exact_price') {
   return CloudCollabSubmission.buildExactPriceSubmission({
    ...common,
    snapshotSync: CloudCollabSnapshotSync,
    serviceName: record?.serviceType ?? record?.serviceName,
    settleType: record?.settleType,
    unitPrice: record?.unitPrice
   });
  }
  if (dataType === 'playable_name') {
   return CloudCollabOrdinaryTypes.buildOrdinarySubmission({ ...common, dataType, payload: { name: record?.name } });
  }
  if (dataType === 'boss_profile') {
   return CloudCollabOrdinaryTypes.buildOrdinarySubmission({
    ...common,
    dataType,
    payload: { bossName: record?.name ?? record?.bossName, paiDan: record?.paiDan, discount: record?.discount }
   });
  }
  throw new Error('不支持的显式删除类型');
 }

 async enqueueSensitiveDeleteUserChange(dataType, record, localLibraryId = '') {
  const binding = this.getStage5GCollaborativeBinding(localLibraryId);
  if (!binding) return { inserted: false, status: 'collaborative_binding_required' };
  const identity = this.getStage5GDeviceIdentity();
  if (!identity) return { inserted: false, status: 'identity_required' };
  const identitySubmission = await this.buildStage6BIdentitySubmission(binding, identity, dataType, record);
  const deletion = await CloudCollabSensitiveRules.buildSensitiveSubmission({
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   dataType,
   operation: 'delete',
   payload: null,
   businessKey: identitySubmission.businessKey,
   bossId: identitySubmission.bossId,
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.31-stage6b'
  });
  return this.enqueueStage6BSensitiveSubmission(binding, deletion);
 }

 retrySensitiveUploads() {
  return this.getStage6BSensitiveDispatcher().flush({ limit: 20 });
 }
