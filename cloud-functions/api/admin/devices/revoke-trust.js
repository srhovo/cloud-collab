import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminDeviceRevokeTrustRequest } from '../../../../src/server/device_governance_http_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceRevokeTrustRequest(resolveCloudFunctionContext(context));
}
