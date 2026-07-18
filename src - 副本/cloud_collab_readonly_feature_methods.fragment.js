 scheduleReadonlyCheck() {
  if (this._readonlyCheckScheduled) return false;
  this._readonlyCheckScheduled = true;
  setTimeout(() => this.checkServer({ interactive: false }), 0);
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
   idle: '尚未检查只读测试接口。',
   not_configured: '本地文件未配置API地址；不会自动联网。部署到EdgeOne同一站点后将使用同源接口。',
   checking: '正在异步检查只读测试接口……',
   online: `只读测试接口在线；协议版本 ${state.serverProtocolVersion ?? '未知'}。`,
   protocol_mismatch: `服务器在线，但协议版本 ${state.serverProtocolVersion ?? '未知'} 与客户端版本 ${CloudCollabReadonly.CLIENT_PROTOCOL_VERSION} 不兼容。`,
   offline: `只读测试接口暂不可用${state.serverErrorCode ? `（${state.serverErrorCode}）` : ''}；正常码单不受影响。`
  };
  if (summary) {
   summary.textContent = labels[status] || labels.idle;
   summary.classList.toggle('is-success', status === 'online');
   summary.classList.toggle('is-error', status === 'offline' || status === 'protocol_mismatch');
  }
  if (badge) {
   badge.textContent = ({ online: '只读 · 在线', checking: '只读 · 检查中', offline: '只读 · 离线', protocol_mismatch: '只读 · 协议不兼容', not_configured: '只读 · 未配置' })[status] || '只读 · 待检查';
  }
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
   const compatible = health.status === 'ok' && remoteVersion === CloudCollabReadonly.CLIENT_PROTOCOL_VERSION && protocol.writeEnabled === false;
   this.lastServerError = null;
   this.updateServerState({
    serverStatus: compatible ? 'online' : 'protocol_mismatch',
    serverProtocolVersion: Number.isInteger(remoteVersion) ? remoteVersion : null,
    serverCheckedAt: Date.now(),
    serverErrorCode: compatible ? null : 'PROTOCOL_MISMATCH'
   });
   if (interactive) this.setStatus(compatible ? '只读测试接口检查通过。' : '服务器协议不兼容；未启用任何云端数据操作。', compatible ? 'success' : 'error');
   return { health, protocol, compatible };
  } catch (error) {
   this.lastServerError = error;
   if (!['API_UNREACHABLE', 'API_TIMEOUT', 'TEST_OFFLINE'].includes(error?.code)) appLogError('cloudCollabReadonlyCheck', error);
   this.updateServerState({ serverStatus: 'offline', serverProtocolVersion: null, serverCheckedAt: Date.now(), serverErrorCode: error?.code || 'API_UNREACHABLE' });
   if (interactive) this.setStatus(`只读测试接口不可用：${error?.message || '连接失败'}。正常码单不受影响。`, 'error');
   return null;
  }
 }

 renderPublicVersionSummary() {
  const target = this.app.el.cloudPublicVersionSummary;
  if (!target) return;
  const binding = this.stores.bindingStore.getByLocalLibraryId(this.selectedLocalLibraryId || '');
  const data = this.lastPublicVersion;
  if (!binding) {
   target.textContent = '当前价格库尚未绑定，无法检查公共版本。';
   target.classList.remove('is-success', 'is-error');
   return;
  }
  if (!data || data.groupId !== binding.groupId || data.libraryId !== binding.libraryId) {
   target.textContent = '公共版本尚未检查；检查结果只显示在本页，不写入本地价格库。';
   target.classList.remove('is-success', 'is-error');
   return;
  }
  target.textContent = `公共版本：${data.publicVersion}；快照版本：${data.snapshotVersion}；状态：${data.status}。`;
  target.classList.add('is-success');
  target.classList.remove('is-error');
 }

 async checkSelectedPublicVersion() {
  const localLibraryId = this.app.el.cloudLocalLibrarySelect?.value || '';
  const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
  if (!binding) return this.setStatus('请先保存当前价格库的公共绑定。', 'error');
  if (!this.apiClient?.isConfigured?.()) return this.setStatus('当前文件未配置只读测试接口。', 'error');
  try {
   const data = await this.apiClient.publicVersion(binding.groupId, binding.libraryId);
   this.lastPublicVersion = data;
   this.renderPublicVersionSummary();
   this.setStatus(`已读取公共版本 ${data.publicVersion}；未修改任何本地业务数据。`, 'success');
   return data;
  } catch (error) {
   if (!['PUBLIC_LIBRARY_NOT_FOUND', 'API_UNREACHABLE', 'API_TIMEOUT', 'TEST_OFFLINE'].includes(error?.code)) appLogError('cloudCollabPublicVersion', error);
   this.lastPublicVersion = null;
   const target = this.app.el.cloudPublicVersionSummary;
   if (target) {
    target.textContent = `公共版本检查失败：${error?.message || '请求失败'}${error?.code ? `（${error.code}）` : ''}`;
    target.classList.add('is-error');
    target.classList.remove('is-success');
   }
   this.setStatus('公共版本检查失败；本地绑定和价格库未改变。', 'error');
   return null;
  }
 }
