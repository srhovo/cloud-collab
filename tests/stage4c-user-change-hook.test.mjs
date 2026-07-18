import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildPath = path.join(root, 'scripts', 'build.mjs');
const source = fs.readFileSync(buildPath, 'utf8');
const labelIndex = source.indexOf("'user exact-price queue hook'");
const blockStart = source.lastIndexOf('html = replaceOnce(html,', labelIndex);
const hookBlock = source.slice(blockStart, labelIndex);

test('successful exact-price save asynchronously enqueues the public projection', () => {
  assert.ok(labelIndex >= 0 && blockStart >= 0, 'missing user-change build transform');
  const successIndex = hookBlock.indexOf('this.showSuccess(message);');
  const enqueueIndex = hookBlock.indexOf('enqueueExactPriceUserChange?.(cloudLocalLibraryId, record)');
  const resetIndex = hookBlock.indexOf('this.resetPriceMemoryEditor({ clear: true });', enqueueIndex);

  assert.ok(successIndex >= 0, 'missing local save success anchor');
  assert.ok(enqueueIndex > successIndex, 'candidate enqueue must happen only after local save succeeds');
  assert.ok(resetIndex > enqueueIndex, 'enqueue scheduling must preserve the existing editor reset flow');
  assert.match(hookBlock, /const cloudLocalLibraryId = workingActive\?\.id \|\| this\.priceLibraryStore\.getActiveLibrary\(this\.priceLibraries\)\?\.id \|\| '';/);
  assert.match(hookBlock, /if \(cloudLocalLibraryId\) setTimeout\(\(\) => \{/);
  assert.match(hookBlock, /\.catch\(error => appLogSilent\(error\)\)/);
});

test('user-change hook delegates privacy and mode decisions to the Stage4C feature boundary', () => {
  assert.equal(/history|orders|rawChat|chat|note|modeRatios|layoutTemplates|usageCount|lastUsed|original/.test(hookBlock), false);
  assert.equal(hookBlock.includes('fetch('), false);
  assert.equal(hookBlock.includes('deviceToken'), false);
  assert.equal(hookBlock.includes('CloudCollabPreviewRuntime'), false);
});
