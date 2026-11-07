// The public plugin API types (R9.2, docs/plugin-api.md) as one self-contained declaration file,
// lib/api.d.ts in the published package. It is emitted from packages/core/src/plugin-api.ts,
// which imports nothing, so the file needs no other package. Other plugins use it with
// `import type` only: the package has no runtime export for these names.
import ts from 'typescript';
import { readFileSync } from 'node:fs';

const HEADER = `// dsh-raw-agent plugin API types (API version 1). Generated from packages/core/src/plugin-api.ts.
// Type declarations only: use \`import type { RawAgentService } from 'dsh-raw-agent/api'\`.
// The package exports no runtime value for these names. Services: Host \`ctx.rawAgent\`,
// Client \`ctx.rawAgentClient\`. Reference: docs/plugin-api.md in the repository.
`;

/** @param {string} root repo root with a trailing slash */
export function apiTypes(root) {
  const file = `${root}packages/core/src/plugin-api.ts`;
  const source = readFileSync(file, 'utf8');
  const options = {
    types: [],
    lib: ['lib.es2022.d.ts'],
    declaration: true,
    emitDeclarationOnly: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (f) => (f === file ? source : read(f));
  let out = '';
  host.writeFile = (name, text) => {
    if (name.endsWith('.d.ts')) out = text;
  };
  const program = ts.createProgram([file], options, host);
  const result = program.emit(undefined, undefined, undefined, true);
  const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  if (errors.length > 0)
    throw new Error(`api types: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  if (/^\s*import\s/m.test(out)) throw new Error('api types: plugin-api.ts must not import anything');
  return HEADER + out;
}
