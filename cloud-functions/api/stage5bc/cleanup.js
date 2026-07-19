import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleStage5bcCleanupRequest } from '../../../src/server/stage5bc_cleanup_http_v1.js';

export default function onRequest(context) {
  return handleStage5bcCleanupRequest(resolveCloudFunctionContext(context));
}
