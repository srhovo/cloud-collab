import { createBlobRepository, DEFAULT_STORE_NAME, resolveBlobStore } from '../_shared/blob-store.js';
import { createDeviceRegistrationService } from '../_shared/intake-service.js';
import {
  failure,
  optionsResponse,
  readJsonBody,
  requireEnabled,
  requirePost,
  success,
} from '../_shared/http.js';

export async function onRequest(context) {
  try {
    if (String(context?.request?.method || '').toUpperCase() === 'OPTIONS') return optionsResponse();
    requirePost(context.request);
    requireEnabled(context.env, 'CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED', 'DEVICE_REGISTRATION_DISABLED');
    const { value } = await readJsonBody(context.request, { maxBytes: 4096 });
    const store = await resolveBlobStore(context.env?.CLOUD_COLLAB_BLOB_STORE || DEFAULT_STORE_NAME);
    const service = createDeviceRegistrationService({
      repository: createBlobRepository(store),
      secret: context.env?.CLOUD_COLLAB_DEVICE_TOKEN_SECRET,
      tokenTtlMs: Number(context.env?.CLOUD_COLLAB_DEVICE_TOKEN_TTL_MS),
    });
    return success(await service.register(value), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export default onRequest;
