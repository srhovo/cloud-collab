(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const navButtons = [...document.querySelectorAll('[data-module]')];
  const els = {
    sessionChip: $('sessionChip'), username: $('username'), password: $('password'),
    loginBtn: $('loginBtn'), sessionBtn: $('sessionBtn'), logoutBtn: $('logoutBtn'), authStatus: $('authStatus'),
    exactStatus: $('exactStatus'), exactList: $('exactList'), ordinaryStatus: $('ordinaryStatus'), ordinaryList: $('ordinaryList'),
    sensitiveStatus: $('sensitiveStatus'), sensitiveList: $('sensitiveList'), devicesStatus: $('devicesStatus'), devicesList: $('devicesList'),
    deviceDetailCard: $('deviceDetailCard'), deviceDetail: $('deviceDetail'), blockReason: $('blockReason'), trustBtn: $('trustBtn'),
    revokeTrustBtn: $('revokeTrustBtn'), blockBtn: $('blockBtn'), unblockBtn: $('unblockBtn'), deviceMutationStatus: $('deviceMutationStatus'),
    rollbackStatus: $('rollbackStatus'), rollbackList: $('rollbackList'), downloadBtn: $('downloadBtn'), exportStatus: $('exportStatus'),
    exportFacts: $('exportFacts'), exportPublicVersion: $('exportPublicVersion'), exportRecordCount: $('exportRecordCount'),
    exportTombstoneCount: $('exportTombstoneCount'), exportOrdinaryEventCount: $('exportOrdinaryEventCount'),
    exportSensitiveEventCount: $('exportSensitiveEventCount'), exportFileCount: $('exportFileCount'), exportBytes: $('exportBytes'),
    exportPackageSuffix: $('exportPackageSuffix'), downloadLink: $('downloadLink'),
  };
  const state = { authenticated: false, busy: false, selectedDeviceRef: '', sensitiveDetails: new Map(), objectUrl: '' };

  function node(tag, value = '', className = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(value ?? '');
    return element;
  }
  function pill(value, kind = '') { return node('span', value, `pill ${kind}`.trim()); }
  function meta(container, label, value) { container.append(node('span', `${label}：${value}`)); }
  function setStatus(element, message, kind = '') { element.className = `status ${kind}`.trim(); element.textContent = message; }
  function formatTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '—'; }
  function formatBytes(value) { const n = Number(value || 0); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`; }
  function pretty(value) { return value === null || value === undefined ? '（无）' : JSON.stringify(value, null, 2); }
  function randomId(prefix) {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    const suffix = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${prefix}${suffix}`;
  }
  function errorText(error) { return `错误码：${String(error?.code || 'ADMIN_CONSOLE_REQUEST_FAILED')}\n${String(error?.message || '请求失败')}`; }
  function isAuthError(code, status) { return status === 401 || ['ADMIN_SESSION_MISSING', 'ADMIN_SESSION_INVALID', 'ADMIN_SESSION_EXPIRED'].includes(String(code || '')); }

  function setBusy(value) {
    state.busy = Boolean(value);
    for (const control of document.querySelectorAll('button,input,select,textarea')) {
      if (control === els.username || control === els.password) control.disabled = state.busy;
      else if (control.tagName === 'BUTTON') {
        const lockedModule = !state.authenticated && control.dataset.module && control.dataset.module !== 'auth';
        control.disabled = state.busy || control.dataset.permanentDisabled === '1' || lockedModule;
      }
    }
  }
  function revokeDownload() {
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = ''; }
    els.downloadLink.removeAttribute('href');
  }
  function clearBusinessData() {
    state.selectedDeviceRef = ''; state.sensitiveDetails.clear(); revokeDownload();
    for (const list of [els.exactList, els.ordinaryList, els.sensitiveList, els.devicesList, els.rollbackList]) list.replaceChildren();
    els.deviceDetail.replaceChildren(); els.deviceDetailCard.classList.add('hidden'); els.exportFacts.classList.add('hidden');
    for (const [element, message] of [[els.exactStatus, '尚未读取。'], [els.ordinaryStatus, '尚未读取。'], [els.sensitiveStatus, '尚未读取。'], [els.devicesStatus, '尚未读取。'], [els.deviceMutationStatus, '请选择设备。'], [els.rollbackStatus, '尚未读取。'], [els.exportStatus, '尚未读取。']]) setStatus(element, message);
  }
  function showModule(name) {
    for (const section of document.querySelectorAll('.module')) section.hidden = section.id !== `module-${name}`;
    for (const button of navButtons) button.setAttribute('aria-selected', String(button.dataset.module === name));
  }
  function setAuthenticated(session) {
    state.authenticated = true;
    els.sessionChip.textContent = `${session.username} · 会话…${session.sessionIdSuffix} · 到期 ${formatTime(session.expiresAt)}`;
    for (const button of navButtons) button.disabled = false;
    setBusy(false);
  }
  function setLoggedOut(message = '未登录') {
    state.authenticated = false; els.password.value = ''; els.sessionChip.textContent = message;
    for (const button of navButtons) button.disabled = button.dataset.module !== 'auth';
    clearBusinessData(); showModule('auth'); setBusy(false);
  }

  async function jsonApi(path, init = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', ...init });
    } catch (_) {
      const error = new Error('无法连接正式管理员接口。'); error.code = 'ADMIN_CONSOLE_NETWORK_ERROR'; throw error;
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `管理员接口请求失败（HTTP ${response.status}）`);
      error.code = payload?.error?.code || `HTTP_${response.status}`; error.status = response.status;
      if (isAuthError(error.code, response.status)) setLoggedOut('会话失效');
      throw error;
    }
    return payload.data;
  }
  function assertProduction(data) {
    const caps = data?.capabilities || {};
    if (caps.productionAdmin !== true || caps.syntheticFixtureOnly !== false || data?.stablePromotionAuthorized !== false) {
      const error = new Error('服务器未保持正式管理员权限边界。'); error.code = 'ADMIN_CONSOLE_PRODUCTION_BOUNDARY_INVALID'; throw error;
    }
  }

  async function login() {
    if (state.busy) return;
    const username = String(els.username.value || '').trim(); let password = String(els.password.value || '');
    if (!username || !password) { setStatus(els.authStatus, '请输入管理员用户名和密码。', 'error'); return; }
    let body = JSON.stringify({ schemaVersion: 1, username, password }); password = ''; els.password.value = '';
    setBusy(true); setStatus(els.authStatus, '正在同源验证；密码输入框已清空……');
    try {
      const session = await jsonApi('/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      body = ''; if (!session?.authenticated) throw new Error('服务器未建立有效管理员会话。');
      setAuthenticated(session); setStatus(els.authStatus, '登录成功；正式短时HttpOnly会话已建立。', 'ok');
    } catch (error) { body = ''; setLoggedOut(); setStatus(els.authStatus, errorText(error), 'error'); }
    finally { setBusy(false); }
  }
  async function checkSession({ quiet = false } = {}) {
    if (state.busy) return; setBusy(true); if (!quiet) setStatus(els.authStatus, '正在检查正式管理员会话……');
    try {
      const session = await jsonApi('/api/admin/auth/session'); if (!session?.authenticated) throw new Error('管理员会话无效。');
      setAuthenticated(session); setStatus(els.authStatus, '正式管理员会话有效。', 'ok');
    } catch (error) {
      setLoggedOut(); if (!quiet) setStatus(els.authStatus, isAuthError(error?.code, error?.status) ? '当前没有有效管理员会话。' : errorText(error), isAuthError(error?.code, error?.status) ? '' : 'error');
    } finally { setBusy(false); }
  }
  async function logout() {
    if (state.busy) return; setBusy(true);
    try { await jsonApi('/api/admin/auth/logout', { method: 'POST' }); setLoggedOut('已退出'); setStatus(els.authStatus, '已退出；会话Cookie和页面业务数据均已清除。', 'ok'); }
    catch (error) { setStatus(els.authStatus, errorText(error), 'error'); }
    finally { setBusy(false); }
  }
  async function mutate(path, body, statusElement, label, refresh) {
    if (state.busy) return; setBusy(true); setStatus(statusElement, '正在写入不可变决定与审计……');
    try { const data = await jsonApi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assertProduction(data); setBusy(false); await refresh(); setStatus(statusElement, label, 'ok'); }
    catch (error) { setStatus(statusElement, errorText(error), 'error'); setBusy(false); }
  }

  function exactNode(item) {
    const article = node('article', '', 'item'), head = node('div', '', 'item-head');
    head.append(node('h3', item.serviceName || `审核 …${String(item.reviewId).slice(-8)}`), pill(item.reason || '人工审核'));
    article.append(head, node('div', `${item.baseline?.unitPrice ?? '新增'} → ${item.candidateUnitPrice} 元/${item.settleType === 'round' ? '局' : '小时'}`, 'summary'));
    const information = node('div', '', 'meta'); meta(information, '设备证据', `${item.distinctDeviceCount ?? '—'} 台`); meta(information, '基线状态', item.baseline?.stillCurrent === false ? '已过期' : '当前有效'); meta(information, '收到时间', formatTime(item.receivedAt)); meta(information, '审核尾标', `…${String(item.reviewId || '').slice(-8)}`); article.append(information);
    const grid = node('div', '', 'grid'), price = document.createElement('input'), reason = document.createElement('select');
    price.type = 'number'; price.min = '0.001'; price.max = '1000000'; price.step = '0.001'; price.value = String(item.candidateUnitPrice ?? ''); price.setAttribute('aria-label', '编辑后单价');
    for (const [value, label] of [['invalid_price', '价格无效'], ['insufficient_evidence', '证据不足'], ['conflicting_candidates', '候选冲突'], ['outdated_baseline', '基线过期'], ['unsupported_change', '不支持的变更']]) { const option = node('option', label); option.value = value; reason.append(option); }
    reason.setAttribute('aria-label', '精确价格拒绝原因'); grid.append(price, reason); article.append(grid);
    const actions = node('div', '', 'actions'), approve = node('button', '批准候选值'), reject = node('button', '拒绝候选', 'danger'), edit = node('button', '按输入值批准', 'secondary');
    if (item.baseline?.stillCurrent === false) { approve.disabled = true; edit.disabled = true; approve.dataset.permanentDisabled = '1'; edit.dataset.permanentDisabled = '1'; }
    approve.addEventListener('click', () => { if (confirm(`确认批准 ${item.serviceName || '此价格'}？`)) mutate('/api/admin/reviews/approve', { reviewId: item.reviewId, confirmation: 'APPROVE' }, els.exactStatus, '批准完成。', loadExact); });
    reject.addEventListener('click', () => { if (confirm('确认拒绝此精确价格候选？')) mutate('/api/admin/reviews/reject', { reviewId: item.reviewId, confirmation: 'REJECT', reasonCode: reason.value }, els.exactStatus, '拒绝完成。', loadExact); });
    edit.addEventListener('click', () => { const unitPrice = Number(price.value); if (!Number.isFinite(unitPrice) || unitPrice <= 0) { setStatus(els.exactStatus, '请输入有效的正数单价。', 'error'); return; } if (confirm(`确认按 ${unitPrice} 修改并批准？`)) mutate('/api/admin/reviews/edit-and-approve', { reviewId: item.reviewId, confirmation: 'EDIT_AND_APPROVE', unitPrice }, els.exactStatus, '编辑后批准完成。', loadExact); });
    actions.append(approve, reject, edit); article.append(actions); return article;
  }
  async function loadExact() {
    setStatus(els.exactStatus, '正在强一致读取精确价格审核队列……');
    try { const data = await jsonApi('/api/admin/reviews'); assertProduction(data); const items = Array.isArray(data.items) ? data.items : []; els.exactList.replaceChildren(...(items.length ? items.map(exactNode) : [node('div', '当前没有精确价格待审核项目。', 'empty')])); setStatus(els.exactStatus, `队列已加载：${data.total ?? items.length} 项。`, 'ok'); }
    catch (error) { els.exactList.replaceChildren(); setStatus(els.exactStatus, errorText(error), 'error'); }
  }

  function ordinarySummary(type, payload) { return type === 'playable_name' ? `陪玩名字：${payload?.name ?? '—'}` : `老板名：${payload?.bossName ?? '—'}\n直属/派单：${payload?.paiDan || '（空）'}\n折数：${payload?.discount ?? '—'}`; }
  function ordinaryNode(item) {
    const article = node('article', '', 'item'), head = node('div', '', 'item-head'); head.append(node('h3', `${item.dataType === 'playable_name' ? '陪玩名字' : '老板资料'} · …${String(item.reviewId).slice(-8)}`), pill(item.reason || '人工审核'));
    article.append(head, node('div', `公共基线\n${ordinarySummary(item.baseline?.dataType, item.baseline?.payload)}\n\n候选值\n${ordinarySummary(item.dataType, item.payload)}`, 'summary'));
    const information = node('div', '', 'meta'); meta(information, '设备证据', `${item.distinctDeviceCount ?? '—'} 台`); meta(information, '基线状态', item.baseline?.stillCurrent === false ? '已过期' : '当前有效'); meta(information, '收到时间', formatTime(item.receivedAt)); meta(information, '数据类型', item.dataType); article.append(information);
    const grid = node('div', '', 'grid three'); let payloadReader;
    if (item.dataType === 'playable_name') { const input = document.createElement('input'); input.value = String(item.payload?.name || ''); input.maxLength = 30; input.setAttribute('aria-label', '编辑陪玩名字'); grid.append(input); payloadReader = () => ({ name: input.value }); }
    else { const boss = document.createElement('input'), direct = document.createElement('input'), discount = document.createElement('input'); boss.value = String(item.payload?.bossName || ''); boss.maxLength = 30; boss.setAttribute('aria-label', '编辑老板名'); direct.value = String(item.payload?.paiDan || ''); direct.maxLength = 30; direct.setAttribute('aria-label', '编辑直属或派单'); discount.type = 'number'; discount.min = '0.8'; discount.max = '1'; discount.step = '0.0001'; discount.value = String(item.payload?.discount ?? ''); discount.setAttribute('aria-label', '编辑老板折数'); grid.append(boss, direct, discount); payloadReader = () => ({ bossName: boss.value, paiDan: direct.value, discount: Number(discount.value) }); }
    const reason = document.createElement('select'); reason.setAttribute('aria-label', '普通资料拒绝原因'); for (const [value, label] of [['invalid_data', '数据无效'], ['insufficient_evidence', '证据不足'], ['conflicting_candidates', '候选冲突'], ['unsupported_change', '不支持的变更']]) { const option = node('option', label); option.value = value; reason.append(option); } grid.append(reason); article.append(grid);
    const actions = node('div', '', 'actions'), approve = node('button', '批准候选'), reject = node('button', '拒绝候选', 'danger'), edit = node('button', '按输入内容批准', 'secondary');
    if (item.baseline?.stillCurrent === false) for (const button of [approve, edit]) { button.disabled = true; button.dataset.permanentDisabled = '1'; }
    approve.addEventListener('click', () => { if (confirm('确认批准此普通资料候选？')) mutate('/api/admin/ordinary-reviews/approve', { reviewId: item.reviewId, confirmation: 'APPROVE_ORDINARY' }, els.ordinaryStatus, '批准完成。', loadOrdinary); });
    reject.addEventListener('click', () => { if (confirm('确认拒绝此普通资料候选？')) mutate('/api/admin/ordinary-reviews/reject', { reviewId: item.reviewId, confirmation: 'REJECT_ORDINARY', reasonCode: reason.value }, els.ordinaryStatus, '拒绝完成。', loadOrdinary); });
    edit.addEventListener('click', () => { const payload = payloadReader(); if (confirm('确认按输入内容修改并批准？')) mutate('/api/admin/ordinary-reviews/edit-and-approve', { reviewId: item.reviewId, confirmation: 'EDIT_AND_APPROVE_ORDINARY', payload }, els.ordinaryStatus, '编辑后批准完成。', loadOrdinary); });
    actions.append(approve, reject, edit); article.append(actions); return article;
  }
  async function loadOrdinary() {
    setStatus(els.ordinaryStatus, '正在强一致读取普通资料审核队列……');
    try { const data = await jsonApi('/api/admin/ordinary-reviews'); assertProduction(data); const items = Array.isArray(data.items) ? data.items : []; els.ordinaryList.replaceChildren(...(items.length ? items.map(ordinaryNode) : [node('div', '当前没有普通资料待审核项目。', 'empty')])); setStatus(els.ordinaryStatus, `队列已加载：${data.total ?? items.length} 项。`, 'ok'); }
    catch (error) { els.ordinaryList.replaceChildren(); setStatus(els.ordinaryStatus, errorText(error), 'error'); }
  }

  function sensitiveType(type) { return ({ rank_range_rule: '区间规则', surcharge_rule: '加价规则', gift_rule: '礼物规则', boss_profile: '老板敏感资料', exact_price: '精确价格', playable_name: '陪玩名字' })[type] || type || '敏感内容'; }
  function sensitiveNode(item) {
    const article = node('article', '', 'item'), head = node('div', '', 'item-head'); head.append(node('h3', `${sensitiveType(item.dataType)}${item.operation === 'delete' ? ' · 删除' : ''}`), pill(item.reason || '敏感审核', 'bad')); article.append(head);
    const information = node('div', '', 'meta'); meta(information, '操作', item.operation); meta(information, '收到时间', formatTime(item.receivedAt)); meta(information, '基线摘要', item.baselineContentHash ? `…${String(item.baselineContentHash).slice(-8)}` : '无'); meta(information, '审核尾标', `…${String(item.reviewId).slice(-8)}`); article.append(information);
    const load = node('button', '读取脱敏详情', 'secondary'), detail = node('div', '', 'editor'); load.addEventListener('click', () => sensitiveDetail(item, detail, load)); article.append(load, detail); return article;
  }
  async function sensitiveDetail(item, container, button) {
    button.disabled = true;
    try {
      let data = state.sensitiveDetails.get(item.reviewId); if (!data) { data = await jsonApi(`/api/admin/sensitive-reviews/detail?id=${encodeURIComponent(item.reviewId)}`); assertProduction(data); state.sensitiveDetails.set(item.reviewId, data); }
      container.replaceChildren(node('div', `公共基线\n${pretty(data.baseline?.payload ?? null)}\n\n候选${data.item.operation === 'delete' ? '（删除墓碑）' : ''}\n${pretty(data.candidate?.payload ?? null)}`, 'summary'));
      const textarea = document.createElement('textarea'); textarea.value = pretty(data.candidate?.payload ?? null); textarea.disabled = data.item.operation === 'delete'; textarea.setAttribute('aria-label', '敏感候选编辑JSON');
      const reason = document.createElement('select'); reason.setAttribute('aria-label', '敏感拒绝原因'); for (const [value, label] of [['invalid_data', '数据无效'], ['insufficient_evidence', '证据不足'], ['conflicting_candidates', '候选冲突'], ['unsupported_change', '不支持的变更'], ['identity_uncertain', '身份不确定'], ['delete_not_confirmed', '删除未确认']]) { const option = node('option', label); option.value = value; reason.append(option); }
      const editor = node('div', '', 'editor'); editor.append(textarea, reason); container.append(editor);
      const actions = node('div', '', 'actions'), approve = node('button', data.item.operation === 'delete' ? '批准并发布墓碑' : '批准候选', 'danger'), reject = node('button', '拒绝候选', 'secondary'), edit = node('button', '按JSON编辑后批准', 'purple');
      if (data.item.operation === 'delete') { edit.disabled = true; edit.dataset.permanentDisabled = '1'; }
      approve.addEventListener('click', () => { if (confirm(`确认批准此${sensitiveType(data.item.dataType)}${data.item.operation === 'delete' ? '删除墓碑' : '敏感变更'}？`)) mutate('/api/admin/sensitive-reviews/approve', { reviewId: data.item.reviewId, confirmation: 'APPROVE_SENSITIVE' }, els.sensitiveStatus, '敏感批准完成。', loadSensitive); });
      reject.addEventListener('click', () => { if (confirm('确认拒绝此敏感候选？')) mutate('/api/admin/sensitive-reviews/reject', { reviewId: data.item.reviewId, confirmation: 'REJECT_SENSITIVE', reasonCode: reason.value }, els.sensitiveStatus, '敏感拒绝完成。', loadSensitive); });
      edit.addEventListener('click', () => { let payload; try { payload = JSON.parse(textarea.value); } catch (_) { setStatus(els.sensitiveStatus, '编辑内容不是有效JSON。', 'error'); return; } if (confirm('确认按当前JSON修改并批准此敏感候选？')) mutate('/api/admin/sensitive-reviews/edit-and-approve', { reviewId: data.item.reviewId, confirmation: 'EDIT_AND_APPROVE_SENSITIVE', payload }, els.sensitiveStatus, '敏感编辑后批准完成。', loadSensitive); });
      actions.append(approve, reject, edit); container.append(actions);
    } catch (error) { button.disabled = false; setStatus(els.sensitiveStatus, errorText(error), 'error'); }
  }
  async function loadSensitive() {
    state.sensitiveDetails.clear(); setStatus(els.sensitiveStatus, '正在强一致读取敏感审核队列……');
    try { const data = await jsonApi('/api/admin/sensitive-reviews'); assertProduction(data); const items = Array.isArray(data.items) ? data.items : []; els.sensitiveList.replaceChildren(...(items.length ? items.map(sensitiveNode) : [node('div', '当前没有敏感待审核项目。', 'empty')])); const intake = data.sensitiveSubmissionIntakeEnabled === false ? '新候选入口已暂停，仍可处理存量队列' : '新候选入口开启'; setStatus(els.sensitiveStatus, `敏感队列已加载：${data.count ?? items.length} 项；${intake}。`, 'ok'); }
    catch (error) { els.sensitiveList.replaceChildren(); setStatus(els.sensitiveStatus, errorText(error), 'error'); }
  }

  function deviceBadges(device) { const box = node('span'); if (device.trusted) box.append(pill('可信', 'good')); if (device.blocked) box.append(pill('已封禁', 'bad')); if (!device.trusted && !device.blocked) box.append(pill('普通')); return box; }
  function deviceNode(device) { const article = node('article', '', 'item'), head = node('div', '', 'item-head'), title = node('h3', device.displayName || `设备 …${String(device.deviceRef).slice(-8)}`), button = node('button', '查看设备详情', 'secondary'); title.append(' ', deviceBadges(device)); button.addEventListener('click', () => openDevice(device.deviceRef)); head.append(title, button); article.append(head, node('div', `引用尾标：…${String(device.deviceRef).slice(-8)} · 治理版本 ${device.governanceVersion} · App ${device.lastAppVersion}`, 'small')); return article; }
  async function loadDevices() {
    setStatus(els.devicesStatus, '正在强一致读取脱敏设备列表……');
    try { const data = await jsonApi('/api/admin/devices'); assertProduction(data); const result = data.result || data, devices = Array.isArray(result.devices) ? result.devices : []; els.devicesList.replaceChildren(...(devices.length ? devices.map(deviceNode) : [node('div', '当前没有已注册设备。', 'empty')])); setStatus(els.devicesStatus, `设备列表已加载：${result.count ?? devices.length} 台。`, 'ok'); if (state.selectedDeviceRef) await openDevice(state.selectedDeviceRef); }
    catch (error) { els.devicesList.replaceChildren(); setStatus(els.devicesStatus, errorText(error), 'error'); }
  }
  async function openDevice(ref) {
    state.selectedDeviceRef = ref; els.deviceDetailCard.classList.remove('hidden'); setStatus(els.deviceMutationStatus, '正在读取设备详情……');
    try {
      const data = await jsonApi(`/api/admin/devices/detail?id=${encodeURIComponent(ref)}`); assertProduction(data); const result = data.result || data, device = result.device; els.deviceDetail.replaceChildren();
      const facts = node('dl', '', 'facts'); for (const [label, value] of [['设备', device.displayName], ['不可逆引用', device.deviceRef], ['注册时间', formatTime(device.createdAt)], ['令牌到期', formatTime(device.expiresAt)], ['最后版本', device.lastAppVersion], ['治理版本', device.governanceVersion]]) facts.append(node('dt', label), node('dd', value, label === '不可逆引用' ? 'mono' : '')); els.deviceDetail.append(facts, node('h3', '不可变治理记录'));
      const events = node('div', '', 'list'); for (const event of result.events || []) events.append(node('div', `${event.action} · ${event.reasonCode} · v${event.version}\n${formatTime(event.createdAt)} · ${event.actorTag}`, 'item small')); if (!(result.events || []).length) events.append(node('div', '暂无治理事件。', 'empty')); els.deviceDetail.append(events);
      els.trustBtn.disabled = device.trusted || device.blocked; els.revokeTrustBtn.disabled = !device.trusted; els.blockBtn.disabled = device.blocked; els.unblockBtn.disabled = !device.blocked;
      for (const button of [els.trustBtn, els.revokeTrustBtn, els.blockBtn, els.unblockBtn]) button.dataset.permanentDisabled = button.disabled ? '1' : '0';
      setStatus(els.deviceMutationStatus, '设备详情已读取。', 'ok');
    } catch (error) { setStatus(els.deviceMutationStatus, errorText(error), 'error'); }
  }
  async function mutateDevice(action, reason, label) {
    if (!state.selectedDeviceRef || state.busy || !confirm(`确认${label}？`)) return; setBusy(true); setStatus(els.deviceMutationStatus, `正在${label}……`);
    try { const data = await jsonApi(`/api/admin/devices/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, deviceRef: state.selectedDeviceRef, requestId: randomId('dgrq_v1_'), reasonCode: reason }) }); assertProduction(data); const result = data.result || data; setBusy(false); await loadDevices(); setStatus(els.deviceMutationStatus, `${label}完成：可信=${result.trusted}，封禁=${result.blocked}，治理版本=${result.governanceVersion}。`, 'ok'); }
    catch (error) { setStatus(els.deviceMutationStatus, errorText(error), 'error'); setBusy(false); }
  }

  function rollbackNode(item) { const article = node('article', '', 'item'), head = node('div', '', 'item-head'), button = node('button', '回滚到上一批准值', 'danger'); head.append(node('h3', `${item.serviceName || '公共记录'} · ${item.currentUnitPrice} → ${item.previousUnitPrice}`)); button.addEventListener('click', () => executeRollback(item)); head.append(button); article.append(head); const information = node('div', '', 'meta'); meta(information, '当前公共版本', item.currentVersion); meta(information, '恢复来源版本', item.previousVersion); meta(information, '当前批准时间', formatTime(item.currentApprovedAt)); meta(information, '上一批准时间', formatTime(item.previousApprovedAt)); meta(information, '目标尾标', `…${String(item.rollbackRef || '').slice(-8)}`); article.append(information); return article; }
  async function loadRollback() { setStatus(els.rollbackStatus, '正在强一致读取可回滚项目……'); try { const data = await jsonApi('/api/admin/rollbacks'); assertProduction(data); const result = data.result || data, items = Array.isArray(result.candidates) ? result.candidates : []; els.rollbackList.replaceChildren(...(items.length ? items.map(rollbackNode) : [node('div', '当前没有可回滚项目。', 'empty')])); setStatus(els.rollbackStatus, `可回滚项目已加载：${result.count ?? items.length} 项。`, 'ok'); } catch (error) { els.rollbackList.replaceChildren(); setStatus(els.rollbackStatus, errorText(error), 'error'); } }
  async function executeRollback(item) {
    if (state.busy || !confirm(`确认把“${item.serviceName || '此公共记录'}”恢复到紧邻的上一批准值？\n\n该操作会追加新公共版本，不删除历史。`)) return; setBusy(true); setStatus(els.rollbackStatus, '正在执行回滚并重建最新快照……');
    try { const data = await jsonApi('/api/admin/rollbacks/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, rollbackRef: item.rollbackRef, requestId: randomId('rbrq_v1_'), confirmation: 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE' }) }); assertProduction(data); const result = data.result || data; setBusy(false); await loadRollback(); setStatus(els.rollbackStatus, `回滚完成；公共版本 ${result.publicVersion ?? '—'}，事件版本 ${result.eventVersion ?? '—'}。`, 'ok'); }
    catch (error) { setStatus(els.rollbackStatus, errorText(error), 'error'); setBusy(false); }
  }

  function renderExport(result) { els.exportPublicVersion.textContent = String(result.publicVersion ?? '—'); els.exportRecordCount.textContent = String(result.recordCount ?? '—'); els.exportTombstoneCount.textContent = String(result.tombstoneCount ?? '—'); els.exportOrdinaryEventCount.textContent = String(result.ordinaryEventCount ?? result.eventCount ?? '—'); els.exportSensitiveEventCount.textContent = String(result.sensitiveEventCount ?? '—'); els.exportFileCount.textContent = String(result.fileCount ?? '—'); els.exportBytes.textContent = formatBytes(result.byteLength); els.exportPackageSuffix.textContent = `…${String(result.packageId || '').slice(-10)}`; els.exportFacts.classList.remove('hidden'); }
  async function loadExport() { setStatus(els.exportStatus, '正在强一致生成完整导出摘要……'); try { const data = await jsonApi('/api/admin/exports/summary'); assertProduction(data); const result = data.summary; if (!result || typeof result !== 'object') { const error = new Error('服务器未返回正式导出摘要。'); error.code = 'ADMIN_EXPORT_SUMMARY_MISSING'; throw error; } renderExport(result); setStatus(els.exportStatus, `导出摘要已加载：公共版本 ${result.publicVersion}。`, 'ok'); } catch (error) { els.exportFacts.classList.add('hidden'); setStatus(els.exportStatus, errorText(error), 'error'); } }
  async function downloadExport() {
    if (state.busy || !confirm('确认下载当前正式公共数据库完整迁移ZIP？\n\n下载会写入私有审计，但不会修改公共数据。')) return; setBusy(true); setStatus(els.exportStatus, '正在生成、校验并下载完整迁移ZIP……');
    try {
      const response = await fetch('/api/admin/exports/download', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, requestId: randomId('exrq_v1_'), confirmation: 'EXPORT_FULL_PUBLIC_DATABASE' }) });
      if (!response.ok) { const payload = await response.json().catch(() => null), error = new Error(payload?.error?.message || `导出失败（HTTP ${response.status}）`); error.code = payload?.error?.code || `HTTP_${response.status}`; error.status = response.status; if (isAuthError(error.code, response.status)) setLoggedOut('会话失效'); throw error; }
      if (!String(response.headers.get('content-type') || '').toLowerCase().startsWith('application/zip')) { const error = new Error('服务器未返回ZIP文件。'); error.code = 'ADMIN_EXPORT_CONTENT_TYPE_UNEXPECTED'; throw error; }
      if (response.headers.get('x-cloud-collab-stable-promotion-authorized') !== '0') { const error = new Error('导出响应未明确保持稳定晋升关闭。'); error.code = 'ADMIN_EXPORT_PROMOTION_BOUNDARY_MISSING'; throw error; }
      const blob = await response.blob(); revokeDownload(); state.objectUrl = URL.createObjectURL(blob); els.downloadLink.href = state.objectUrl; els.downloadLink.download = '码单器公共数据库完整导出.zip'; els.downloadLink.click(); setBusy(false); await loadExport(); setStatus(els.exportStatus, `下载完成：公共版本 ${response.headers.get('x-cloud-collab-public-version') || '—'}，内容包尾标 …${String(response.headers.get('x-cloud-collab-package-id') || '').slice(-10)}。`, 'ok'); setTimeout(revokeDownload, 0);
    } catch (error) { setStatus(els.exportStatus, errorText(error), 'error'); setBusy(false); }
  }

  const loaders = { exact: loadExact, ordinary: loadOrdinary, sensitive: loadSensitive, devices: loadDevices, rollback: loadRollback, export: loadExport };
  for (const button of navButtons) button.addEventListener('click', () => { if (!button.disabled) showModule(button.dataset.module); });
  for (const button of document.querySelectorAll('[data-refresh]')) button.addEventListener('click', () => loaders[button.dataset.refresh]?.());
  els.loginBtn.addEventListener('click', login); els.sessionBtn.addEventListener('click', () => checkSession()); els.logoutBtn.addEventListener('click', logout);
  els.trustBtn.addEventListener('click', () => mutateDevice('trust', 'verified_operator', '设为可信'));
  els.revokeTrustBtn.addEventListener('click', () => mutateDevice('revoke-trust', 'trust_withdrawn', '撤销可信'));
  els.blockBtn.addEventListener('click', () => mutateDevice('block', els.blockReason.value, '封禁设备'));
  els.unblockBtn.addEventListener('click', () => mutateDevice('unblock', 'manual_review_cleared', '解除封禁'));
  els.downloadBtn.addEventListener('click', downloadExport);
  window.addEventListener('pagehide', () => { els.password.value = ''; clearBusinessData(); });
  checkSession({ quiet: true });
})();
