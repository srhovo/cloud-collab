import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_CLEANUP_MAX_OBJECTS,
  PreviewCleanupError,
  inspectSyntheticPreviewObjects,
} from '../src/server/preview_cleanup_v1.js';

test('one-shot cleanup refuses suspiciously large synthetic namespaces before deletion', async () => {
  assert.equal(PREVIEW_CLEANUP_MAX_OBJECTS, 500);
  const blobs = Array.from({ length: PREVIEW_CLEANUP_MAX_OBJECTS + 1 }, (_, index) => ({
    key: `preview-rate/device-register/${String(index).padStart(43, '0')}/${index}.json`,
  }));
  let deleted = false;
  const store = {
    async list(options = {}) {
      assert.equal(options.consistency, 'strong');
      return { blobs };
    },
    async delete() { deleted = true; },
  };

  await assert.rejects(
    () => inspectSyntheticPreviewObjects({ store }),
    error => error instanceof PreviewCleanupError
      && error.code === 'PREVIEW_CLEANUP_OBJECT_LIMIT'
      && error.details?.objectCount === PREVIEW_CLEANUP_MAX_OBJECTS + 1
      && error.details?.maxObjects === PREVIEW_CLEANUP_MAX_OBJECTS,
  );
  assert.equal(deleted, false);
});
