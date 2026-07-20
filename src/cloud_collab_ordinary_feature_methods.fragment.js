 getStage5GCollaborativeBinding(localLibraryId = '') {
  const candidates = this.stores.bindingStore.list().filter(binding => this.isPreviewCollaborativeBinding(binding));
  const requested = String(localLibraryId || '').trim();
  if (requested) return candidates.find(binding => binding.localLibraryId === requested) || null;
  const activeId = this.app.priceLibraryStore?.getActiveLibrary?.(this.app.priceLibraries)?.id || '';
  if (activeId) {
   const active = candidates.find(binding => binding.localLibraryId === activeId);
   if (active) return active;
  }
  return candidates.length === 1 ? candidates[0] : null;
 }

 getStage5GDeviceIdentity() {
  const meta = this.stores.metaStore.loadResult();
  return meta?.ok && meta?.exists && meta.value?.deviceId ? meta.value : null;
 }

 enqueueStage5GSubmission(binding, submission) {
  if (!binding || !submission) return { inserted: false, status: 'invalid' };
  const result = this.stores.coordinator.enqueueSubmission(binding.localLibraryId, submission);
  this.refresh();
  if (result.inserted) this.scheduleUploadFlush(6000);
  return { inserted: Boolean(result.inserted), status: result.inserted ? 'queued' : 'duplicate' };
 }

 async enqueuePlayableNameUserChange(name, localLibraryId = '') {
  const binding = this.getStage5GCollaborativeBinding(localLibraryId);
  if (!binding) return { inserted: false, status: 'collaborative_binding_required' };
  const identity = this.getStage5GDeviceIdentity();
  if (!identity) return { inserted: false, status: 'identity_required' };
  const submission = await CloudCollabOrdinaryTypes.buildOrdinarySubmission({
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   dataType: 'playable_name',
   payload: { name },
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.29-stage5g'
  });
  return this.enqueueStage5GSubmission(binding, submission);
 }

 async enqueueBossProfileUserChange(record, localLibraryId = '') {
  const binding = this.getStage5GCollaborativeBinding(localLibraryId);
  if (!binding) return { inserted: false, status: 'collaborative_binding_required' };
  const identity = this.getStage5GDeviceIdentity();
  if (!identity) return { inserted: false, status: 'identity_required' };
  const submission = await CloudCollabOrdinaryTypes.buildOrdinarySubmission({
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   dataType: 'boss_profile',
   payload: {
    bossName: record?.name ?? record?.bossName,
    paiDan: record?.paiDan,
    discount: record?.discount
   },
   origin: 'user',
   clientCreatedAt: Date.now(),
   appVersion: '8.2.29-stage5g'
  });
  return this.enqueueStage5GSubmission(binding, submission);
 }

 async enqueueInitialOrdinarySubmissions(localLibraryId) {
  const binding = this.getStage5GCollaborativeBinding(localLibraryId);
  if (!binding) return { inserted: 0, skipped: 0, invalid: 0, status: 'collaborative_binding_required' };
  const identity = this.getStage5GDeviceIdentity();
  if (!identity) return { inserted: 0, skipped: 0, invalid: 0, status: 'identity_required' };
  const confirmedNames = Array.isArray(this.app.enhancedExtractor?.data?.confirmedNames)
   ? this.app.enhancedExtractor.data.confirmedNames
   : [];
  const bossMemory = Array.isArray(this.app.bossMemory) ? this.app.bossMemory : [];
  const plan = await CloudCollabOrdinaryTypes.planInitialOrdinarySubmissions({
   deviceId: identity.deviceId,
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   confirmedNames,
   bossMemory,
   baseHashes: {},
   submissionIdFactory: () => this.submissionIdFactory.submissionId(),
   now: () => Date.now(),
   appVersion: '8.2.29-stage5g'
  });
  let inserted = 0;
  let duplicate = 0;
  for (const submission of plan.submissions) {
   const result = this.stores.coordinator.enqueueSubmission(binding.localLibraryId, submission);
   if (result.inserted) inserted += 1;
   else duplicate += 1;
  }
  this.refresh();
  if (inserted) this.scheduleUploadFlush(6000);
  return {
   inserted,
   skipped: duplicate + Number(plan.skipped?.alreadyPublic || 0) + Number(plan.skipped?.duplicate || 0),
   invalid: Number(plan.skipped?.invalid || 0),
   status: 'queued'
  };
 }
