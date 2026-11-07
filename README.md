# dsh-raw-agent

Run your **own, unmodified Claude Code** inside [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh), and use DSH plugins to change how everything looks and behaves.

> **Status: 0.1.0, pre-release.** It works for daily use on Linux (tested live on DSH 0.2.2-rc.1 with Claude Code
> 2.1.318). macOS and Windows run in CI only. The package is **not on npm yet**: install it from a packed tarball or from
> source (below). The full user guide is [packages/plugin/README.md](packages/plugin/README.md).

## Why

You already know Claude Code, and your setup is tuned: settings, skills, MCP servers, plugins, hooks and agents. DSH has a plugin system that lets you reshape the whole interface. This project joins the two **without changing Claude Code**:

- **Your binary and your settings.** It runs your own `claude` with your user, project and local settings. The plugin never edits your settings; it gives you one-click access to open `settings.json` yourself.
- **Nothing hidden.** No extra system-prompt text, no hidden prompts, no forced flags. What you type is what Claude sees.
- **Every Claude Code feature.** Subagents, agent teams, dynamic workflows, every permission mode (default, accept edits, plan, auto, don't ask, bypass), MCP, skills, slash commands, `/btw`, plan mode, questions, resume, fork, rewind.
- **Honest usage.** Tokens, cache, cost, context window and plan limits, whether you use a subscription, an API key, Bedrock or Vertex.
- **Native DSH sessions.** Turns and tool calls live in the DSH session log, so DSH features and other plugins work with them.
- **More CLIs later.** Codex and ACP agents, behind the same interface.

See [docs/requirements.md](docs/requirements.md) for the full list.

## Install

You need DSH `>=0.2.2-rc.1 <0.3.0-0`, Node.js 24.9 or newer, pnpm (through `corepack enable`), and your own `claude`,
signed in. Use a profile name of your choice in place of `<profile>` (for example `web`).

### From a packed tarball

If someone gave you `dsh-raw-agent-<version>.tgz` (or you packed it yourself, see the next section):

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-raw-agent-0.1.0.tgz
```

Pass an absolute path. Restart DSH after the add.

### From source

```sh
git clone https://github.com/wannaFlyKa/dsh-raw-agent.git
cd dsh-raw-agent
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter dsh-raw-agent pack --pack-destination dist/
dsh plugin --profile <profile> add "$PWD/packages/plugin/dist/dsh-raw-agent-0.1.0.tgz"
```

`pnpm --filter` runs in the package folder, so the tarball lands in `packages/plugin/dist/`. Restart DSH after the add.
To remove the plugin: `dsh plugin --profile <profile> remove dsh-raw-agent`. Removing or upgrading it ends every running
Claude Code process of that profile, as quitting the terminal app does.

When the package is on npm, `dsh plugin --profile <profile> add dsh-raw-agent` will do the same.

### First run

1. Open DSH. A profile with no workspace first shows DSH's **folder dialog**. Pick the project folder.
2. Start a new session and pick the **Claude Code** agent preset.
3. The model picker in the composer row shows only **Start Claude Code to list models** until the process runs. Pick
   that row (or just send your first message) to start your `claude`. Then the picker lists your models.
4. In a folder you have not trusted yet, the plugin asks Claude Code's own **trust question** first, as the terminal app
   does. Until you accept, Claude Code ignores the project's `permissions` rules. Claude Code writes the trust record
   itself.
5. Type as in the terminal app. Your settings decide the model, the effort and the mode; a pick in the composer row
   applies to this session only.

## Key differences from the terminal app

| In the terminal app | In DSH with this plugin |
| --- | --- |
| Shift+Tab cycles the permission mode | The same: Shift+Tab in the composer of a Claude Code session (unless another plugin owns the key). The mode picker in the composer row does the same. |
| Esc stops the turn | DSH's **Stop** button. It interrupts the turn only: background agents, workflows and shells keep running. |
| Esc Esc opens rewind | No double-Esc key. Use **Rewind** in the composer row (conversation, code, or both). |
| `/model`, `/permission` | Our pickers in the composer row. DSH's own model seat changes the DSH profile default, not this session. |
| `/btw` | Works: the answer shows in our side-question panel. |
| Background tasks in the footer | DSH jobs. The session stays free while they run. |
| Subagents inline | DSH child sessions (the **Agents** button in the session header). |
| Tool calls printed in full | DSH folds them into "Called tools"; open the fold to see the command and its output. |
| `claude --resume <id>` of a terminal session | Not offered: the plugin has no way to open a session started in the terminal app. A DSH session resumes its own Claude session after a DSH restart. |
| `!` shell lines, `#` memory lines | Sent to Claude Code as typed text. What the CLI does with them in SDK mode is **unverified**. |

## What is not supported, and why

- **Stop one workflow agent, pause, skip, retry:** terminal-app only. The SDK can stop only a whole workflow run.
- **Message a teammate (agent teams):** the CLI has no control for it.
- **Terminal-only dialogs** (`/skills`, `/memory`, `/status`, `/hooks`, `/permissions`, `/plugin`, `/resume`, `/rewind`,
  `/tasks`, `/workflows`): they draw the terminal UI. They show in the `/` menu with a note. Use our panels (MCP,
  Rewind, Settings files, Agents) or open the files yourself.
- **Editing settings from the UI:** by design. The plugin never writes your settings files; **Settings files** shows them
  read-only and helps you open them.
- **Branch after Stop:** DSH offers no Branch button on a stopped turn. Use **Rewind**.
- **Same token total as DSH's meter:** DSH counts the main thread only; our pill also counts subagents.
- **Attached file names with both a space and a `"`:** DSH stores `"` as `_`, so the file name does not reach Claude
  Code.

More detail: [packages/plugin/README.md](packages/plugin/README.md).

## Behind a reverse proxy

`--public-url` alone makes DSH answer 403 on every API route (DSH's own trusted-host check). Start DSH with both
`--public-url` and a matching `--trusted-host`.

## Install note: the SDK platform package

The plugin uses the Claude Agent SDK, whose install pulls one large platform package with a
bundled CLI. The plugin never runs it (it always runs your own `claude`), and it cannot stop the
install. [packages/plugin/README.md](packages/plugin/README.md) says why and gives the opt-in
`overrides` block that removes it.

## Not affiliated

This is an independent community project. It is not made or endorsed by Anthropic or DeepSeek. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

[MIT](LICENSE)
