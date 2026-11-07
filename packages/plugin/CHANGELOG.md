# Changelog

All notable changes to `dsh-raw-agent`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/). The plugin service API has its own number (`apiVersion`, now 1).

## 0.1.0 (unreleased)

First public pre-release. Tested on DSH 0.2.2-rc.1 and Claude Code 2.1.318 (Linux).

### Added

- An agent preset, **Claude Code**, that runs your own, unmodified `claude` for each DSH session: your settings, CLAUDE.md,
  skills, plugins, hooks, MCP servers and agents, the `claude_code` system prompt with no append, and no forced flags.
- Native DSH session events for prose, thinking, tool calls and results, so DSH export, search and fork work.
- Stop interrupts only. Background agents, workflows and shells show as DSH jobs and never hold the turn.
- Session-only model, effort and permission-mode pickers (all six modes), plan approval, questions, MCP elicitations, and
  approvals with the CLI's own "always allow" suggestions.
- Subagents as DSH child sessions, agent teams, dynamic workflows (including ultracode), and the main-thread agent picker.
- The CLI's `/` commands, `/btw` side questions in a side panel, the MCP panel, rewind with file restore, fork, resume and
  crash reporting.
- Honest usage: per-turn tokens with cache, cost, per-model usage, context from the CLI, and plan limits for subscription
  accounts.
- Read-only quick access to your Claude Code settings files, with `env` values masked.
- Plugin services for other DSH plugins: Host `rawAgent` and Client `rawAgentClient` (API version 1), with per-plugin grants for
  sending text; restyle points (entry ids, chat nodes, tool views, CSS variables) and our own slot `raw-agent.controls.extra`.
  Types ship as `dsh-raw-agent/api` (types only).
- A sample plugin, `examples/sample-restyle`, that uses every restyle mechanism and every Client service method.

### Known limits

- See "What is not supported" in the README.
