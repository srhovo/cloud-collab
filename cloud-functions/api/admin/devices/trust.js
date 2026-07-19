import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminDeviceTrustRequest } from '../../../../src/server/device_governance_http_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceTrustRequest(resolveCloudFunctionContext(context));
}
