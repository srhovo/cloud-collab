import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleStage5defCleanupRequest } from '../../../../src/server/stage5def_cleanup_http_v1.js';

export default async function onRequest(context) {
  return handleStage5defCleanupRequest(resolveCloudFunctionContext(context));
}
