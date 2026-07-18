export function resolveCloudFunctionContext(context = {}, runtimeEnv = process.env) {
  const processValues = runtimeEnv && typeof runtimeEnv === 'object' ? runtimeEnv : {};
  const contextValues = context?.env && typeof context.env === 'object' ? context.env : {};
  return {
    ...context,
    env: Object.freeze({
      ...processValues,
      ...contextValues,
    }),
  };
}
