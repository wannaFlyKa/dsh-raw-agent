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
- **Side chat tab (0.1.2, D89):** our `/btw` view is a right-sidebar page type (`ctx.sidebarRightTabs.register`, body in the keyed `sidebar.right.pane.tab` seat under the type id, opened with `ctx.sidebarRight.openTabIn`). DSH keeps one sidebar layout per session in localStorage, so each session has its own tab, and a restored layout reopens it. No guide entry (the guide is shared by every session). Re-check the registry and `openTabIn` on a DSH upgrade; without them the inline box is used.
- **A Cordis plugin body must not return a value.** `ctx.inject(deps, (scope) => fn())` where `fn` returns `true` fails with "Invalid effect" and disposes the scope at once, with no console message: the side chat tab registered, then vanished on most page loads. Use a block body. Allowed returns: nothing, a function, a promise or an iterable.
- **`keepMounted` tab bodies stay in the DOM** (hidden) for other sessions. Live drivers must select the visible one (`[data-raw-agent="side-chat"]:visible`).
- **Workflows:** the CLI sends `workflow_progress` (phases and agents) on `system/task_progress`. It is not in the public SDK types.
- **`interrupt()`** spares background tasks only when `perTaskStopAffordance: true` is set at start. Never dispose the process on Stop.
- **Model aliases:** with `enforceAvailableModels`, the `haiku`, `sonnet` and `default` aliases can resolve to the user's default model. Never assume an alias is cheap.
- **Sandboxing:** inside a DSH file sandbox, Claude Code can fail with `EROFS` on `~/.claude/session-env`. Spawn the CLI from a process that can write to `~/.claude`.
- **Host session variables:** a DSH started from inside a Claude Code session inherits `CLAUDE*` variables (see rule 5).
- **DSH's model seat and `/model` save the profile default** (`agentDefaultModel.saveSelection`). Our catalog lists no model rows, so they cannot pick our provider; our own pickers live in `conversation.input.left` and call `agent.model.select` (session only) plus `setModel`. In our sessions DSH's `/model` contribution is wrapped (`commandUi.live.contributions.get`, a DSH internal: re-check on every DSH upgrade) into an action that opens our picker.
- **Single DSH slots** (`conversation.input.model`, `conversation.input.permission`) cannot be replaced per session. To hide the permission seat in our sessions only, mark the ancestor that holds `[data-slot="conversation.input.permission"]`. The seat wrapper is `display: contents`, so a visibility probe must look at its children.
- **The seat in a new session (0.1.1):** our route answers 404 until DSH has rebound the new session to our preset, and the 404 retry delay grows to 20 s, so DSH's access seat (with "Full access") stayed after "Claude Code" was picked. The controls read DSH's `agentPreset` projection (the session slot's standard `useProjection` prop; our ids start with `raw-agent-`): they hide the seat at once and read the route again (`store.notePreset`). Re-check the projection key on every DSH upgrade.
- **DSH `/permission`** changes only DSH's approval policy, which Claude ignores. Our preset registers its own `/permission` (shows or switches the Claude mode; a DSH preset name such as `danger-full-access` gets a plain answer and changes nothing). DSH's client opens its preset popup from a decoration keyed by name; in our sessions our client hands back that decoration with our own popup of the Claude modes (0.1.1; `available` and `ui` are read on one object, so each read gets a fresh wrapper). This reads a DSH client internal (`commandUi.live.decorations`); re-check it on every DSH upgrade. DSH shows no command result in the chat, so we show the answer in our status line (notice `topic: 'mode'`, no name prefix).
- **DSH's access row in Settings > General** is `settings.general.item` id `permission`, order -20 (`dsh-client-ui-permission-presets`). Our note sits at order -19 (a public slot; re-check the id and order on a DSH upgrade).
- **DSH theme tokens** (0.2.2-rc.1): `--dsw-alias-label-primary|secondary|tertiary`, `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-1`, `--dsw-alias-interactive-bg-hover`, `--dsw-alias-state-{business,warn,error,success,done}-primary`, `--dsw-radius-sm`; dark theme is `body[data-ds-dark-theme]`. DSH's composer pill style is in `dsh-client-ui-chat` (StatsPills). The `--dsw-alias-text-*`/`surface-*` names 0.1.0 used do not exist.
- **Chips over a native `<select>`:** each picker chip has an invisible `<select>` on top, so `showPicker`, the list and the keyboard stay native. Timer functions passed as object methods throw "Illegal invocation" in a browser (`{set: setTimeout}`); wrap them (`FADE_TIMERS`). Node tests do not catch it unless they stub a strict `setTimeout`.
- **No brand names in dsh-client or dsh-host code** (D80, `check-imports`): the model-name shortener is generic (last word + version numbers), and Claude-only texts (for example the CLI flag a mode needs) come from the backend (`PermissionModeInfo.requiresNote`, `shortLabel`, `risk`).
- **A mode set before the CLI reports one** (for example plan picked before the first message) produces a `status` frame before `init`. Seed the process start mode first (start option, else the settings `defaultMode`, else `default`), or the plan card loses "use auto mode".
- **The mode choice persists in the binding** (`source.rawAgent.mode`, written only after a user choice) and is restored after a DSH restart. Restore only the session's own binding, so a DSH fork starts in the settings mode.
- **Stop answers only main-thread permission, question and plan asks** (with the CLI's Esc answer). Never answer a child ask or an elicitation on Stop, and never answer an ask on a timer.
- **DSH's `approval/decided` has no "always" outcome.** Record "always" as `allowed-once`; the rule itself is in the CLI's settings write.
- **The choice route's answer is built before the CLI's `status` frame**, so do not trust its `live.mode`; the picker can lag one poll (4 s) after a mode switch (known, not fixed).
- **Workspace trust:** in SDK mode without `workspaceTrust` the CLI ignores the project's `permissions` rules (hooks, env and CLAUDE.md still apply). Ask the TUI's trust question first and pass `workspaceTrust` only after the user accepts; the CLI writes its own trust record.
- **SDK version is pinned exactly** (`0.3.318`, D11). A caret range let packed installs take 0.3.319, which our undeclared-control use (D9) was never checked on. Bump it only with a live re-check.
- **The user's `DSH_*` variables pass through**, secrets included (rule 5). Do not add a `DSH_*` secret filter back.
- **Effort picker:** shows the CLI's own `getSettings().applied.effort` (read after each choice and each turn end), never the settings file's level as fact.
- **Transcript-only entries** (`queueTranscriptOnly: true`, for example the task notification the CLI writes after a wake reply) were already taken in by a turn the session showed; the crash/restart read-back skips them.
- **DSH speed figures:** a step with a decode window under 500 ms gets no timing (`MIN_TIMED_DECODE_MS`); Bedrock streams in bursts, so short answers read too fast. Tool-call input also comes in bursts (tool-heavy steps read 196-354 tok/s; text: 80-117), so a message whose tool-call argument text is longer than its text and thinking gets no timing either (`mostlyToolInput`, writer.ts). Usage stays exact; such steps also lose their TTFT (DSH reads both from one stream). Live tool-turn checks expect DSH's speed to come from text steps only.
- **Thinking in SDK mode:** CLI 2.1.318 sends empty, signed thinking blocks unless a thinking display is set explicitly; it does not read the user's `showThinkingSummaries` outside the TUI. Live thinking text was never seen; do not read its absence as our bug.
- **Hook notices** (`system/informational`, for example a UserPromptSubmit block) reach only our transient status line; the next notice replaces them, and a blocked prompt is not put back in the composer (known gap).
- **`/` menu substring match:** Enter takes the first row, so `/bug` becomes `/debug`, `/review` becomes `/code-review`, `/skills` becomes `/reload-skills` (visible; needs a second Enter). Live drivers that type a TUI-only command must expect this.
- **No title read:** D32 (`sessionTitle`) is not wired, so DSH keeps its own fallback title and `/rename` does not reach it.
- **SDK import side effect:** SDK 0.3.318 sets `NoDefaultCurrentDirectoryInExePath=1` in `process.env` at import, on every OS. Load the SDK lazily and restore the env (D7).
- **DSH terminal tab** (`sidebarRight.openTabIn(session, 'terminal')`) opens only in the session folder; it cannot start in another folder.
- **DSH composer chain order:** DSH tries `conversation.composer` entries in ascending priority. ui-subagent's read-only child composer is at -10, so our child ask composer must sit below it (-20) and match only our own kind.
- **Child asks:** a child session has its own (empty) client store. Keep asks published on a child in a separate map, or the child's store removes the parent's publication on every poll.
- **Child usage numbers:** the last `task_progress` comes early. Use the `task_notification`'s final `usage`, and never show a finished child's run time below its wall time.
- **SIGKILL of DSH leaves the CLI running** while a background task runs (it re-parents to pid 1 and may run one wake turn by itself). A normal stop or restart is clean. Handled by the D75 orphan guard (one `node -e` watcher per CLI); live, no CLI is left about 3 s after the kill.
- **Our lifecycle banner lives in `conversation.input.dock`** (the card stack above the composer). The `conversation.composer.dock` row below it is one non-wrapping flex line: a wide entry there squeezes DSH's usage pills.
- **DSH's job-list Stop needs two presses** (arm, then confirm). A live driver that presses once only arms it.
- **Track an input only after its SDK message is built.** A send that throws after `tracker.sent()` leaves a pending id, and every later turn end then waits for it forever.
- **Workflow transcripts:** the Workflow launch result names `<session>/subagents/workflows/wf_…` before the CLI creates that folder. Keep the folder pending and check it again at each read; never give up after one failed check.
- **Workflow agent end:** the CLI marks an agent done about 60 ms before it writes the agent's last transcript line. Keep reading a settled agent for a short grace period, or text-only agents end empty.
- **Stopped workflow agents** come as `error` with the CLI's text "Stopped because the workflow was stopped". Show them as stopped, not failed. On a crash (run stop reason `error`), running agents settle as `error`.
- **Workflow controls:** the SDK can stop only the whole run (`stopTask(runTaskId)`). `stopTask(agentId)` is a silent no-op, and pause, skip and retry are TUI-only. Do not offer them (D48).
- **Ultracode** is a session toggle, not an effort level: the TUI and our picker send `apply_flag_settings {ultracode: true}` only. A level pick sends `{effortLevel, ultracode: false}` (as the TUI does over the control transport); `{effortLevel}` alone left ultracode on when the level did not change. The typed keyword works only on user frames with `origin: {kind: 'human'}`.
- **Local command results** (`/compact`, `/clear`, `/context`) come with `num_turns: 0` and empty text. One that answers our input must still end the DSH turn, or every later message queues. They also say `duration_api_ms: 0`, but the next real result is the running total again: do not treat that 0 as a counter restart.
- **`/clear` new id:** take the conversation id from the next frame's `session_id`, not from `conversation_reset.new_conversation_id`.
- **Usage panel re-reads:** never key a re-read on a summary's `at` stamp; each route read re-stamps it, which loops the usage control.
- **DSH's `/` menu keeps a source's row order, and Enter picks the first row.** Our command source ranks an exact name or alias first for a typed query; the CLI lists `autocompact` before `compact`, so without the rank `/compact` + Enter sent `/autocompact`. Live drivers that type a command and press Enter go through this pick.
- **DSH's token meter** counts the main thread only and is not reset by `/clear`; our pill and panel include child tokens. The two totals differ by design (D68).
- **MCP toggle:** the CLI's `mcp_toggle` writes `disabledMcpServers` in `~/.claude.json` itself, as the TUI's `/mcp` does. That is the CLI's write, not ours; tell the user.
- **`/btw` answers carry no usage** (`side_question` replies have only `response` and `synthetic`), so a warm cache cannot be measured from the reply.
- **CLI 2.1.318 has no Grep, Glob or TodoWrite tool** in `init.tools`. Their views can be checked only by unit tests.
- **`/compact` output and `/clear`** come as a CLI user frame with no assistant message, so our markers anchor on the user's typed command message (D70).
- **`/clear` has no step**, so no binding holds the new conversation id. A resume after a restart must look it up with `sessionHoldingInput` (D28); the CLI writes the new transcript at once.
- **`resumeDropsTurn` refusal** comes as a boot `result error_during_execution`. The plain-cut restart needs its own `AbortController` (closing the refused query aborts the old one) and must get the session's model, effort and mode choices again, or it runs on the settings model (D29).
- **The real `rewind_files` answer** (CLI 2.1.318) is only `{canRewind, skippedLinks}`. Run a dry run first to get the file list and line counts (D30). A forked process can restore the source's checkpoints.
- **DSH offers no Branch button on an aborted (stopped) turn.** A fork right after a Stop goes through our rewind dialog.
- **Plugin messages (D66):** a granted plugin message has `source.kind: 'raw-agent-plugin'` and is forwarded only when the Host service admitted its id in the registry (`admitPluginMessage`). Never widen the `'user'` checks to the plugin kind without that admission check. An admission is used once (the pre-step claim or the steer claim consumes it), is void once its grant is revoked (`setPluginGrantCheck`), and is dropped when DSH refuses the message. Grants are stored as hashes in a DSH storage domain (`raw_agent_grants`, `ctx.storageDomain`, per-record json files under `<DSH home>/storages`), so they survive a DSH restart (D88, live). The spec is plain data with duck-typed `parse`/`safeParse` schemas; never import `defineDomain` or zod (D65). Old Host entry config `grants` are taken in once (the `imported` table keeps their hashes). Without the service, grants fall back to the entry config for one DSH run (DSH 0.2.2-rc.1 does not save our config write for a bundle row; `durable: false`, panel says so). The entry's own `internal/update` hook still takes a change of `grants`, `executablePath` or `options` without a remount (D87, live: same pid). Grants are shared by every profile of one DSH home.
- **`--public-url` alone gives 403** on every API route (DSH's own trusted-host gate, ours and DSH's). Behind a proxy, also pass a matching `--trusted-host`.
- **Plugin text reaches the CLI as `origin: {kind: 'human'}`** (same input path as typed text). The model cannot tell it from typed text; only the DSH log does (`source.kind`).
- **DSH 0.2.2-rc.1 stores attached files with `"` replaced by `_`**, so a path with both a space and a `"` does not reach us from the UI (the unit test still covers it).

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
docs/status.md            public status summary: per-row status and live evidence, raw-contract rules, TUI gaps, open questions
docs/architecture.md      design decisions (D-numbers), event mapping, backend interface
docs/plugin-api.md        public services (rawAgent, rawAgentClient), grants, restyle points (R9.1, R9.2)
docs/research/            public research notes (no local paths or ids)
packages/core/            backend interface, event union, shared pure logic
packages/backend-claude/  the ONLY package that imports the Claude Agent SDK
packages/dsh-host/        Host half: preset driver + guard, native event writer, children, jobs,
                          interaction channel, routes, services. DSH touch points only in src/port/
packages/dsh-client/      browser half (TSX). DSH touch points only in src/port/
packages/views-claude/    Claude tool views
packages/testkit/         stub backend, fake CLI, recorded fixtures, in-process DSH loop harness
packages/plugin/          the one published bundle (dsh-raw-agent) and composition root
examples/sample-restyle/  sample plugin (plain JS, module-loader format): shadows the context pill, fills
                          raw-agent.controls.extra, calls every rawAgentClient method
.github/workflows/ci.yml  CI: ubuntu/macos/windows test job, nightly dsh-next job
.github/workflows/release.yml  on a v* tag: full check, pack, GitHub Release with the tarball
scripts/                  check-imports.mjs, bundle.mjs, client-bundle.mjs, api-types.mjs, check-pack.mjs, clean.mjs,
                          test-cli-constants.mjs (live Playwright drivers are local only, under research/)
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
pnpm --filter dsh-raw-agent pack --pack-destination dist/   # pnpm 11: writes dist/ at the repo root
pnpm check-pack     # after pnpm build: pack and compare the exact tarball file list
pnpm test:cli-constants  # check our env lists and reject texts against the installed claude binary
```

- **Published files:** the tarball list is fixed in `scripts/check-pack.mjs` (no source maps, no `lib/types`). Adding a shipped file means updating `files` in `packages/plugin/package.json` and that list. `lib/api.d.ts` is generated from `core/src/plugin-api.ts`, which must keep importing nothing.
- **In-process DSH tests** (round trips, `route-security`) load DSH from `DSH_PKG` or a `dsh` on `PATH`; CI sets `DSH_PKG` to the global install's `@deepseek-ai/dsh/node_modules`. Without DSH they skip.
- **Live checks:** there is no `pnpm live` script. The Playwright drivers are local (git-ignored `research/`) and run
  against the isolated DSH on port 8790 (see §5).
- **Cut a release:** bump `version` in `packages/plugin/package.json` (and `CHANGELOG.md`, and the version in the README
  install URLs), commit, push `main` and wait for CI green. Then `git tag vX.Y.Z` and push the tag the same way as `main`
  (`... push origin vX.Y.Z`). `release.yml` checks that the tag matches the package version, runs the full check and
  attaches `dsh-raw-agent-X.Y.Z.tgz` to the GitHub Release. npm publishing is planned later. A failed release: delete
  the release and the tag (`gh release delete vX.Y.Z --cleanup-tag`, `git tag -d vX.Y.Z`), fix, tag again.
- **Push:** this machine's git has no credential helper. Push with
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`.
- **Ignore rules** are anchored (`/research/`, `/.dsh-dev/`) so that `docs/research/` is tracked.
- **Bypass in live tests:** `bypassPermissions` needs the plugin option `allowDangerouslySkipPermissions: true` (in the dev profile's `cordis.patch.yml`, row `raw-agent`, `config.options`). Restore the patch afterwards.
- **Live MCP elicitation tests:** a scratch stdio MCP server times out its request after 60 s, so drive the card quickly.
- **Live job tests:** set `DSH_RAW_AGENT_TEST_JOB_WAIT_MS=20000` on the test DSH process to shorten job waits (default 1 h), so a task can outlive a wait. Test only; never set it for users.
- **Live team tests:** set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` on the test DSH process only (the plugin never sets it).
- **Live ultracode frame checks:** point the dev profile's `raw-agent.config.executablePath` at a small wrapper that `tee`s stdin to a file and `exec`s the real `claude`. Restore `cordis.patch.yml` afterwards.
- **Live workflow approval:** a Workflow launch asks permission only outside `auto`/bypass modes. Test it in `default` mode.
- **Live usage checks:** a wrapper that `tee`s the CLI's stdout (same `executablePath` trick) captures its `result`, `rate_limit_event` and `compact_boundary` frames for comparison with our panel. This machine has only Bedrock auth; subscription limits are unit-tested only.
- **Live command checks:** set `executablePath` to a `tee` wrapper and compare the CLI's stdin lines with what was typed; a menu open on Enter replaces the line with the picked row (for example `/cost` becomes `/usage`).
- **Live rewind refusal test:** a `tee` wrapper (`executablePath`) that replaces the `--resume-drops-turn` value with a bogus id once forces the CLI's refusal. Restore `cordis.patch.yml` afterwards.
- **Live crash test:** Sonnet refuses a foreground `sleep 30` (it offers the background); ask for `python3 -c "import time; time.sleep(40)"` and watch for it under the CLI. Match the test CLI by binary and cwd before `kill -9` (other `claude` processes run on this machine, and a `pgrep -f` can match the driver's own command line).
- **Re-adding a rebuilt tarball** of the same version (`dsh plugin add <tgz>` again) exits 0 but keeps the old `lib/` (the lockfile's old integrity wins). Run `dsh plugin remove` first, then `add`, and check the installed `lib/` before a live check.
- **A new profile name from `dsh plugin add`** gets only `@deepseek-ai/dsh-base` (no web app: `dsh --profile <name>`
  never listens, and our preset waits for `agentPresets`). Make a throwaway profile with
  `dsh --profile <name> --from-default-profile web --dump-config` first, then `dsh plugin ... add`.
- **The release URL install** (`dsh plugin add <release .tgz URL>`) was checked live in a fresh web-template profile:
  with the README `overrides` block, `node_modules` is 6.3 MB (329 MB without) and the installed files equal the asset.
- **Copying `.dsh-dev` for a parallel test:** its `node_modules/dsh-raw-agent` is a relative `link:` symlink; re-point it to the repo in the copy.
- **Clean env and Bedrock:** an `env -i` test DSH must keep the user's `AWS_EC2_METADATA_DISABLED` and the PATH entry of their AWS credential helper. Without them the CLI falls back to the instance role (403 on every model) or finds no credentials, and every turn fails.
- **Fresh profile drivers:** a profile with no workspace opens DSH's folder dialog first; before the first message our model picker shows only "Start Claude Code to list models", and the start asks the trust question.
- **Windows tests:** the code joins paths with the OS separator, so a test file seam must compare with `path.join(...)` (or normalise `\` to `/` for recorded POSIX fixture paths), never a hard-coded `/a/b` string. CI run 1 failed 8 tests on Windows for this reason only.
- **Live grant checks:** after a DSH restart the plugin routes answer `not-our-session` until the session is opened in the UI (DSH mounts its agent then). The stored grants are under `<DSH_HOME>/storages/raw_agent_grants/grants/` (one json file per grant, hash only).
- **Workflow agents:** a single agent cannot rewrite a very large file (100 KB+) in one write; it silently fails. Ask for targeted edits and a grep check afterwards.
