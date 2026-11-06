// D61: shorten provider-specific model ids before display (they can hold account ids).

/** Shorten provider-specific model ids for display (D61). The inference-profile form is **unverified**. */
export function canonicalModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  let m = model;
  const slash = m.lastIndexOf('/');
  if (m.startsWith('arn:') && slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  return m;
}
