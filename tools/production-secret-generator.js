'use strict';

const privateInputs = [...document.querySelectorAll('[data-private-name]')];
const publicOrigin = document.getElementById('publicOrigin');
const adminOrigin = document.getElementById('adminOrigin');
const baseLines = document.getElementById('baseLines');
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

function valuesReady() {
  return privateInputs.length === 8 && privateInputs.every(input => input.value.length === 64);
}

function buildEnvironmentBlock() {
  try {
    const publicValue = validOrigin(publicOrigin.value);
    const adminValue = validOrigin(adminOrigin.value);
    const lines = [
      baseLines.value.trim(),
      `CLOUD_PRODUCTION_PUBLIC_ORIGIN=${publicValue}`,
      `CLOUD_ADMIN_PUBLIC_ORIGIN=${adminValue}`,
      ...privateInputs.map(input => `${input.dataset.privateName}=${input.value}`),
    ];
    envBlock.value = `${lines.join('\n')}\n`;
    selectAll.disabled = !valuesReady();
    status.textContent = valuesReady() ? '已生成。所有生产开关仍为 0。' : '尚未生成。';
  } catch (error) {
    envBlock.value = '';
    selectAll.disabled = true;
    status.textContent = error instanceof Error ? error.message : '来源地址无效';
  }
}

function clearPage() {
  for (const input of privateInputs) input.value = '';
  for (const button of document.querySelectorAll('[data-select-target]')) button.disabled = true;
  publicOrigin.value = '';
  adminOrigin.value = '';
  envBlock.value = '';
  selectAll.disabled = true;
  status.textContent = '页面内存已清空。';
}

document.getElementById('generate').addEventListener('click', () => {
  const generated = new Set();
  for (const input of privateInputs) {
    let value;
    do value = randomValue(); while (generated.has(value));
    generated.add(value);
    input.value = value;
  }
  for (const button of document.querySelectorAll('[data-select-target]')) button.disabled = false;
  buildEnvironmentBlock();
});

document.getElementById('clear').addEventListener('click', clearPage);
publicOrigin.addEventListener('input', buildEnvironmentBlock);
adminOrigin.addEventListener('input', buildEnvironmentBlock);

document.getElementById('valueRows').addEventListener('click', event => {
  const button = event.target.closest('[data-select-target]');
  if (!button) return;
  const input = document.getElementById(button.dataset.selectTarget);
  if (!input || !input.value) return;
  input.focus();
  input.select();
  status.textContent = `${input.dataset.privateName} 已选中，请使用系统复制菜单。`;
});

selectAll.addEventListener('click', () => {
  envBlock.focus();
  envBlock.select();
  status.textContent = '批量导入文本已选中，请使用系统复制菜单。';
});

window.addEventListener('pagehide', clearPage);
buildEnvironmentBlock();
window.PRODUCTION_GENERATOR_READY = true;
