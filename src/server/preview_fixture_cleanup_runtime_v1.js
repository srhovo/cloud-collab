import { getStore } from '@edgeone/pages-blob';
import { PREVIEW_FIXTURE_STORE } from './preview_fixture_cleanup_once_v1.js';

export function createPreviewFixtureCleanupStore() {
  return getStore({ name: PREVIEW_FIXTURE_STORE, consistency: 'strong' });
}
