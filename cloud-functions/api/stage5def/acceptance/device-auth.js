import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleStage5defDeviceAuthRequest } from '../../../../src/server/stage5def_acceptance_http_v1.js';

export default async function onRequest(context) {
  return handleStage5defDeviceAuthRequest(resolveCloudFunctionContext(context));
}
