// Catalog provider per backend factory (D33, D34). The DSH loop needs a provider and model for
// every step (`P/dsh-agent-loop/lib/index.js:671-672`), but never calls it in our sessions (the
// guard admits nothing). `stream()` refuses every request with a clear error. Spike rows: only
// "Your <displayName> settings" (`settings`); the live model list is a later milestone.

import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import type { CordisContext } from './types.js';

export const SETTINGS_MODEL = 'settings';

/** A plain object with the LlmAdapter surface (`P/dsh-llm/lib/index.js:1670-1754`). */
export function catalogAdapter(factory: AgentBackendFactory, seedModels: readonly string[] = []) {
  const settingsRow = (provider: string) => ({
    provider,
    id: SETTINGS_MODEL,
    name: `Your ${factory.displayName} settings`,
    inputModalities: ['text', 'image'],
  });
  const refuse = () => {
    throw new Error(`This model only works in ${factory.displayName} sessions`);
  };
  return {
    providerInfo: (provider: string) => ({ id: provider, name: factory.displayName }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p: string, _m: string, image: { width: number; height: number; bytes: number }) => ({
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    }),
    // Test-only seed rows (the live list from supportedModels() is a later milestone, D33).
    listModels: async (provider: string) => [
      settingsRow(provider),
      ...seedModels.map((id) => ({ provider, id, name: id, inputModalities: ['text', 'image'] })),
    ],
    resolveModel: async (provider: string, model: string) => ({
      ...settingsRow(provider),
      id: model,
      name: model === SETTINGS_MODEL ? settingsRow(provider).name : model,
      context: { contextWindow: 200000 },
    }),
    async prepareCall(provider: string, model: string) {
      return { model: await this.resolveModel(provider, model), stream: refuse };
    },
    stream: refuse,
  };
}

/** Register one catalog provider per factory; id = factory kind (D80). */
export function mountHost(
  ctx: CordisContext,
  factories: readonly AgentBackendFactory[],
  seedModels: readonly string[] = [],
): { catalog: boolean } {
  type Llm = { registerAdapter?(providers: string[], adapter: unknown): () => void };
  const register = (c: CordisContext): boolean => {
    const llm = c.get('llm') as Llm | undefined;
    if (!llm?.registerAdapter) return false;
    for (const f of factories) {
      const adapter = catalogAdapter(f, seedModels);
      c.effect(() => {
        const handle = llm.registerAdapter!([f.kind], adapter);
        return () => handle();
      }, `raw-agent: ${f.kind} catalog`);
    }
    return true;
  };
  // A Host entry can apply before the llm service is served (live: no rows otherwise), so wait
  // for it with `inject` when the context offers it.
  if (ctx.inject) {
    ctx.inject(['llm'], (child) => void register(child));
    return { catalog: true };
  }
  return { catalog: register(ctx) };
}
