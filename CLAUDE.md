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

## 5. Development workflow

- **Never** install into, restart or edit the maintainer's daily DSH profile. For live tests use an isolated home: `DSH_HOME=<repo>/.dsh-dev` (git-ignored) and a throwaway profile on its own port, started from a clean env (`env -i HOME=… PATH=… USER=… LANG=…`).
- **Live UI checks** use headless Chromium (Playwright) against the DSH web UI. Read evidence from the DSH session log (`zstd -dc <DSH_HOME>/sessions/*/<id>/session.v4.jsonl.zstd`) and from Claude's transcript (`~/.claude/projects/<cwd-slug>/<id>.jsonl`; its `prompt_snapshot` attachment shows the real system prompt).
- **Keep live tests cheap:** pick an explicit small model for test sessions, and use test-only env overrides (for example `ANTHROPIC_DEFAULT_HAIKU_MODEL`). Never change the user's settings to save cost.
- **Commits:** small and focused, one milestone or fix per commit, imperative subject lines. Never commit `research/`, `.dsh-dev/`, secrets, model ARNs, account ids or machine-specific paths.
- **Docs:** plain, simple English, with short sentences. Mark anything inferred but not verified as **unverified**.

## 6. Repo layout (planned; update when it changes)

```
CLAUDE.md            this file (single source of truth)
AGENTS.md            pointer to CLAUDE.md
docs/requirements.md requirement list with acceptance checks
docs/architecture.md decisions (created in the design phase)
docs/research/       public research notes (no local paths or ids)
packages/            plugin source (layout decided in the design phase)
research/            local only, git-ignored evaluation material
```

## 7. Commands

To be filled in when the toolchain is chosen (build, test, lint, live test).
