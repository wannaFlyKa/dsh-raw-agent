# Changelog

All notable changes to `dsh-raw-agent`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/). The plugin service API has its own number (`apiVersion`, now 1).

## 0.1.2 (2026-11-07)

The side chat moves into DSH's right sidebar. No change to what reaches Claude Code.

### Changed

- **Side chat tab.** `/btw` questions and answers now show in a **Side chat** tab in DSH's right sidebar, not in a box
  over the page. It opens when you type `/btw <question>`, press the new **Side chat** button in the composer row, or
  when another plugin prefills a side question. The tab shows that session's questions and answers (newest at the
  bottom, answers in Markdown), a box to ask the next one, "Thinking…" while it waits, errors, Cancel, and **Start
  Claude Code** when no CLI runs. Each session has its own tab and history (in memory, the last 20 exchanges). Nothing
  is added to the conversation, and no extra `claude` process starts: the question goes to the session's live CLI.
- **Only in Claude Code sessions.** Other sessions show no Side chat button; a Side chat tab there says it works only
  in Claude Code sessions.
- **Plugin API.** `rawAgentClient.prefill(sessionId, text, 'side-question')` now opens the tab and puts the text in
  its box, once: coming back to the session later does not open it again. The method names did not change.
- **Older DSH.** Without DSH's right-sidebar tab API the old side-question box is used, as in 0.1.1.

## 0.1.1 (2026-11-07)

UI polish. No change to what reaches Claude Code.

### Changed

- **Compact chips.** The model, effort and permission-mode pickers are small chips in the style of DSH's own composer
  pills, built on DSH's theme tokens (light and dark). They show short values ("Opus 5.5", "xhigh", "Auto"; ultracode
  as "Ultracode"). A value from your settings has a small dot; its tooltip and screen-reader name say "from your
  settings" with the full text. The native list, Shift+Tab and keyboard use work as before. MCP, Rewind and Settings
  files use the same chip style.
- **Mode colours.** The mode chip is grey for default, blue for plan, amber for accept edits, auto and don't ask (they
  act without asking you), and red for bypass permissions.
- **Full access.** DSH's file-access choice does not control Claude Code. In a new Claude Code session DSH's access
  seat (with "Full access") stayed visible for a short time; it is now hidden as soon as DSH reports the preset.
  `/permission` lists only Claude Code's modes. `/permission danger-full-access` (or another DSH preset name) says
  that DSH file access does not apply and points to `bypassPermissions` (needs the plugin option
  `allowDangerouslySkipPermissions`, as the CLI needs `--dangerously-skip-permissions`) or `auto`. Nothing is changed
  for you. Settings > General shows a short note under DSH's access row. Standard sessions are not changed.
- **Status line.** No doubled name ("Permission mode: Auto (this session)"). A note fades after about 5 seconds
  (errors after 12); screen readers still get it.
- **Theme tokens.** Our panels now use DSH's real theme token names (0.1.0 used names DSH does not define, so it fell
  back to system colours). The `--raw-agent-*` variables are unchanged; new `--raw-agent-chip-*` variables are listed
  in `docs/plugin-api.md`.

## 0.1.0 (2026-11-07)

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
