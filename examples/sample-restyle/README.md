# Sample plugin: sample-restyle

A small, real DSH plugin that restyles [dsh-raw-agent](../../packages/plugin/README.md) through its public restyle points
and its `rawAgentClient` service. Read it next to [docs/plugin-api.md](../../docs/plugin-api.md).

It is plain JavaScript in DSH's module-loader format, so it needs no build step.

## What it does

1. **Shadows our context pill** (R9.1). It registers the slot `conversation.composer.dock` with our entry id
   `raw-agent-context` at priority `-1`. The lowest live priority renders, so its dashed one-line pill
   (`ctx 42% · 12.3k tok · $0.12`) replaces ours. It is fed by `rawAgentClient.onEvent` (`state` and `usage` events) and
   renders nothing in sessions that are not ours. Our usage panel is not reachable while the sample runs, because the pill
   that opens it is replaced.
2. **Fills our slot** `raw-agent.controls.extra` (R9.1). Our client declares this list slot in the composer row of our
   sessions. The sample adds a **Sample** button there.
3. **Calls every `rawAgentClient` method** (R9.2) from the button's panel:
   - **Info**: `sessionInfo` (and the `backends` list).
   - **Prefill composer** and **Prefill side question**: `prefill`. Nothing is sent; you press Enter. 0.1.2: **Prefill
     side question** opens our **Side chat** tab in DSH's right sidebar with the text in its box (checked live).
   - **Stop turn**: `interrupt` (DSH's own Stop; background tasks keep running).
   - **Send**, **Steer**, **Side question**: `send`, `steer`, `askSideQuestion`. Each needs a grant token. Without one,
     the panel shows the refusal (`Refused (no-grant): …`).
   - The pill uses `onEvent`.

The Host half (`index.js`) only reads the Host `rawAgent` service softly with `ctx.inject` and logs its backends.

## Try it

Use a throwaway DSH profile, not your daily one.

```sh
dsh plugin --profile <profile> add dsh-raw-agent
dsh plugin --profile <profile> add "file:$PWD/examples/sample-restyle"
```

Restart DSH and open a Claude Code session. The dashed pill replaces our context pill, and **Sample** sits in the composer
row. To try Send, Steer or Side question:

1. Open **Agent plugin access** (DSH settings, or the bottom of our **Settings files** dialog).
2. Create a grant named `sample-restyle` and copy the token.
3. Paste it into the Sample panel's token field. It is kept in that page only.
4. Press **Revoke** when you are done.

## Notes

- The sample never answers a permission, question or plan card. No service method can.
- Shadowing a whole entry replaces its behaviour too. Keep restyle targets small.
- Checked live (M8, DSH 0.2.2-rc.1): installed with `dsh plugin add file:…`, the pill is replaced, **Sample** shows in
  the composer row, and every button works. Without a grant, Send, Steer and Side question show `Refused (no-grant)`.
- A grant lasts until DSH restarts (DSH does not save it to a file yet). Create it again after a restart.
- The panel can reach past the right edge of a narrow window (it is a demo, not styled for every width).
