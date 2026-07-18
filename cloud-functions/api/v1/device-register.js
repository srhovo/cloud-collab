import { registerDevice } from '../../../src/server/device_registration_v1.js';
import {
  failure,
  optionsResponse,
  readJsonBody,
  requireEnabled,
  requirePost,
  success,
} from '../_shared/http.js';
import { createStoreResolver, DEFAULT_BLOB_STORE_NAME } from '../_shared/runtime.js';

export function createDeviceRegisterHandler({ getStore = null, now = () => Date.now() } = {}) {
  const resolveStore = createStoreResolver(getStore);
  return async function onRequest(context) {
    try {
      if (String(context?.request?.method || '').toUpperCase() === 'OPTIONS') return optionsResponse();
      requirePost(context.request);
      requireEnabled(context.env, 'CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED', 'DEVICE_REGISTRATION_DISABLED');
      const { value } = await readJsonBody(context.request, { maxBytes: 4096 });
      const store = await resolveStore(context.env?.CLOUD_COLLAB_BLOB_STORE || DEFAULT_BLOB_STORE_NAME);
      const data = await registerDevice({
        store,
        input: value,
        now: now(),
        tokenTtlMs: Number(context.env?.CLOUD_COLLAB_DEVICE_TOKEN_TTL_MS) || undefined,
      });
      return success(data, { status: 201 });
    } catch (error) {
      return failure(error);
    }
  };
}

export const onRequest = createDeviceRegisterHandler();
export default onRequest;
