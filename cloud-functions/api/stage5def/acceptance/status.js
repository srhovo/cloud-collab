import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleStage5defStatusRequest } from '../../../../../src/server/stage5def_acceptance_http_v1.js';

export default async function onRequest(context) {
  return handleStage5defStatusRequest(resolveCloudFunctionContext(context));
}
