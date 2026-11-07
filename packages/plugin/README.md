# dsh-raw-agent

A [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that runs **your own, unmodified
Claude Code CLI** as the agent of a DSH session. DSH gives the interface and its plugin system. Claude Code does the work,
with your settings, exactly as in the terminal.

> Status: pre-release (0.1.0). Tested on DSH 0.2.2-rc.1 and Claude Code 2.1.318 on Linux. macOS and Windows run in CI
> only.

## Requirements

- DSH in the range of `engines.dsh` in `package.json` (now `>=0.2.2-rc.1 <0.3.0-0`).
- Node.js 24.9 or newer (the same as DSH).
- Your own Claude Code (`claude`), signed in. Any account type works: subscription, API key, Bedrock or Vertex.

## Install

DSH installs plugins into a profile. Pick the profile you use (for example `web`):

```sh
dsh plugin --profile web add dsh-raw-agent
```

Until the package is on npm, add a packed tarball instead (`dsh plugin --profile web add /absolute/path/to/dsh-raw-agent-0.1.0.tgz`).
The [project README](https://github.com/wannaFlyKa/dsh-raw-agent#install) shows how to pack it from source, and the
first-run steps (folder dialog, starting Claude Code from the model picker, the trust question).

Restart DSH, start a new session, and pick the **Claude Code** agent preset. To remove the plugin:

```sh
dsh plugin --profile web remove dsh-raw-agent
```

Removing or upgrading the plugin ends every running Claude Code process of that profile, with its background tasks, as
quitting the terminal app does.

## Which `claude` runs

The plugin always runs your own `claude`: the path you set in the plugin config (`executablePath`), else the first
`claude` on `PATH`, else `~/.local/bin/claude` (on Windows also `claude.exe`). It always passes that path to the Claude
Agent SDK, so the SDK never looks for, and never runs, a CLI of its own.

The plugin config is the `config` of the row `raw-agent` in your profile's `cordis.patch.yml`:

```yaml
- id: raw-agent
  name: 'dsh-raw-agent'
  config:
    executablePath: /opt/claude/bin/claude # optional
    options:
      allowDangerouslySkipPermissions: true # optional: offers the bypassPermissions mode
```

## Settings quick access

The plugin **never writes** your Claude Code settings files. The **Settings files** button in the composer row of a
Claude Code session lists `~/.claude/settings.json`, `<project>/.claude/settings.json` and
`<project>/.claude/settings.local.json` read-only. Values under `env` are masked until you click them. Each key shows which
file set it. Edit the files with your own editor: **Open in terminal** opens a DSH terminal and copies a `cd` command to
the file's folder.

Two writes come from Claude Code itself, as in the terminal app: an "always allow" answer writes the permission rule, and
the MCP panel's on/off switch writes `disabledMcpServers` in `~/.claude.json`.

## Optional: drop the SDK platform package

The plugin talks to your `claude` through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). That SDK lists eight
platform packages (`@anthropic-ai/claude-agent-sdk-<platform>`, about 230-330 MB each, each with a bundled CLI) as
`optionalDependencies`, so your package manager installs the one for your machine. The plugin **never runs it**. It only
costs disk space. The plugin cannot prevent the install: npm and pnpm read `overrides` only from the root project, and the
SDK's licence does not allow bundling it into this MIT package.

To drop it, add this block to your profile's `pnpm-workspace.yaml` (`$DSH_HOME/profiles/<profile>/`, `DSH_HOME` is
`~/.dsh` by default; merge it with an existing `overrides:` key) and add the plugin again:

```yaml
overrides:
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-linux-x64': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-linux-arm64': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-linux-x64-musl': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-linux-arm64-musl': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-darwin-x64': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-darwin-arm64': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-win32-x64': '-'
  '@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-win32-arm64': '-'
```

## What works as in the terminal app

- Your settings, CLAUDE.md, memory, skills, plugins, hooks, MCP servers, agents and output styles.
- The `claude_code` system prompt with **nothing appended**. Only text you type or attach reaches the model.
- No forced tools, flags, model, effort or mode. Your settings decide the defaults. A choice in the composer row applies to
  this session only.
- Every permission mode (default, acceptEdits, plan, auto, dontAsk, bypassPermissions), approvals with the CLI's own "always
  allow" suggestions, plan approval, questions (AskUserQuestion) and MCP forms.
- Stop interrupts the turn only. Background agents, workflows and shells keep running, show as DSH jobs, and never hold the
  session.
- Steer and queue during a turn, images and file attachments, resume after a DSH restart, fork, rewind (with file
  restore), and crash reports.
- Subagents (as DSH child sessions), agent teams, dynamic workflows and ultracode.
- The CLI's own `/` commands (built-ins, skills, plugin and MCP commands), `/btw` side questions, the MCP panel.
- Usage as the CLI reports it: per-turn tokens with cache read and write, cost, per-model usage, the context window, and
  plan limits for subscription accounts.
- Sessions are native DSH sessions: DSH export, search, fork and other plugins work with them.

## What is not supported (or differs)

- **Workflow controls:** you can stop a whole workflow run. Stopping one workflow agent, pause, skip and retry are
  terminal-app only (the SDK has no control for them).
- **Agent teams:** you cannot message a teammate from the UI (the CLI has no control for it).
- **Branch after Stop:** DSH offers no Branch button on a stopped turn. Use **Rewind** in the composer row.
- **DSH's own model seat and `/model`** change the profile default, not this session. Use the pickers in the composer row.
- **DSH's token meter** counts the main thread only. Our context pill and usage panel also count subagents, so the totals
  differ.
- **`/btw` answers** carry no usage numbers (the CLI sends none).
- **The mode picker** can lag up to 4 seconds after you pick a mode on a plan card.
- **DSH's terminal tab** opens in the session folder only.
- **Attached file names** that contain both a space and a `"` do not reach Claude Code (DSH stores `"` as `_`).
- **No `!` shell mode.** A line that starts with `!` goes to the model as text (SDK mode has no shell mode), so the model
  may run Bash for it, with a permission ask in default mode. Use DSH's terminal tab for a direct shell.
- **`/rename`** renames the Claude Code session, but the DSH session title stays as it was.
- **A model picked before the first message** is applied with `setModel` right after the start, so Claude Code builds the
  system prompt for your settings model, not for the picked one (rule: no forced model at start).
- **Live-tested only on Linux with Bedrock auth.** Subscription plan limits (unit tests only), API key and Vertex auth
  (not tested), macOS and Windows (CI tests only) have had no live run.
- **Claude Agent SDK 0.3.318 exactly.** The plugin uses SDK controls that the SDK types do not declare, so the version is
  pinned to the one the live checks ran on.

## Privacy

No telemetry. The plugin sends nothing anywhere. The only network traffic is your own Claude Code's. The plugin's HTTP
routes are DSH routes: they use DSH's own sign-in and trusted-host checks, and none of them serves a file you name. Behind a reverse proxy, start DSH with both `--public-url` and a matching `--trusted-host`.

## For plugin authors

Other DSH plugins can restyle this plugin's UI and use its services: Host `rawAgent` and Client `rawAgentClient` (API
version 1). Sending text to Claude Code without a keypress needs a grant the user creates in **Agent plugin access**. The
types ship with this package; use them with `import type`:

```ts
import type { RawAgentClientService } from 'dsh-raw-agent/api';
```

The reference is [docs/plugin-api.md](https://github.com/wannaFlyKa/dsh-raw-agent/blob/main/docs/plugin-api.md). A working
example is
[examples/sample-restyle](https://github.com/wannaFlyKa/dsh-raw-agent/tree/main/examples/sample-restyle).

## Licence

MIT (see `LICENSE`). Claude Code and the Claude Agent SDK are Anthropic products under their own terms. This project is not
made or endorsed by Anthropic or DeepSeek.
