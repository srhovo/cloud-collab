import { handleDeviceRegisterRequest } from '../../../src/server/preview_write_http_v1.js';

export default async function onRequest(context) {
  return handleDeviceRegisterRequest(context);
}
