# dsh-raw-agent: instructions for agents and contributors

> **This file is the single source of truth for agent instructions in this repo.**
> `AGENTS.md` only points here. When you learn something durable (a decision, a command, a pitfall), update **this file**. Never put instructions in `AGENTS.md`.
> This way Claude Code, DSH, Codex, and any other harness all read the same rules.

## 1. What this project is

`dsh-raw-agent` is an open-source (MIT) plugin for **DeepSeek Harness (DSH)**. It runs the user's **own, unmodified Claude Code CLI** as the agent for DSH sessions. DSH supplies the UI and its plugin system; Claude Code supplies the agent.

**Who it is for:** people who know Claude Code well and want DSH's plugin system, so they can change how the interface looks and how some default behaviour works, **without losing anything Claude Code does**.

**Later:** other agent CLIs (Codex, ACP agents) behind the same backend interface.

The full requirement list, with acceptance checks, is in [docs/requirements.md](docs/requirements.md). Architecture decisions are in [docs/architecture.md](docs/architecture.md) (created during the design phase).

## 2. The raw contract (non-negotiable)

Every change must keep all of these true. If a feature seems to need breaking one, stop and record the trade-off in `docs/architecture.md` and ask the maintainer.

1. **The user's own binary.** Run the user's `claude` (a configured path, else `PATH`, else `~/.local/bin/claude` on every OS). Never run the SDK-bundled CLI. Do not ship or install the SDK's platform binaries if it can be avoided.
2. **The user's own configuration.**
   - Load `user`, `project` and `local` setting sources, so CLAUDE.md, memory, skills, plugins, hooks, MCP servers, agents and output styles behave exactly as in the CLI.
   - The plugin **never writes** the user's Claude Code settings files. It gives quick access to open them: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`.
   - The CLI writing a permission rule after the user picks "always allow" is allowed, because the TUI does the same.
3. **No prompt injection.**
   - The system prompt is the `claude_code` preset with **no append**.
   - Only text the user typed or explicitly attached reaches the model. That means no synthetic user turns, no rewritten tool results, and no hidden helper prompts.
4. **No forced behaviour.** Do not force tools, env feature flags, settings layers (`--settings`), the model, the effort or the permission mode. The default is whatever the user's settings say. A choice the user makes in the UI for one session goes through official SDK controls (`setModel`, `setPermissionMode`, `applyFlagSettings`) and is never written to settings files.
5. **A clean environment.** Pass the user's environment through. Strip only variables that belong to a *host* Claude Code session (for example `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_EFFORT`, `CLAUDE_PID`). The exact list must be verified. Never strip the user's tokens or keys.
6. **Stop only interrupts.** Stop calls `interrupt()`. The process and its background tasks keep running. To stop one task, use `stopTask`.
7. **Never hold a DSH turn for background work.** Background agents, workflows and shells show as DSH jobs, and the session stays free, as in the TUI.
8. **Native DSH events first.** Put prose, thinking, tool calls and tool results in the DSH session log as native events, so DSH fork, export, search and other plugins work. Use a side store only for data DSH has no event type for, and document it.
9. **No hidden extra processes.** Do not spawn extra `claude` runs the user did not ask for (titles, metadata, probes). Prefer the live session process and SDK controls (for example `generateSessionTitle`, `askSideQuestion`, `getContextUsage`, `supportedCommands`).
10. **Full Claude Code coverage.** Subagents, agent teams, dynamic workflows (including ultracode), every permission mode (default, acceptEdits, plan, auto, dontAsk, bypassPermissions), MCP, skills, plugins, hooks, slash commands, `/btw`, plan mode, AskUserQuestion, images, resume, fork, rewind, interrupt and steer.
11. **Honest usage numbers.** Show what the CLI reports: per-turn usage (including cache read and write), cost, `modelUsage`, context from `getContextUsage()`, and plan rate limits for subscription accounts. This must work for subscription, API key, Bedrock and Vertex auth.
12. **Safe and portable.**
    - HTTP routes (if any) use DSH's own authentication and trusted-host rules. No localhost-only gates, and no route that serves arbitrary files.
    - No telemetry.
    - Linux, macOS and Windows.
13. **Multi-CLI ready.** Claude-specific code lives behind a backend interface. The DSH-facing layer must not import the Claude SDK.

## 3. Prior art (read, do not copy blindly)

- **`@norman-else/dsh-claude`** (MIT). A full-featured DSH plugin for Claude Code. It breaks rules 3, 4, 6, 7 and 8 (see the evaluation). Reusing its code is allowed if you keep its MIT notice, but we build from scratch.
- **t3code** (`github.com/pingdotgg/t3code`). The reference for Claude Code UI fidelity: workflows, subagents, usage, interrupt and fork. See `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- **`cocofhu/dsh-aio-agent`.** A multi-CLI DSH plugin built on an `agent/pre-step` driver, with one process per turn.
- **`@agentclientprotocol/claude-agent-acp`.** The ACP route.
- If the local, git-ignored `research/` folder exists, read `research/README.md` first. It holds the full evaluation with file-and-line evidence.

## 4. Known facts and pitfalls

- **Writing `tool/call` events** without a matching advertised tool-call block in `assistant/message` corrupted DSH v4 session logs (dsh-claude issue #57). Prove the native event sequence in a spike before building on it.
- **`/btw`** is TUI-only as a typed command. Headless mode answers "/btw isn't available in this environment". The SDK's `Query.askSideQuestion(question, {history})` exists (not declared in the types) and uses the same engine.
- **Workflows:** the CLI sends `workflow_progress` (phases and agents) on `system/task_progress`. It is not in the public SDK types.
- **`interrupt()`** spares background tasks only when `perTaskStopAffordance: true` is set at start. Never dispose the process on Stop.
- **Model aliases:** with `enforceAvailableModels`, the `haiku`, `sonnet` and `default` aliases can resolve to the user's default model. Never assume an alias is cheap.
- **Sandboxing:** inside a DSH file sandbox, Claude Code can fail with `EROFS` on `~/.claude/session-env`. Spawn the CLI from a process that can write to `~/.claude`.
- **Host session variables:** a DSH started from inside a Claude Code session inherits `CLAUDE*` variables (see rule 5).
- **DSH's model seat and `/model` save the profile default** (`agentDefaultModel.saveSelection`). Our catalog lists no model rows, so they cannot pick our provider; our own pickers live in `conversation.input.left` and call `agent.model.select` (session only) plus `setModel`.
- **Single DSH slots** (`conversation.input.model`, `conversation.input.permission`) cannot be replaced per session. To hide the permission seat in our sessions only, mark the ancestor that holds `[data-slot="conversation.input.permission"]`. The seat wrapper is `display: contents`, so a visibility probe must look at its children.
- **DSH `/permission`** changes only DSH's approval policy, which Claude ignores. Our preset registers its own `/permission` (shows or switches the Claude mode). DSH's client still opens its preset popup from a decoration keyed by name, so our client marks that decoration unavailable in our sessions. This reads a DSH client internal (`commandUi.live.decorations`); re-check it on every DSH upgrade. DSH shows no command result in the chat, so we show the answer in our status line.
- **A mode set before the CLI reports one** (for example plan picked before the first message) produces a `status` frame before `init`. Seed the process start mode first (start option, else the settings `defaultMode`, else `default`), or the plan card loses "use auto mode".
- **The mode choice persists in the binding** (`source.rawAgent.mode`, written only after a user choice) and is restored after a DSH restart. Restore only the session's own binding, so a DSH fork starts in the settings mode.
- **Stop answers only main-thread permission, question and plan asks** (with the CLI's Esc answer). Never answer a child ask or an elicitation on Stop, and never answer an ask on a timer.
- **DSH's `approval/decided` has no "always" outcome.** Record "always" as `allowed-once`; the rule itself is in the CLI's settings write.
- **The choice route's answer is built before the CLI's `status` frame**, so do not trust its `live.mode`; the picker can lag one poll (4 s) after a mode switch (known, not fixed).
- **Workspace trust:** in SDK mode without `workspaceTrust` the CLI ignores the project's `permissions` rules (hooks, env and CLAUDE.md still apply). Ask the TUI's trust question first and pass `workspaceTrust` only after the user accepts; the CLI writes its own trust record.
- **SDK import side effect:** SDK 0.3.318 sets `NoDefaultCurrentDirectoryInExePath=1` in `process.env` at import, on every OS. Load the SDK lazily and restore the env (D7).
- **DSH terminal tab** (`sidebarRight.openTabIn(session, 'terminal')`) opens only in the session folder; it cannot start in another folder.
- **Track an input only after its SDK message is built.** A send that throws after `tracker.sent()` leaves a pending id, and every later turn end then waits for it forever.

## 5. Development workflow

- **Never** install into, restart or edit the maintainer's daily DSH profile. For live tests use an isolated home: `DSH_HOME=<repo>/.dsh-dev` (git-ignored) and a throwaway profile on its own port, started from a clean env (`env -i HOME=… PATH=… USER=… LANG=…`).
- **Live UI checks** use headless Chromium (Playwright) against the DSH web UI. Read evidence from the DSH session log (`zstd -dc <DSH_HOME>/sessions/*/<id>/session.v4.jsonl.zstd`) and from Claude's transcript (`~/.claude/projects/<cwd-slug>/<id>.jsonl`; its `prompt_snapshot` attachment shows the real system prompt).
- **Keep live tests cheap:** pick an explicit small model for test sessions, and use test-only env overrides (for example `ANTHROPIC_DEFAULT_HAIKU_MODEL`). Never change the user's settings to save cost.
- **Commits:** small and focused, one milestone or fix per commit, imperative subject lines. Never commit `research/`, `.dsh-dev/`, secrets, model ARNs, account ids or machine-specific paths.
- **Docs:** plain, simple English, with short sentences. Mark anything inferred but not verified as **unverified**.

## 6. Repo layout (from docs/architecture.md §8; update when it changes)

```
CLAUDE.md                 this file (single source of truth)
AGENTS.md                 pointer to CLAUDE.md
docs/requirements.md      requirement list with acceptance checks and a status column
docs/architecture.md      design decisions (D-numbers), event mapping, backend interface
docs/research/            public research notes (no local paths or ids)
packages/core/            backend interface, event union, shared pure logic
packages/backend-claude/  the ONLY package that imports the Claude Agent SDK
packages/dsh-host/        Host half: preset driver + guard, native event writer, children, jobs,
                          interaction channel, routes, services. DSH touch points only in src/port/
packages/dsh-client/      browser half (TSX). DSH touch points only in src/port/
packages/views-claude/    Claude tool views
packages/testkit/         stub backend, fake CLI, recorded fixtures, in-process DSH loop harness
packages/plugin/          the one published bundle (dsh-raw-agent) and composition root
examples/sample-restyle/  sample plugin that restyles our UI through our services
scripts/                  check-imports.mjs, bundle.mjs, live/ (isolated DSH setup, Playwright)
research/                 local only, git-ignored evaluation material
```

Import rule: `dsh-host` and `dsh-client` import only `core`. Only `backend-claude` imports the SDK. Only `plugin/` imports `backend-claude`. No runtime import of `@deepseek-ai/*` (types only). `scripts/check-imports.mjs` enforces it.

## 7. Commands

Toolchain: TypeScript 5 (strict, ESM), pnpm 11 workspace, `tsc -b` + esbuild, Vitest, Playwright (`playwright-core` + Chromium), ESLint + Prettier. Full list: docs/architecture.md §9.

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm build          # types + bundles into packages/plugin/lib
pnpm test           # unit + fake-CLI contract + DSH round-trip tests
pnpm lint           # eslint, prettier --check, import check
pnpm typecheck
pnpm --filter dsh-raw-agent pack --pack-destination dist/
pnpm live           # Playwright suites against the isolated DSH on port 8790 (see §5)
pnpm test:cli-constants  # check our env lists and reject texts against the installed claude binary
```

- **Push:** this machine's git has no credential helper. Push with
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`.
- **Ignore rules** are anchored (`/research/`, `/.dsh-dev/`) so that `docs/research/` is tracked.
- **Bypass in live tests:** `bypassPermissions` needs the plugin option `allowDangerouslySkipPermissions: true` (in the dev profile's `cordis.patch.yml`, row `raw-agent`, `config.options`). Restore the patch afterwards.
- **Live MCP elicitation tests:** a scratch stdio MCP server times out its request after 60 s, so drive the card quickly.
- **Workflow agents:** a single agent cannot rewrite a very large file (100 KB+) in one write; it silently fails. Ask for targeted edits and a grep check afterwards.
