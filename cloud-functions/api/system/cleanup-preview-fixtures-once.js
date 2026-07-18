import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handlePreviewFixtureCleanupRequest } from '../../../src/server/preview_fixture_cleanup_http_v1.js';

export default async function onRequest(context) {
  return handlePreviewFixtureCleanupRequest(resolveCloudFunctionContext(context));
}
