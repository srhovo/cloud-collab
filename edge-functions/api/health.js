import { methodNotAllowed, optionsResponse, parseReadonlyMethod, success } from './_shared/http.js';

function createData(context = {}) {
  const environment = String(context?.env?.APP_ENV || 'test').slice(0, 32);
  return {
    status: 'ok',
    environment,
    serverTime: new Date().toISOString(),
    protocolVersion: 1,
    writeEnabled: false,
    capabilities: {
      health: true,
      protocol: true,
      publicVersion: true,
      snapshotRead: false,
      submission: false,
      adminWrite: false,
    },
  };
}

export default function onRequest(context) {
  const method = parseReadonlyMethod(context?.request);
  if (method.isOptions) return optionsResponse();
  if (!method.isGet && !method.isHead) return methodNotAllowed(method.method);
  return success(createData(context), { cacheSeconds: 0, head: method.isHead });
}
