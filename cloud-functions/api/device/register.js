import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { dispatchDeviceRegisterRequest } from '../../../src/server/write_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return dispatchDeviceRegisterRequest(resolveCloudFunctionContext(context));
}
