# Plugin API (for other DSH plugins)

This page is for authors of other DSH plugins. It covers two things:

1. **Services** (R9.2): read the state of our sessions, follow plugin-only events, put text in our composer, stop a turn, and, with the user's grant, send messages and side questions.
2. **Restyle points** (R9.1): which slots, entries, chat nodes, tool views and CSS variables you can fill, shadow or override.

Design background: [architecture](architecture.md) D66 (services and grants), D67 (restyle points), §7.3, and the research note [plugin-service-api](research/plugin-service-api.md).

Versions: API version 1. Tested on DSH 0.2.2-rc.1 only. Items marked **unverified** were not checked live.

## 1. Read the native log first

Our sessions write **native DSH events** (rule 8): `user/message`, `assistant/message` (prose and thinking), `tool/call`, `tool/result`, steps, turns, jobs and workflow records. So most plugins need nothing from us. A plugin that reads DSH session logs, exports or searches them, or restyles DSH's own tool cards already works in our sessions.

Use our services only for data the log does not have (process state, usage and cost, workflow snapshots, child agents, waiting asks), and to act on our sessions.

## 2. Services

| Service | Where | Provided by |
| --- | --- | --- |
| `rawAgent` | Host (Node) | the `dsh-raw-agent` Host entry, `ctx.provide('rawAgent', api)` |
| `rawAgentClient` | Client (browser) | the `dsh-raw-agent/client` bundle, `ctx.provide('rawAgentClient', api)` |

Both are plain objects with `apiVersion: 1`. Check it before you use the service. A shape change bumps the number.

The services do not appear in `cordis_inspect` (its catalog is built from DSH's own sources). This page and the types below are the reference.

### 2.1 Depend on the service

Host plugin, hard dependency (your plugin loads only while ours runs, and restarts with it):

```ts
export const name = 'my-plugin';
export const inject = ['rawAgent'];

export function apply(ctx) {
  const api = ctx.rawAgent;
  if (api.apiVersion !== 1) return;
  // sessionId: a DSH session id you got elsewhere (section 2.1.1).
  ctx.effect(() => api.onEvent(sessionId, (e) => { /* … */ }));
}
```

Host plugin, soft dependency: `ctx.inject(['rawAgent'], (ctx) => { … })`. Do not keep a reference you read with `ctx.get('rawAgent')`: you are not restarted when our plugin unloads.

Client plugin: return `inject: ['slots', 'rawAgentClient']` from your module factory and use `ctx.rawAgentClient`.

Do not `import` our package at run time. For types, add `dsh-raw-agent` as a dev dependency and use `import type` from `dsh-raw-agent/api` (a types-only export, `lib/api.d.ts`). Type-only imports are erased. To type `ctx.rawAgent` and `ctx.rawAgentClient`, add this to your own sources (if you have DSH's Cordis types):

```ts
import type { RawAgentClientService, RawAgentService } from 'dsh-raw-agent/api';
declare module '@deepseek-ai/cordis' {
  interface Context {
    rawAgent: RawAgentService;
    rawAgentClient: RawAgentClientService;
  }
}
```

A working client plugin that uses every Client method is [examples/sample-restyle](../examples/sample-restyle/README.md).

#### 2.1.1 Where the session id comes from

Every method takes a DSH session id. Our services list no sessions, so get the id from DSH:

- **Client, in a slot entry:** DSH passes the session id to the entry's `inject` option. Register with
  `inject: (sessionId) => ({ sessionId })`, and your component gets `props.sessionId` (section 3, "Shadow an entry").
  This is what the sample does.
- **Client, our own slot** `raw-agent.controls.extra`: the owner props carry `sessionId` (section 3.2).
- **Host:** from whatever DSH gives your plugin for a session, for example a route your plugin serves (the browser sends
  the id) or a DSH event that carries the agent (`p.agent.session.id`). Which DSH events reach a plugin outside our agent
  preset is **unverified**.

Then call `sessionInfo(sessionId)`. It answers `undefined` for a session that is not ours, so you can use it as the
"is this a Claude Code session?" check.

### 2.2 Types

The types live in `@dsh-raw-agent/core` (`packages/core/src/plugin-api.ts`, a private package). The published package ships them as one self-contained file, `dsh-raw-agent/api` (`lib/api.d.ts`).

**Runtime exports vs types-only exports.** `dsh-raw-agent/api` has only a `types` condition in `exports`. It exports **no runtime value**. Use it only with `import type`.

| What | How to use it |
| --- | --- |
| `RawAgentService`, `RawAgentClientService`, the info and event types below | `import type` from `dsh-raw-agent/api` |
| The services themselves | `ctx.rawAgent` (Host) and `ctx.rawAgentClient` (Client), through `inject` |
| `RawAgentServiceError` | Read `e.name === 'RawAgentServiceError'` and `e.code` (section 2.4). Do not use `instanceof` |
| `isRawAgentServiceError`, `PublicEventTracker`, the constants | Declared in `lib/api.d.ts` because our own code shares the file. **Do not import them as values**: the import type-checks, but it fails when you bundle or run it |

Our package's other entries (`.`, `./agent`, `./client`) are DSH plugin bundles. Do not import them.

```ts
interface RawAgentService {
  readonly apiVersion: 1;
  /** The backends this plugin runs (one agent preset each). Client: the backends seen so far. */
  readonly backends: readonly RawAgentBackendInfo[];
  /** Undefined when the session is not one of ours. Never starts a process. */
  sessionInfo(sessionId: string): Promise<RawAgentSessionInfo | undefined>;
  /** DSH's own Stop. The process and its background tasks keep running. */
  interrupt(sessionId: string): Promise<void>;
  /** Plugin-only data. The current state comes at once, then each change. Returns unsubscribe. */
  onEvent(sessionId: string, listener: (e: RawAgentPublicEvent) => void): () => void;
  /** A new turn. Needs a grant token. */
  send(sessionId: string, text: string, grant: string): Promise<{ messageId: string }>;
  /** Into the running turn (or a new one when idle). Needs a grant token. */
  steer(sessionId: string, text: string, grant: string): Promise<{ messageId: string }>;
  /** A side question (`/btw`). Needs a grant token and a running agent. null: no answer. */
  askSideQuestion(sessionId: string, question: string, grant: string): Promise<string | null>;
}

interface RawAgentClientService extends RawAgentService {
  /**
   * Text into our composer (at the caret) or the side chat's box. Nothing is sent. No grant.
   * 'side-question' (0.1.2): opens or focuses our Side chat tab in DSH's right sidebar and puts the text in its box.
   */
  prefill(sessionId: string, text: string, target?: 'composer' | 'side-question'): Promise<boolean>;
}

interface RawAgentBackendInfo { kind: string; displayName: string; version?: string }

interface RawAgentSessionInfo {
  sessionId: string;
  backend: RawAgentBackendInfo;
  process: 'none' | 'starting' | 'running';
  running: boolean;          // process === 'running'
  busy: boolean;             // a DSH turn runs
  backgroundTasks: number;   // background agents, workflows, shells
  waitingForUser: number;    // asks that wait for the user
  mode?: string;             // the permission mode the agent reports (or the one picked before start)
  model?: string;            // the model the agent reports
  backendSessionId?: string; // the agent's own session (transcript) id, while it runs
}

type RawAgentPublicEvent =
  | { type: 'state'; sessionId: string; info: RawAgentSessionInfo }
  | { type: 'usage'; sessionId: string; usage: RawAgentUsageInfo }
  | { type: 'workflows'; sessionId: string; runs: RawAgentWorkflowInfo[] }
  | { type: 'children'; sessionId: string; children: RawAgentChildInfo[] }
  | { type: 'asks'; sessionId: string; asks: RawAgentAskInfo[] }
  | { type: 'ended'; sessionId: string };

interface RawAgentUsageInfo {
  tokens?: number;
  costUsd?: number;
  costLabel?: string;
  context?: { used: number; window: number; percent: number };
  compacting: boolean;
  limit?: { id: string; label: string; percent?: number; resetsAt?: number; status?: string };
  limitsAvailable?: boolean;
}

interface RawAgentWorkflowInfo {
  taskId: string; runId: string; name: string; status: string;
  phases: Array<{ index: number; title: string }>;
  agents: Array<{ index: number; label: string; state: string; phaseIndex?: number; tokens?: number }>;
  startedAt: number; endedAt?: number;
}

interface RawAgentChildInfo {
  id: string; parent: string; label: string; status: string; background: boolean;
  hostSessionId?: string; // the DSH child session: read its native log for the content
  tokens?: number;
}

interface RawAgentAskInfo { id: string; kind: string; agent: 'main' | 'child'; title: string; at: number }
```

Absent usage fields are unknown. They are never a made-up 0 (rule 11).

### 2.3 Events

- `onEvent` sends `state` at once. Each other kind is sent when the view has it, and then only when its content changes. A list that empties is sent once as an empty list.
- `ended` comes once when our Host no longer holds the session (the session closed, or our plugin was disabled). Nothing follows it.
- On the Host, events follow the agent runtime directly. On the Client, they follow the same session store our controls use, which polls the Host (about every 1.5 s during a turn, 4 s otherwise) while a listener is subscribed.
- An `asks` event shows only the id, kind, who asked, the title and the time. **Choices, forms and answers are never exposed**, and no service method answers an ask. Only the user answers, with a click in our card (or in a card your plugin draws in place of ours, section 3).
- Subscribe inside `ctx.effect(...)`, so your fiber removes the listener when it unloads.

### 2.4 Errors

A refused call rejects with `RawAgentServiceError` (`name: 'RawAgentServiceError'`, `code`). `dsh-raw-agent/api` ships types only, so check `e.name === 'RawAgentServiceError'` and read `e.code` (do not import `isRawAgentServiceError` as a value, section 2.2). The error object can come from another bundle's copy of the class, so `instanceof` is not reliable either.

```ts
function refusalCode(e: unknown): string | undefined {
  const x = e as { name?: unknown; code?: unknown } | null;
  return x && x.name === 'RawAgentServiceError' && typeof x.code === 'string' ? x.code : undefined;
}
```

| `code` | Meaning |
| --- | --- |
| `not-our-session` | Not a session of this plugin, or not open in DSH. |
| `no-grant` | No grant token was given. |
| `bad-grant` | The token is wrong, or the user revoked it. |
| `not-running` | The agent has no running process. The user must start it (we never start one for a plugin, rule 9). |
| `empty`, `too-long` | The text is empty, or longer than 100 000 characters (side questions: 20 000). |
| `busy` | Another side question is still open. |
| `unsupported` | This backend or version cannot do it. |
| `failed` | DSH or the agent refused or failed the call. |

### 2.5 Grants (send, steer, side questions)

By default another plugin can read, subscribe, interrupt and **prefill**. Prefill puts text in front of the user, who decides whether to press Enter.

To send text to the agent **without a keypress**, a plugin needs a grant:

1. The user opens **Agent plugin access**: in DSH's settings panel (the nav row can show it cut short, "Agent plugin a…"), or at the bottom of our "Settings files" dialog in the composer row. Both show the same page.
2. The user names the plugin and presses **Create grant**. The panel shows a token (`rag1_…`) **once**.
3. The user pastes the token into that plugin's own config. The plugin passes it on each call.
4. **Revoke** stops the token at once.

Facts about grants:

- **A grant is a consent switch, not a security boundary.** DSH runs every plugin in one process and treats them as trusted collaborators. A hostile plugin could read the profile config or wrap our service. The grant stops a well-behaved plugin from sending text to the model without the user's consent (rule 3).
- We store only the token's SHA-256 hash. It lives in DSH's own storage (`ctx.storageDomain`, DSH's json files under the DSH home), so **a grant is remembered across DSH restarts** until the user revokes it (D88, checked live). The panel says "saved: kept after a DSH restart". A create or a revoke never restarts our entry, so no agent process or background task ends (checked live: same CLI pid).
- Grants belong to the DSH home: every profile of that home that has this plugin sees them.
- If DSH's storage is missing or cannot open, a grant is kept for this DSH run only, and the panel says "kept until DSH restarts" (D88 fallback).
- Old grants in our Host entry config (field `grants`) are taken in once, at the first start.
- A granted message goes into the DSH inbox with `source: { kind: 'raw-agent-plugin', grant: '<grant name>', grantId: '<id>' }` and is written to the session log unchanged. It is **never** `source.kind: 'user'`, which DSH reads as typed by the human. So the log, exports and DSH's title rule can tell plugin text from typed text.
- A `raw-agent-plugin` message that did not come through our service (a plugin that calls `agent.followup` itself) is dropped like any DSH notice and never reaches the agent.
- Each admitted message id is used once. A later message that reuses the id (for example one copied from the session log) is dropped. If the user revokes the grant before the agent took the message, the message is dropped too. If DSH refuses the message (`failed`), nothing stays admitted.
- `askSideQuestion` writes nothing to any log. The question and its answer also show in our side chat, so the user sees them (0.1.2: the **Side chat** tab in DSH's right sidebar opens for it).
- The grant routes (`api/raw-agent/grants…`) use DSH's own cookie authentication. Any page script with that cookie can call them, which is the same trust level as above.

#### 2.5.1 A grant can end: handle it

A grant ends when the user revokes it, or at a DSH restart when DSH's storage was not available (above). A token your plugin stored then answers `bad-grant`. Plan for it:

- Treat `bad-grant` as "the user must create a new grant". It also means "revoked". Do not retry the call in a loop.
- Tell the user once, in your own UI or log: "dsh-raw-agent access ended. Create a new grant in **Agent plugin access** and paste the token here."
- Keep the token in your plugin's own config (or a field the user fills), so the user can replace it without a reinstall.
- Where the user is present, fall back to `prefill` (Client), which needs no grant: the user presses Enter.
- `no-grant` means you passed no token at all.

### 2.6 Examples

Host: tell the user when Claude Code waits for an answer. `watch(sessionId)` is called with a session id your plugin got from DSH (section 2.1.1).

```ts
export const inject = ['rawAgent'];
export function apply(ctx) {
  const watch = async (sessionId) => {
    if (!(await ctx.rawAgent.sessionInfo(sessionId))) return; // not a Claude Code session
    ctx.effect(() =>
      ctx.rawAgent.onEvent(sessionId, (e) => {
        if (e.type === 'asks' && e.asks.length > 0) ctx.logger.info(`waiting: ${e.asks[0].title}`);
      }),
    );
  };
  // … call watch(id) from your route or event handler.
}
```

Host: a granted follow-up.

```ts
// sessionId as above; config.rawAgentGrant is the token the user pasted into your plugin's config.
try {
  await ctx.rawAgent.send(sessionId, 'Run the tests again, please.', config.rawAgentGrant);
} catch (e) {
  if (e.name === 'RawAgentServiceError' && e.code === 'bad-grant')
    ctx.logger.warn('dsh-raw-agent access ended (revoked by the user): create a new grant');
}
```

Client: offer a canned prompt the user can edit and send (`sessionId` from the entry's props, section 2.1.1).

```ts
await ctx.rawAgentClient.prefill(sessionId, 'Explain the last diff in plain words.');
```

A side question the user can edit and ask (0.1.2): the target `'side-question'` opens our **Side chat** tab in DSH's
right sidebar (or focuses it) and puts the text in its box. The method name and arguments did not change. On a DSH
without the right-sidebar tab API (`ctx.sidebarRightTabs`), the text goes into the old side-question box near the
composer, as in 0.1.1. The tab opens in the session the user is looking at; text for another session waits until the
user opens that session.

```ts
await ctx.rawAgentClient.prefill(sessionId, 'What does the failing test check?', 'side-question');
```

### 2.7 The client plugin format

DSH loads a client plugin from your package. The sample has every part; this is what each one does.

**`package.json`:**

```json
{
  "name": "my-restyle",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0-0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["dsh-raw-agent"] }
  }
}
```

- `exports["."]` is the Host entry (Node). `exports["./client"]` is the browser bundle DSH serves.
- `dsh.bundle.patch` is your Cordis patch: it inserts your Host row (`- insert: [{ id: my-restyle, name: 'my-restyle' }]`).
- `dsh.client.platform: "web"` declares the browser half. `immediately: true` loads it when the page starts (our package does the same).
- `dsh.client.inject` lists packages your client bundle relates to. DSH reads it as loading metadata only; it does **not** order your `apply` after ours (a comment in DSH 0.2.2-rc.1, `P/dsh-client-ui-workspace/lib/client.js:5738-5741`). Order comes from the fiber `inject` below and from `ctx.slots.inject(...)`.

**`client.js`** is plain JavaScript in DSH's module-loader format (no build step):

```js
window.__ModuleLoader__.load({
  id: 'my-restyle',
  factory(require) {
    const React = require('react'); // DSH's shared React; do not bundle your own
    return {
      name: 'my-restyle-client',
      inject: ['slots', 'rawAgentClient'], // your apply runs while both services exist
      apply(ctx) {
        if (ctx.rawAgentClient.apiVersion !== 1) return;
        ctx.slots.inject('raw-agent.controls.extra', () =>
          ctx.slots.register(
            { name: 'raw-agent.controls.extra', id: 'my-button', inject: (sessionId) => ({ sessionId }) },
            (props) => React.createElement('button', { type: 'button' }, `Mine (${props.sessionId})`),
          ),
        );
      },
    };
  },
});
```

A bundler can produce the same shape; keep `react` external and read it with `require('react')`.

**Install a local plugin** into a throwaway profile (never your daily one), then restart DSH:

```sh
dsh plugin --profile <profile> add "file:$PWD/path/to/my-restyle"
```

### 2.8 Client routes (for reference)

The Client service wraps these routes. Call the service, not the URLs: the routes can change between versions. All are `POST` with a JSON body and a relative URL, so DSH's cookie authentication, `--public-url` prefixes and its trusted-host checks apply (D62).

| Route | Body |
| --- | --- |
| `api/raw-agent/plugin/session-info` | `{session}` |
| `api/raw-agent/plugin/interrupt` | `{session}` |
| `api/raw-agent/plugin/send` | `{session, text, grant, mode: 'send' \| 'steer'}` |
| `api/raw-agent/plugin/side-question` | `{session, question, grant}` |
| `api/raw-agent/grants`, `…/grants/create`, `…/grants/revoke` | `{}`, `{label}`, `{id}` (the access panel) |

A refusal answers 400, 403, 404, 409 or 502 with `{error, code}`. It never answers 401, which is DSH's "not signed in".

## 3. Restyle points (R9.1)

Three mechanisms work (checked live with a probe plugin, D67):

- **Shadow an entry.** Register the same slot, the same `id` (list slots) or `key` (keyed slots), with a lower `priority` (for example `-1`). The lowest live priority renders. Ours are at the default `0` unless noted. Two entries at the same priority throw.
- **Fill a slot.** Add your own entry next to ours.
- **Override CSS variables.** Set our `--raw-agent-*` variables, or DSH theme tokens (`ctx.theme.overrideTokens`).

When you shadow one of our entries, your component replaces ours completely, including any behaviour it had. Keep restyle targets small. Your entry gets the same props DSH passes to ours; the extra props we add through `inject` are not passed to yours.

**The session id in a shadowing entry.** Session-scoped list slots such as `conversation.composer.dock` do not put the session id in the props by themselves. Add the `inject` option to your registration; DSH calls it with the session id, and its result becomes props:

```js
ctx.slots.register(
  { name: 'conversation.composer.dock', id: 'raw-agent-context', priority: -1, inject: (sessionId) => ({ sessionId }) },
  MyPill,
);
```

Then check `sessionInfo(props.sessionId)` (or follow `onEvent`) and render nothing in sessions that are not ours. Checked live (M8): the sample's pill does exactly this.

### 3.1 Our entries

| Slot | `id` / `key` | Order or priority | What it is |
| --- | --- | --- | --- |
| `conversation.input.left` | id `raw-agent-session-controls` | order 50 | Model, effort, mode and agent chips (0.1.1: compact chips in DSH's pill style), MCP, Side chat button (0.1.2), Rewind, Settings files, status line; the inline side-question box only on a DSH without the right-sidebar tab API |
| `conversation.composer.dock` | id `raw-agent-context` | order 2 | Context pill and usage panel |
| `conversation.input.dock` | id `raw-agent-lifecycle` | order 30 | Crash or exit banner with Restart; fork and recovery notes |
| `conversation.session.header.actions` | id `raw-agent-agents` | order 20 | Agents button (children, team, background tasks); child strip in a child session |
| `conversation.composer` | (selected by interaction kind `raw-agent-ask`) | priority -20 | Permission, question, plan and elicitation cards that take over the composer. To replace it, register below -20 and select only `raw-agent-ask`. **Unverified** for third parties. |
| `settings.section` | id `raw-agent-plugin-access` | order 900 | The **Agent plugin access** (grants) page. Live M8: it renders; DSH's nav row may cut the name short. |
| `conversation.input.left` | id `raw-agent-plugin-extras` | order 51 | Declares our slot `raw-agent.controls.extra` (section 3.2) and renders what fills it. |
| `sidebar.right.pane.tab` | key `dsh-raw-agent/side-chat` (tab kind `raw-agent-side-chat`, registered in `ctx.sidebarRightTabs`) | — | 0.1.2: the **Side chat** tab in DSH's right sidebar: this session's side questions and answers, and a box to ask. A page type with no guide entry: it opens from our Side chat button, `/btw` and `prefill(…, 'side-question')`. |
| `settings.general.item` | id `raw-agent-access-note` | order -19 | 0.1.1: a note right under DSH's own access row (order -20) in Settings > General: DSH's file access does not control Claude Code sessions. |

Our entries render nothing in sessions that are not ours (the Host answers 404).

### 3.2 Our slots

| Slot | Kind, scope | Where | Owner props |
| --- | --- | --- | --- |
| `raw-agent.controls.extra` | list, session | In the composer row of our sessions, right after our controls | `{ sessionId, backend: { kind, displayName } }` |

Fill it with `ctx.slots.inject('raw-agent.controls.extra', () => ctx.slots.register({ name: 'raw-agent.controls.extra', id: '<your id>' }, Component))`. The `inject` callback waits for our declaration and is removed when it goes. It renders only in our sessions. It is declared by its own small entry, so shadowing our controls does not drop it. The session-scoped declaration works live (M8: the sample fills it in a real DSH 0.2.2-rc.1).

### 3.3 Chat nodes

Keyed `conversation.chat.node` entries (DSH conversation Definitions we register):

| `key` | What it draws |
| --- | --- |
| `raw-agent-wake` | The card that opens a turn the agent started by itself (a background task ended) |
| `raw-agent-workflow` | The workflow card (phases, agents, numbers, "Stop entire workflow") |
| `raw-agent-local-command` | Output of `/context`, `/usage`, `/cost` and other local commands |
| `raw-agent-command-marker` | The `/clear` divider and the `/compact` marker on the typed command |

### 3.4 Tool views

Keyed `tool.call.toolview` entries, one per wire tool name: `Bash`, `Read`, `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob`, `Agent`, `Task`, `TodoWrite`, `WebFetch`, `WebSearch`, `Skill`, `ExitPlanMode`, `AskUserQuestion`.

Each draws our view only in our sessions (and their child sessions); elsewhere it draws a plain row. A shadowing entry applies to **every** session with that tool name, so check the session first, for example with `rawAgentClient.sessionInfo(sessionId)`. Shadowing a keyed slot is **unverified** live; the rule is the same as for list slots by type.

Tool names DSH's own tools use (`bash`, `read`, `edit`, …, lower case) are not ours. They come from DSH, and DSH-wide restyles of them reach our sessions only where the names match.

### 3.5 CSS variables

Our components use `var(--raw-agent-<name>, var(--dsw-alias-<token>, <system colour>))`. Set any of these on a parent element or `:root`. Since 0.1.1 the middle column names DSH 0.2.2-rc.1's real theme tokens, so with no override our components follow DSH's light and dark themes. (0.1.0 used alias names DSH does not define, so it fell back to system colours.)

| Variable | Falls back to | Used for |
| --- | --- | --- |
| `--raw-agent-text` | `--dsw-alias-label-primary` | Text in panels and dialogs |
| `--raw-agent-muted` | `--dsw-alias-label-secondary` | Hints, secondary text |
| `--raw-agent-surface` | `--dsw-alias-bg-layer-1` | Dialog and panel backgrounds |
| `--raw-agent-border` | `--dsw-alias-border-l2` | Borders |
| `--raw-agent-accent` | `--dsw-alias-button-primary-fill` | Primary buttons |
| `--raw-agent-on-accent` | `--dsw-alias-label-primary-foreground` | Text on primary buttons |
| `--raw-agent-link` | `--dsw-alias-link` | Links |
| `--raw-agent-danger` | `--dsw-alias-state-error-primary` | Errors, failed rows |
| `--raw-agent-done` | `--dsw-alias-state-success-primary` | Finished rows |
| `--raw-agent-running` | `--dsw-alias-state-business-primary` | Running rows |
| `--raw-agent-warn` | `--dsw-alias-state-warn-label` | Warnings in the MCP panel |
| `--raw-agent-warning` | `--dsw-alias-state-warn-primary` | The exit banner's warning border |
| `--raw-agent-ask-border` | `--dsw-alias-state-warn-primary` | Ask cards and the waiting tool card outline |
| `--raw-agent-code-bg` | `--dsw-alias-markdown-code-block` | Code and previews |
| `--raw-agent-secret` | `--dsw-alias-markdown-code-block` | Masked values in the settings preview |
| `--raw-agent-diff-add` | `--dsw-alias-code-diff-added` | Added diff lines |
| `--raw-agent-diff-del` | `--dsw-alias-code-diff-deleted` | Removed diff lines |
| `--raw-agent-context-warn` | `--dsw-alias-state-warn-primary` | Context pill, high use |
| `--raw-agent-context-high` | `--dsw-alias-state-error-primary` | Context pill, near the limit |
| `--raw-agent-context-busy` | `--dsw-alias-state-business-primary` | Context pill while compacting |
| `--raw-agent-mono` | system monospace | Monospaced text (no DSH alias) |
| `--raw-agent-chip-text` | `--dsw-alias-label-tertiary` | 0.1.1: chip text (as DSH's composer pills) |
| `--raw-agent-chip-text-hover` | `--dsw-alias-label-secondary` | Chip text on hover and focus |
| `--raw-agent-chip-hover` | `--dsw-alias-interactive-bg-hover` | Chip background on hover and focus |
| `--raw-agent-chip-radius` | `--dsw-radius-sm` | Chip corner radius |
| `--raw-agent-chip-plan` | `--dsw-alias-state-business-primary` | Mode chip, plan (blue) |
| `--raw-agent-chip-caution` | `--dsw-alias-state-warn-primary` | Mode chip, accept edits, auto and don't ask (amber) |
| `--raw-agent-chip-danger` | `--dsw-alias-state-error-primary` | Mode chip, bypass permissions (red) |
| `--raw-agent-chip-session-mode` | `--dsw-alias-state-done-primary` | Effort chip while ultracode is on |

The mode chip's text colour mixes its tone with `--dsw-alias-label-primary`, so it stays readable in both themes.

**Chips (0.1.1).** Each picker is a `.raw-agent-chip` element with `data-raw-agent="model-chip"` (also `effort-chip`, `mode-chip`, `agent-chip`). An invisible native `<select>` with the old `data-raw-agent="model"` (`effort`, `mode`, `agent`) lies on top, so the browser's list and the keyboard work. Attributes you can style: `data-risk="neutral|plan|caution|danger"` (mode chip), `data-from-settings` (the value comes from the user's settings; the chip shows a small dot), `data-session-mode` (ultracode on), `data-disabled`. MCP, Rewind and Settings files are `.raw-agent-chip` buttons. The status line is `.raw-agent-status` (`data-level="info|error"`); it fades after a few seconds (`data-fading`, then `data-faded`, which hides it visually but keeps it in the `role="status"` live region).

### 3.6 DOM hooks

Our elements carry `data-raw-agent="<name>"` attributes (for example `controls`, `settings-panel`, `grants-panel`, `side-ask`). They are for tests and CSS selectors; their names can change between versions, so prefer the variables above.

## 4. What is not offered

- No method answers a permission, question, plan or elicitation, or reads its choices (D66).
- No method starts an agent process. The user starts it (D4, rule 9).
- No method writes the user's Claude Code settings files (rule 2).
- No Host-to-browser push other than through the Client service (DSH forwards a fixed list of Host events only).
