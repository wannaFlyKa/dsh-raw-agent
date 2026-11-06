// Client entry (`dsh-raw-agent/client`, lib/client.js). Built by scripts/bundle.mjs into DSH's
// module-loader format (`window.__ModuleLoader__.load({id, factory(require)})`), with React and
// react-dom from DSH's shared module table. Tool views (views-claude, D19) are not registered yet:
// DSH's generic card renders every tool for now.

import { createRawAgentClient } from '@dsh-raw-agent/dsh-client';

const client = createRawAgentClient({ name: 'dsh-raw-agent-client' });

export const name = client.name;
export const inject = client.inject;
export const apply = client.apply;
