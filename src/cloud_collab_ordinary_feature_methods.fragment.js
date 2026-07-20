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
  const submission = await CloudCollabOrdinarySubmission.buildPlayableNameSubmission({
   snapshotSync: CloudCollabSnapshotSync,
   base: CloudCollabSubmission,
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   name,
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
  const submission = await CloudCollabOrdinarySubmission.buildBossProfileSubmission({
   snapshotSync: CloudCollabSnapshotSync,
   base: CloudCollabSubmission,
   deviceId: identity.deviceId,
   submissionId: this.submissionIdFactory.submissionId(),
   groupId: binding.groupId,
   libraryId: binding.libraryId,
   bossName: record?.name,
   paiDan: record?.paiDan,
   discount: record?.discount,
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
  const confirmed = Array.isArray(this.app.enhancedExtractor?.data?.confirmedNames)
   ? this.app.enhancedExtractor.data.confirmedNames
   : [];
  const bosses = Array.isArray(this.app.bossMemory) ? this.app.bossMemory : [];
  const jobs = [];
  const seenNames = new Set();
  for (const item of confirmed) {
   const name = String(item?.name || '').normalize?.('NFKC')?.replace(/\s+/gu, ' ').trim() || String(item?.name || '').trim();
   const key = name.toLocaleLowerCase('und');
   if (!name || seenNames.has(key)) continue;
   seenNames.add(key);
   jobs.push({ type: 'playable_name', value: { name } });
  }
  const seenBosses = new Set();
  for (const item of bosses) {
   const name = String(item?.name || '').normalize?.('NFKC')?.replace(/\s+/gu, ' ').trim() || String(item?.name || '').trim();
   const key = name.toLocaleLowerCase('und');
   if (!name || seenBosses.has(key)) continue;
   seenBosses.add(key);
   jobs.push({ type: 'boss_profile', value: item });
  }
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  for (const job of jobs) {
   try {
    const submissionId = this.submissionIdFactory.submissionId();
    const common = {
     snapshotSync: CloudCollabSnapshotSync,
     base: CloudCollabSubmission,
     deviceId: identity.deviceId,
     submissionId,
     groupId: binding.groupId,
     libraryId: binding.libraryId,
     origin: 'initialBinding',
     clientCreatedAt: Date.now(),
     appVersion: '8.2.29-stage5g'
    };
    const submission = job.type === 'playable_name'
     ? await CloudCollabOrdinarySubmission.buildPlayableNameSubmission({ ...common, name: job.value.name })
     : await CloudCollabOrdinarySubmission.buildBossProfileSubmission({
      ...common,
      bossName: job.value?.name,
      paiDan: job.value?.paiDan,
      discount: job.value?.discount
     });
    const result = this.stores.coordinator.enqueueSubmission(binding.localLibraryId, submission);
    if (result.inserted) inserted += 1;
    else skipped += 1;
   } catch (error) {
    invalid += 1;
    appLogSilent(error);
   }
  }
  this.refresh();
  if (inserted) this.scheduleUploadFlush(6000);
  return { inserted, skipped, invalid, status: 'queued' };
 }
