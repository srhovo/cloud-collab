'use strict';

const config = window.PRODUCTION_GENERATOR_CONFIG;
if (!config || !Array.isArray(config.privateNames) || !Array.isArray(config.fixedLines)) {
  throw new Error('离线生成器配置缺失');
}

const state = new Map();
const rows = document.getElementById('valueRows');
const publicOrigin = document.getElementById('publicOrigin');
const adminOrigin = document.getElementById('adminOrigin');
const envBlock = document.getElementById('envBlock');
const selectAll = document.getElementById('selectAll');
const status = document.getElementById('status');

function randomValue() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function validOrigin(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/eo_token=/iu.test(value)) throw new Error('不得使用临时预览链接');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('来源必须是没有路径、参数和片段的纯 HTTPS 地址');
  }
  return parsed.origin;
}

function renderRows() {
  rows.replaceChildren();
  for (const name of config.privateNames) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    label.textContent = name;
    label.htmlFor = `value-${name}`;

    const input = document.createElement('input');
    input.id = `value-${name}`;
    input.readOnly = true;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = state.get(name) || '';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '选中此项';
    button.disabled = !input.value;
    button.addEventListener('click', () => {
      input.focus();
      input.select();
      status.textContent = `${name} 已选中，请使用系统复制菜单。`;
    });

    row.append(label, input, button);
    rows.append(row);
  }
}

function buildEnvironmentBlock() {
  try {
    const publicValue = validOrigin(publicOrigin.value);
    const adminValue = validOrigin(adminOrigin.value);
    const valuesReady = config.privateNames.every(name => state.has(name));
    const lines = [
      ...config.fixedLines,
      `CLOUD_PRODUCTION_PUBLIC_ORIGIN=${publicValue}`,
      `CLOUD_ADMIN_PUBLIC_ORIGIN=${adminValue}`,
      ...config.privateNames.map(name => `${name}=${state.get(name) || ''}`),
    ];
    envBlock.value = `${lines.join('\n')}\n`;
    selectAll.disabled = !valuesReady;
    status.textContent = valuesReady ? '已生成。所有生产开关仍为 0。' : '尚未生成。';
  } catch (error) {
    envBlock.value = '';
    selectAll.disabled = true;
    status.textContent = error instanceof Error ? error.message : '来源地址无效';
  }
}

function clearPage() {
  state.clear();
  publicOrigin.value = '';
  adminOrigin.value = '';
  envBlock.value = '';
  selectAll.disabled = true;
  renderRows();
  status.textContent = '页面内存已清空。';
}

document.getElementById('generate').addEventListener('click', () => {
  state.clear();
  for (const name of config.privateNames) state.set(name, randomValue());
  renderRows();
  buildEnvironmentBlock();
});

document.getElementById('clear').addEventListener('click', clearPage);
publicOrigin.addEventListener('input', buildEnvironmentBlock);
adminOrigin.addEventListener('input', buildEnvironmentBlock);
selectAll.addEventListener('click', () => {
  envBlock.focus();
  envBlock.select();
  status.textContent = '批量导入文本已选中，请使用系统复制菜单。';
});

window.addEventListener('pagehide', clearPage);
renderRows();
buildEnvironmentBlock();
window.PRODUCTION_GENERATOR_READY = true;
