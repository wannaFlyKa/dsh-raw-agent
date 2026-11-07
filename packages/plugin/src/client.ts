// Client entry (`dsh-raw-agent/client`, lib/client.js). Built by scripts/bundle.mjs into DSH's
// module-loader format (`window.__ModuleLoader__.load({id, factory(require)})`), with React and
// react-dom from DSH's shared module table. The Claude tool views (views-claude, D19) are passed to
// the client port, which registers them for our sessions only.

import { createRawAgentClient } from '@dsh-raw-agent/dsh-client';
import { toolViewPack } from '@dsh-raw-agent/views-claude';

const client = createRawAgentClient({
  name: 'dsh-raw-agent-client',
  toolViews: [toolViewPack],
  agentNames: ['Claude Code'],
});

export const name = client.name;
export const inject = client.inject;
export const apply = client.apply;
