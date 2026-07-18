import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync('dist/stage4f-cleanup-preview.html', 'utf8');
const route = fs.readFileSync('cloud-functions/one-shot/stage4f-cleanup-preview.js', 'utf8');

test('stage4F cleanup inline runtime parses as JavaScript', () => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test('stage4F cleanup page uses only the same-origin one-shot route and keeps EdgeOne preview access', () => {
  assert.match(page, /new URL\('\/one-shot\/stage4f-cleanup-preview', window\.location\.origin\)/);
  assert.match(page, /\['eo_token', 'eo_time'\]/);
  assert.match(page, /credentials: 'same-origin'/);
  assert.doesNotMatch(page, /https?:\/\//);
  assert.match(route, /handleStage4fPreviewCleanupRequest/);
});

test('operator enforces inspect, digest-bound execute, exact delete count, and remaining zero', () => {
  assert.match(page, /request\('inspect'\)/);
  assert.match(page, /body\.expectedKeySetDigest = inspected\.keySetDigest/);
  assert.match(page, /request\('execute'\)/);
  assert.match(page, /data\.remainingCount !== 0/);
  assert.match(page, /data\.deletedCount !== expected/);
  assert.match(page, /confirmBox\.checked/);
  assert.match(page, /window\.confirm/);
});

test('cleanup key stays only in memory and the page contains no real secrets or object keys', () => {
  assert.match(page, /let activeKey = ''/);
  assert.match(page, /keyInput\.value = ''/);
  assert.match(page, /pagehide/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(page, /CLOUD_STAGE4F_CLEANUP_KEY\s*=\s*['"][^'"]+/);
  assert.doesNotMatch(page, /unsafeKey|objectKeys|rawKey/);
});
