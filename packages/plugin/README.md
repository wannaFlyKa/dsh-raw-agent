# dsh-raw-agent

A DeepSeek Harness (DSH) plugin that runs **your own, unmodified Claude Code CLI** as the agent
of a DSH session. See the [project README](../../README.md) and
[docs/requirements.md](../../docs/requirements.md).

> Status: pre-alpha.

## Which `claude` runs

The plugin always runs your own `claude`: the path you set in the plugin config, else the first
`claude` on `PATH`, else `~/.local/bin/claude` (on Windows also `claude.exe`). It always passes
that path to the Claude Agent SDK, so the SDK never looks for, and never runs, a CLI of its own.

## Why the install contains an SDK platform package

The plugin talks to your `claude` through the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`), a normal dependency. That SDK lists eight platform packages
(`@anthropic-ai/claude-agent-sdk-<platform>`, about 230-330 MB each, each holding a bundled CLI)
as `optionalDependencies`. Your package manager installs the one that matches your machine.

The plugin **cannot prevent this**:

- npm and pnpm read `overrides` only from the root project, never from a dependency, so a block
  in this package's own `package.json` would be ignored.
- Bundling (vendoring) the SDK into the plugin to drop the dependency is not an option: the SDK's
  licence is proprietary, and this plugin is MIT.

The platform package is **never run**: the plugin always sets the path of your own `claude`
(see above). It only costs disk space.

## Remove the platform package (opt in)

DSH installs plugins into a pnpm workspace in your DSH profile. To drop the SDK's platform
packages there, add this block to the profile's `pnpm-workspace.yaml` (merge it with an existing
`overrides:` key) and reinstall the plugin:

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

With plain npm, the same idea is an `overrides` entry in the root `package.json` of the folder
you install into. This plugin's own workspace uses the pnpm block above.

## Settings files

The plugin never writes your Claude Code settings files. The "Settings files" button in a Claude
Code session lists `~/.claude/settings.json`, `<project>/.claude/settings.json` and
`<project>/.claude/settings.local.json` read-only, with values under `env` masked. Edit them
with your own editor; "Open in terminal" opens a DSH terminal and copies a `cd` command to the
file's folder.

## Licence

MIT. Claude Code and the Claude Agent SDK are Anthropic products under their own terms; this
project is not made or endorsed by Anthropic.
