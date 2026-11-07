# dsh-raw-agent

Run your **own, unmodified Claude Code** inside [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh), and use DSH plugins to change how everything looks and behaves.

> **Status: pre-alpha.** Usable for testing; install and use are described in [packages/plugin/README.md](packages/plugin/README.md).

## Why

You already know Claude Code, and your setup is tuned: settings, skills, MCP servers, plugins, hooks and agents. DSH has a plugin system that lets you reshape the whole interface. This project joins the two **without changing Claude Code**:

- **Your binary and your settings.** It runs your own `claude` with your user, project and local settings. The plugin never edits your settings; it gives you one-click access to open `settings.json` yourself.
- **Nothing hidden.** No extra system-prompt text, no hidden prompts, no forced flags. What you type is what Claude sees.
- **Every Claude Code feature.** Subagents, agent teams, dynamic workflows, every permission mode (default, accept edits, plan, auto, don't ask, bypass), MCP, skills, slash commands, `/btw`, plan mode, questions, resume, fork, rewind.
- **Honest usage.** Tokens, cache, cost, context window and plan limits, whether you use a subscription, an API key, Bedrock or Vertex.
- **Native DSH sessions.** Turns and tool calls live in the DSH session log, so DSH features and other plugins work with them.
- **More CLIs later.** Codex and ACP agents, behind the same interface.

See [docs/requirements.md](docs/requirements.md) for the full list.

## Install note: the SDK platform package

The plugin uses the Claude Agent SDK, whose install pulls one large platform package with a
bundled CLI. The plugin never runs it (it always runs your own `claude`), and it cannot stop the
install. [packages/plugin/README.md](packages/plugin/README.md) says why and gives the opt-in
`overrides` block that removes it.

## Not affiliated

This is an independent community project. It is not made or endorsed by Anthropic or DeepSeek. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

[MIT](LICENSE)
