import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd();
const filePath = path.join(root, 'dist', 'stage5g6a6b-recovery.html');
const html = fs.readFileSync(filePath, 'utf8');

function inlineScripts(value) {
  return [...value.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
}

test('敏感恢复页保持一次性合成边界', () => {
  assert.match(html, /\[DO NOT MERGE\]/);
  assert.match(html, /group_fixture/);
  assert.match(html, /lib_receive_fixture/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB/i);
  assert.match(html, /eo_token/);
  assert.match(html, /eo_time/);
  assert.match(html, /X-Cloud-Stage5g6a6b-Acceptance-Key/);
  assert.match(html, /X-Cloud-Collab-Preview-Key/);
  assert.match(html, /headers\.Authorization=`Bearer \$\{deviceToken\}`/);
});

test('敏感恢复页使用全新幂等身份且只补充加价与礼物候选', () => {
  assert.match(html, /sub_01JSTAGE5G6A6B000000000024/);
  assert.match(html, /sub_01JSTAGE5G6A6B000000000025/);
  assert.doesNotMatch(html, /sub_01JSTAGE5G6A6B000000000022/);
  assert.doesNotMatch(html, /sub_01JSTAGE5G6A6B000000000023/);
  assert.match(html, /prices:\{round:7,hour:20\}/);
  assert.match(html, /unitPrice:68/);
  assert.match(html, /surcharge_rule/);
  assert.match(html, /gift_rule/);
  assert.doesNotMatch(html, /rank_range_rule/);
  assert.doesNotMatch(html, /ordinary-submissions-create/);
});

test('敏感恢复页脚本语法有效且成功后禁用重复创建', () => {
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0], { filename: 'stage5g6a6b-recovery.html' });
  assert.match(html, /state\.completed=true/);
  assert.match(html, /recoverBtn'\)\.disabled=true/);
  assert.match(html, /恢复候选已经创建，不要重复点击/);
});
