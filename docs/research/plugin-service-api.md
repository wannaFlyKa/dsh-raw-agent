# Research: a service API and restyle points for other DSH plugins (R9.1, R9.2)

This note answers critic §6.1 item 2. It covers three questions:

1. How a third-party DSH plugin declares and exposes a **Host** service and a **Client** (browser) service with Cordis.
2. How another plugin depends on those services and calls them.
3. How a client-side restyle plugin overrides our UI pieces: slots, views and theme.

Versions: DSH 0.2.2-rc.1, Cordis 4.1.0 (the `@deepseek-ai/cordis` copy that DSH ships).

Evidence aliases:
- `P/<package>/…` = an installed DSH package (`node_modules/@deepseek-ai/<package>`).
- `npm:<package>@0.2.2-rc.1/…` = a DSH package that the install does not ship, read from the npm tarball.
- `skill:…/references/<file>` = the shipped `cordis-plugin-development` skill in `P/dsh-agent-preset/skills/`.
- **Probe svc-a / svc-b** = the live probe for this note: two linked bundles in an isolated `DSH_HOME` and a throwaway profile, plus a headless Chromium check (`pw-probe.mjs`). svc-a stands in for our plugin, and svc-b stands in for a third-party plugin. The probe results are in the local scratch folder (`probe.log`, `pw-result-2.json`).

---

## Answers for the design

1. **A Host service is `ctx.provide(name, value)` in our `apply`.** Another plugin writes `export const inject = ['<name>']` and then calls `ctx.<name>.method()`.
   - Live (probe svc-b): the consumer row came **before** the provider in the profile, and Cordis still waited. B's `apply` ran about 1 ms after A provided the service. B called `ping`, `sessionInfo` and a callback subscription, and all of them worked.
   - Disabling the provider live disposed the consumer. Enabling it again ran the consumer's `apply` again (probe svc-b, `probe.log`).
2. **Do not `import '@deepseek-ai/cordis'` in the Host half of a profile-installed bundle.** From a linked bundle, the import failed with `ERR_MODULE_NOT_FOUND` (probe svc-a). The DSH install's packages are not on our package's resolution path. A plain object plus `ctx.provide` needs no import. Extending the `Service` class would mean depending on our own copy of Cordis (**unverified**; Cordis says it works across copies, `P/cordis/src/context.ts:52-63`).
3. **A Client service works the same way inside the browser half.**
   - We call `ctx.provide('<name>', api)` in the client `apply`. A consumer client plugin returns `inject: ['slots', '<name>']` from its factory.
   - Live (probe svc-b): B read A's client service and rendered its result. In the browser, `require('@deepseek-ai/cordis')` **does** resolve, because Cordis is in the shell's static module table (`P/dsh-client-ui-renderer/README.md`, "Identity").
   - `dsh.client.inject` in `package.json` is **informational only**: "Informational package-name dependencies, not Cordis service injection" (`P/dsh-package-manifest/lib/types/types.d.ts:85-86`).
4. **Client → Host goes through our own authenticated Fetch routes.** A plugin's client calls our Host only through `ctx.connection.fetch.register` routes, using a relative `api/…` URL.
   - Live: 401 without the DSH cookie, and 200 from the page. This matches the earlier probes r1/r4 in `dsh-ui-surfaces` §8.
   - Our Client service should wrap these routes, so other client plugins never hard-code URLs.
   - The typed `ctx.remote.<namespace>` path (Typert `@Remote`) needs build-time generated artifacts. Its generator expects DSH's monorepo layout. It is not a practical third-party path today (§3).
5. **Host → Client push.** There is no third-party `ctx.remote.$on` event, because forwarded Host events are a fixed allowlist in `dsh-api-remotes` (`P/dsh-api-remotes/README.md:41-43`). To push events to the browser, use:
   - a streaming Fetch route (verified in `dsh-ui-surfaces` §8), or
   - a Session projection with `wire.view` for session-derived state (`skill:…/references/practices.md:38`).
6. **Our service will not appear in `cordis_inspect`.** The inspect Service and Event directories are a **static catalog generated when DSH is built** from DSH's own sources (`P/dsh-tool-cordis/lib/types/api-catalog.js:1-15`; `P/dsh-tool-cordis/README.md:38`). So the API must be documented in our README and in shipped `.d.ts` files (§2.4).
7. **Restyling uses three mechanisms. All of them were verified live (probe svc-b in Chromium):**
   - **Fill our slots.** A slot that our component declares as a `children` entry can be filled by another plugin. B registered into A's declared list slot, and A rendered it.
   - **Shadow our entries.** B registered the same `id` in the same slot with `priority: -1`. Its component replaced A's, and A's original was not rendered.
   - **Override CSS variables.** B rendered a `<style>` that set `--raw-probe-accent`, and A's text turned red. DSH-wide tokens can also be changed through `ctx.theme.register` or `ctx.theme.overrideTokens` (`P/dsh-client-ui-theme/lib/types/client/index.d.ts:200,217`).
8. **No built-in versioning.** Cordis services have no version field (`P/cordis/src/registry.ts:99-110`), and a second `provide` of the same name in one scope throws (`P/cordis/src/reflect.ts:33-43`). Choose a unique name. Put an `apiVersion` number on the service object, and follow semver in the package. Consumers check `apiVersion` (design; §4).

---

## 1. Host services

### 1.1 Declaring

A Host plugin exports one of two forms: `export function apply(ctx, config)` with optional `inject` and `Config`, or a service class as the default export (`skill:…/references/host-plugin.md:57-62`). Cordis gives two ways to register a service:

| Way | Code | Notes |
|---|---|---|
| `ctx.provide(name, value)` | `ctx.provide('rawAgent', api)` | "Register a service implementation owned by the current fiber … unregistered (waking dependents) when the returned disposer runs or the fiber unloads. Throws if the name is already provided in this scope" (`P/cordis/src/reflect.ts:32-46`). Live: works from a linked bundle (probe svc-a). |
| `class X extends Service` + `super(ctx, name)` | the Cordis README pattern | Calls `ctx.reflect.provide(name, this, this[Service.check])` (`P/cordis/src/service.ts:42-58`). Needs `import { Service } from '@deepseek-ai/cordis'`, and that import failed in the Host half of a linked bundle (probe svc-a: `ERR_MODULE_NOT_FOUND`). |

Other rules:
- **Plugin-level `provide`.** `Plugin.Base` has an optional `provide?: string | string[]`, "read by `Service` and by loaders" (`P/cordis/src/registry.ts:107-108`). It is metadata only. The live call is still `ctx.provide`.
- **Our own dependencies.** We need `inject` for the DSH services we use.
  - Live: reading `ctx.connection` without `inject` threw "cannot get property "connection" without inject", and the whole svc-a fiber failed (probe svc-a). The rule is in `P/cordis/src/reflect.ts:152-180`.
  - While svc-a had failed, svc-b never ran its `apply`. So **a provider that fails to activate blocks every dependent, with no error shown in the consumer**. Our `apply` must not throw for optional features.
- **Optional dependencies.** Use `ctx.inject(['name'], cb)` for these. It runs `cb` as a sub-plugin only while the service exists (`P/cordis/src/registry.ts:296-301`).
  - Live: `ctx.inject(['commands'], …)` ran. A missing name (`rawAgentProbeMissing`) did not block the parent (probe svc-a, svc-b).
  - The skill gives the same rule: "Put optional services in `inject` or `ctx.inject([...])`" (`skill:…/references/practices.md:20`).
- **Events.** Cordis has no event-name registry.
  - Live: `ctx.emit('raw-agent-probe/tick', …)` in A reached `ctx.on('raw-agent-probe/tick', …)` in B (probe svc-a, svc-b). A callback-subscription method on the service also worked.
  - Event names should be namespaced (`raw-agent/…`) so they cannot clash with DSH events.

### 1.2 Depending and calling

- **Hard dependency.** `export const inject = ['rawAgent']`. The plugin "only loads while all are available" (`P/cordis/src/registry.ts:105-106`) and restarts when the service changes (`registry.ts:169-176`). Live: B ran, was disposed when A was disabled, and re-ran when A came back (probe svc-b).
- **Soft dependency.** Use `ctx.inject(['rawAgent'], ctx => …)`, or read `ctx.get('rawAgent')`. `ctx.get` reads "without the inject requirement" and returns `undefined` when the service is absent (`P/cordis/src/reflect.ts:9-19`). Live: `typeof ctx.get('rawAgentProbe') === 'object'` (probe svc-b). With `ctx.get`, the consumer is not restarted when we unload. So it must not keep the reference.
- **Load order does not matter.** In the profile `bundles` list, svc-b came before svc-a, and B still waited for A (probe svc-b).
- **Subscriptions belong to the caller's fiber.** B wrapped `onEvent` in `ctx.effect(...)` and was disposed cleanly. For services owned per agent, use the rule in `skill:…/references/practices.md:19`: register on `agent.ctx` and also keep the disposer in your own effect.

### 1.3 What it means for our backend split (rule 13)

The service object is a plain JS object, so the DSH-facing layer can provide it without importing the Claude SDK. Backend-specific data (Claude session id, `modelUsage`) should sit under a `backend` field with a `kind` (`'claude'`, later `'codex'`). Generic methods should not change shape when the backend changes (design).

## 2. Client services

### 2.1 Declaring

- **The bundle.** A client half is a `window.__ModuleLoader__.load({ id, factory(require) { … return { inject, apply } } })` bundle. It is declared in `package.json` `dsh.client` (`skill:…/templates/decoration/client.js`; `P/dsh-client-modules/README.md:34`).
- **Providing.** In `apply`, call `ctx.provide('rawAgentClient', api)`. Live: B consumed it (probe svc-b, `pw-result-2.json`: `B-extra client-pong:b`).
- **DSH does the same.** DSH's own client plugins use the same Cordis Service base. For example, `super(ctx, "uiConversation")` is in `P/dsh-client-ui-conversation/lib/client.js`, and `P/dsh-client-ui-tool/lib/client.js` has `inject: ["slots", "uiConversation"]`.
- **Module imports.** Plugins share one module table. React, React DOM, Cordis, ui-slots and ui-primitives "retain one browser identity" (`P/dsh-client-ui-renderer/README.md`, "Identity"). Live: `require('@deepseek-ai/cordis')` returned a `Service` class (probe svc-a pill text `cordis=yes`).
- **Do not import DSH client packages.** Do not `require` DSH Client packages (ui-primitives and similar) as modules. Their APIs change without notice (`skill:…/references/practices.md:35`).

### 2.2 Depending and calling

- **Service injection (verified).** The consumer factory returns `inject: ['slots', 'rawAgentClient']`. This is the preferred path.
- **Module import (unverified).** A consumer can also `require('<our package>')` if it lists it in `dsh.client.external`. Each request is "answered by the dynamic package row it names", and composition orders "dynamic providers … before their consumers" (`P/dsh-client-modules/README.md:34,55`). Not tested live. Prefer the service: it follows our plugin's enable and disable lifecycle, and a module import does not.

### 2.3 Calling our Host from the browser

- **Fetch routes.** These are the only third-party Client → Host channel that has been checked live (`dsh-ui-surfaces` §8; this probe).
- **Probe detail.** The route registered with `methods: ['POST'], requestBody: 'buffered', fetch: …` returned 200 to a page POST to the relative `api/probe-svc-a/ping`, and 401 without the cookie.
  - The first attempt used a wrong option name (`handler` instead of `fetch`), and that threw inside `apply` (see §1.1 on failed providers).
  - A `GET` route answered 400 to a plain page `fetch`. The cause was not investigated (**unverified**). Use POST, as the r1 probe did.
- **Our client service should own every URL** (`api/raw-agent/…`). Then the route layout can change without breaking consumers.

### 2.4 Types and documentation

- **No inspect discovery.** `cordis_inspect` will not list our services (answer 6). A consumer finds our API only from our docs and types.
- **What to ship** (design, standard TypeScript):
  - `lib/types/host.d.ts`: `declare module '@deepseek-ai/cordis' { interface Context { rawAgent: RawAgentService } }`. This follows the Cordis README pattern (`P/cordis/README.md:23-31`).
  - `lib/types/client.d.ts`: the same augmentation for `rawAgentClient`, plus `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'raw-agent.…': … } }` for our declared slots. Consumers' `register` calls then type-check (`npm:dsh-client-ui-slots@0.2.2-rc.1/lib/types/index.d.ts`, `SlotMap` augmentation; the README's "Implementation" section).
  - Consumers add our package as a dev dependency for types. Type-only imports "are erased and create no module request" (`P/dsh-client-modules/README.md:55`).
- **A README section** "Service API" with every method, its `apiVersion`, its events, and which methods are user-only (§4).

## 3. The Typert `@Remote` path (not recommended for us)

DSH's own services expose typed browser calls with `@Remote` on a `TypertRemoteService` (`P/dsh-typert-protocol/README.md`, "Exposing a Host method"). The steps:

1. The class must extend `TypertRemoteService`, or use `bindTypertRemote()`. Both come from `@deepseek-ai/dsh-typert-protocol`, which hits the same import problem as §1.1.
2. Strict mode needs generated `./typert` and `./remote` artifacts. `dsh-typert-loader` registers the Host face, and `ctx.remote.$mount()` on the Client refuses "Client-supplied fields without strict generated codecs" (`P/dsh-api-gateway/README.md:29,58`; `P/dsh-typert-loader/README.md:115`).
3. The generator (`npm:dsh-typert-generator@0.2.2-rc.1`) is published. But its tsdown plugin finds "the nearest ancestor … that contains both `tsconfig.host.json` and `packages/`" (`README.md`, "Running generation inside a tsdown build"). So it assumes a DSH-style monorepo. Whether a single-package third-party build can use it is **unverified**.
4. Gateway SRC mode is "a development fallback" (`P/dsh-api-gateway/README.md:29`).

Verdict: Fetch routes plus a Client service give the same result with verified pieces. Revisit Typert if DSH documents it for third parties.

## 4. Proposed service surface (design input, not research)

R9.2 asks for: send, steer, side question, session info and events. The table maps each one onto the facts above.

| Member | Host `rawAgent` | Client `rawAgentClient` | Notes |
|---|---|---|---|
| `apiVersion` | number | number | Bump the major version when a shape changes. |
| `send(sessionId, content)` | → `agent.followup` (user source) | POST route | **Raw rule 3.** The text comes from a plugin the user installed, not from typing. Mark it `origin: plugin:<name>` where DSH allows that. Design must decide whether a plugin `send` counts as "user typed". |
| `steer(sessionId, content)` | → `agent.steer` | POST route | Same rule-3 question. |
| `askSideQuestion(sessionId, q)` | → SDK `askSideQuestion` | streaming route | Writes nothing to either transcript (R7.3). |
| `sessionInfo(sessionId)` | backend-neutral object + `backend: { kind, … }` | POST route or `wire.view` projection | Rule 13. |
| `interrupt(sessionId)` | → `interrupt()` | POST route | Rule 6. |
| events | `ctx.on('raw-agent/<name>')` + native session events | streaming route wrapped as `onEvent(fn)` | Prefer the native log events (rule 8). Use `raw-agent/*` events only for data that is not in the log. |
| approvals / answers | **not exposed** to other plugins | answer only from a user gesture in a (possibly restyled) card | "An action that grants or confirms authority … stays user-only" (`skill:…/references/user-actions.md:11`). |

## 5. Restyle points for other plugins (R9.1)

All three mechanisms were checked live in Chromium (probe svc-b, `pw-result-2.json`).

### 5.1 Slots we declare

- **How to declare.** A `register()` call may declare `children: { '<key>': { kind, scope } }`. "Declaring is claiming: the registering entry becomes the only entry allowed to render that key" (`npm:dsh-client-ui-slots@0.2.2-rc.1/README.md`, "Declaration discipline").
- **Filling.** Other plugins fill our slots with `ctx.slots.inject('<key>', () => ctx.slots.register({ name: '<key>', id }, C))`. The `inject` callback waits for the declaration and is disposed when it collapses (`P/dsh-client-ui-renderer/lib/types/client/registry.d.ts:96-111`).
- **Live.** A declared `probe.svcA.pill.extra` list slot (scope `root`) was filled by B.
- **Recommended slots.** Declare named slots for the parts users want to change: the usage panel, the workflow node, the approval card body, the team roster, and the `/btw` panel. Give each a documented owner-props type (design).

### 5.2 Shadowing our entries

- **The rule.** Entries in the same cell (same slot; same `key` for keyed slots; same `id` for list slots) "coexist at distinct priorities … the cell's lowest live entry renders". The same priority twice throws (`npm:dsh-client-ui-slots@0.2.2-rc.1/lib/types/index.d.ts:770-783`; `KindOptions` at `:562-586`).
- **Live.** B registered `id: 'probe-svc-a-badge', priority: -1` in `shell.overlay`. Only B's component rendered.
- **For us.** Register our own entries (dock pills, `tool.call.toolview` views keyed by Claude tool names, `conversation.chat.node` views, composer takeovers) at the default priority 0, and document their ids and keys. A restyle plugin then shadows any one of them with a negative priority. The keyed `tool.call.toolview` rule is the same by type (**not live-tested** for keyed slots).
- **Caution.** Shadowing a single slot replaces everything the old occupant declared. For example, `root` warns that a second entry "shadows" the frame (`registry.d.ts:22-31`). When a restyle replaces one of our entries, it also drops the child slots that entry declared, unless it declares and renders them itself. Keep restyle targets small.

### 5.3 Theme and CSS variables

- **DSH tokens.** Style our components only with `--dsw-alias-*` tokens (`skill:…/references/practices.md:34`).
- **Our own variables.** Add our own `--raw-agent-*` variables with token fallbacks for plugin-specific colours. Live: `color: var(--raw-probe-accent, …)` turned `rgb(255, 0, 0)` after B rendered a `<style>` element from its own slot entry (probe svc-b). It was removed with B's entry.
- **DSH-wide changes.** A restyle plugin can call `ctx.theme.register({ id, colorScheme, tokens, icons })` or `ctx.theme.overrideTokens(source, tokens)` (`P/dsh-client-ui-theme/lib/types/client/index.d.ts:45-56,200,217`; `README.md:42-44`). "Third-party themes are an extension point … no validation exists that an override set is complete" (`README.md:137`). Not run live.

### 5.4 Native events

- **DSH-wide restyles reach us for free.** Because we write native events (rule 8), any plugin that restyles DSH's own tool cards, reasoning body or Chat nodes also restyles our sessions where the names match. This is `dsh-ui-surfaces`, "Answers for the design" (tool cards keyed by wire name).

## 6. Mistakes not to repeat (from the dsh-claude evaluation)

- dsh-claude's routes had no DSH token check and answered 403 behind a tunnel. Our routes use `ctx.connection.fetch.register`: 401 without the cookie (this probe), and trusted-host aware (`dsh-ui-surfaces` §8).
- Its transcript lived in a private file, so other plugins saw only final answers. Our service exposes the native log as its main event source.

## Open questions

1. Does a plugin-initiated `send` or `steer` satisfy raw rule 3? Is it acceptable when it is marked and documented, or must it be refused? (maintainer or design)
2. Why did the `GET` Fetch route answer 400 to a plain page `fetch`? (small; POST works)
3. Keyed-slot shadowing (`tool.call.toolview`) and `ctx.theme.register` were not run live.
4. Can a single-package build use the Typert generator? Only matters if we want typed `ctx.remote` calls.
5. Do pnpm or the plugin manager enforce a consumer's `peerDependencies` range on our package between bundles (**unverified**)? Otherwise the `apiVersion` check is the only guard.
