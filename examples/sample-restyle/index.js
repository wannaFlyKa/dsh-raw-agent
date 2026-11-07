// Host entry of the sample plugin. It only shows how a Host plugin reads the `rawAgent` service
// softly: `ctx.inject` runs the callback while dsh-raw-agent provides the service, and stops it
// when our plugin unloads. It never sends text and never keeps a reference outside the callback.
export const name = 'dsh-raw-agent-sample-restyle';

export function apply(ctx) {
  ctx.inject(['rawAgent'], (scoped) => {
    const api = scoped.rawAgent;
    if (!api || api.apiVersion !== 1) return;
    const kinds = api.backends.map((b) => b.kind).join(', ');
    const logger = typeof scoped.logger === 'function' ? scoped.logger('sample-restyle') : scoped.logger;
    logger?.info?.(`rawAgent API ${api.apiVersion}; backends: ${kinds || 'none'}`);
  });
}
