window.__ModuleLoader__.load({ id: "dsh-raw-agent", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/plugin/src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);

// packages/dsh-client/src/port/index.tsx
var React20 = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");

// packages/dsh-client/src/api.ts
var SETTINGS = "settings";
var BASE = "api/raw-agent";
var RouteError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
  name = "RouteError";
};
async function read(fetchFn, url, init) {
  const r = await fetchFn(url, init);
  const body = await r.json().catch(() => void 0);
  if (!r.ok) {
    const message = typeof body?.error === "string" ? body.error : `request failed (${r.status})`;
    throw new RouteError(r.status, message);
  }
  return body;
}
var q = (sessionId) => `session=${encodeURIComponent(sessionId)}`;
function createApi(fetchFn) {
  const post = (body) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return {
    session: (id) => read(fetchFn, `${BASE}/session?${q(id)}`),
    async state(id) {
      const body = await read(fetchFn, `${BASE}/state?${q(id)}`);
      const list = Array.isArray(body?.returnedDrafts) ? body.returnedDrafts : [];
      return {
        returnedDrafts: list.filter(
          (d) => typeof d === "object" && d !== null && typeof d.text === "string"
        )
      };
    },
    async choose(id, choice) {
      const r = await fetchFn(`${BASE}/choice?${q(id)}`, post(choice));
      const body = await r.json().catch(() => void 0);
      if (r.status === 409 && body && "ok" in body) return body;
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return body;
    },
    async start(id) {
      await read(fetchFn, `${BASE}/start?${q(id)}`, post());
    },
    async answer(id, ask, reply) {
      const r = await fetchFn(
        `${BASE}/answer?${q(id)}`,
        post(typeof reply === "string" ? { ask, choice: reply } : { ...reply, ask })
      );
      const body = await r.json().catch(() => void 0);
      if ((r.status === 409 || r.status === 400) && body && body.ok === false)
        return {
          ok: false,
          error: body.error ?? "that question is no longer open",
          ...r.status === 409 ? { gone: true } : {},
          ...body.session ? { session: body.session } : {}
        };
      if (r.status === 409 && body)
        return {
          ok: false,
          gone: true,
          error: body.error ?? "that question is no longer open",
          ...body.session ? { session: body.session } : {}
        };
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return { ok: true, ...body?.session ? { session: body.session } : {} };
    },
    async interactions(id, signal, onLine) {
      const r = await fetchFn(`${BASE}/interactions?${q(id)}`, { signal });
      if (!r.ok) {
        const body = await r.json().catch(() => void 0);
        throw new RouteError(r.status, typeof body?.error === "string" ? body.error : `request failed (${r.status})`);
      }
      if (!r.body) throw new RouteError(r.status, "the interaction channel has no body");
      await readLines(r.body, signal, (text3) => {
        const line = parseChannelLine(text3);
        if (line) onLine(line);
      });
    },
    async stopChild(id, child) {
      const r = await fetchFn(`${BASE}/child-stop?${q(id)}&child=${encodeURIComponent(child)}`, post());
      const body = await r.json().catch(() => void 0);
      if (r.ok) return { ok: body?.ok !== false, ...body?.status ? { status: body.status } : {} };
      return {
        ok: false,
        error: body?.error ?? `request failed (${r.status})`,
        ...body?.status ? { status: body.status } : {}
      };
    },
    async stopTask(id, task) {
      const r = await fetchFn(`${BASE}/task-stop?${q(id)}&task=${encodeURIComponent(task)}`, post());
      const body = await r.json().catch(() => void 0);
      if (r.ok) return { ok: body?.ok !== false };
      return { ok: false, error: body?.error ?? `request failed (${r.status})` };
    },
    async stopWorkflow(id, task) {
      const r = await fetchFn(`${BASE}/workflow-stop?${q(id)}&task=${encodeURIComponent(task)}`, post());
      const body = await r.json().catch(() => void 0);
      const status = typeof body?.status === "string" ? { status: body.status } : {};
      if (r.ok) return { ok: body?.ok !== false, ...status };
      return { ok: false, error: body?.error ?? `request failed (${r.status})`, ...status };
    },
    async stopWorkflowAgent(id, task, agent) {
      const r = await fetchFn(
        `${BASE}/workflow-agent-stop?${q(id)}&task=${encodeURIComponent(task)}&agent=${encodeURIComponent(agent)}`,
        post()
      );
      const body = await r.json().catch(() => void 0);
      const status = typeof body?.status === "string" ? { status: body.status } : {};
      if (r.ok) return { ok: body?.ok !== false, ...status };
      return {
        ok: false,
        error: body?.error ?? `request failed (${r.status})`,
        ...status,
        ...body?.unsupported === true ? { unsupported: true } : {}
      };
    },
    async taskOutput(id, task) {
      const body = await read(
        fetchFn,
        `${BASE}/task-output?${q(id)}&task=${encodeURIComponent(task)}`
      );
      return {
        output: typeof body?.output === "string" ? body.output : "",
        totalBytes: typeof body?.totalBytes === "number" ? body.totalBytes : 0,
        truncated: body?.truncated === true
      };
    },
    async childOf(id) {
      const r = await fetchFn(`${BASE}/child-of?${q(id)}`);
      if (r.status === 404) return void 0;
      const body = await r.json().catch(() => void 0);
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      if (typeof body?.parentSession !== "string" || typeof body.childId !== "string")
        throw new RouteError(r.status, "the answer names no parent session");
      return { parentSession: body.parentSession, childId: body.childId };
    },
    async usage(id) {
      const body = await read(fetchFn, `${BASE}/usage?${q(id)}`);
      return parseUsageAnswer(body);
    },
    async context(id, detail = "summary") {
      const body = await read(fetchFn, `${BASE}/context?${q(id)}&detail=${detail}`);
      const out = { running: body?.running === true };
      const c = parseContextView(body?.context);
      if (c) out.context = c;
      if (typeof body?.reason === "string") out.reason = body.reason;
      return out;
    },
    configFiles: (id) => read(fetchFn, `${BASE}/config-files?${q(id)}`),
    configFile: (id, scope) => read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}`),
    reveal: (id, scope, index) => read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}&reveal=${index}`),
    commands: (id) => read(fetchFn, `${BASE}/commands?${q(id)}`),
    sideQuestions: (id) => read(fetchFn, `${BASE}/side-question?${q(id)}`),
    async askSide(id, question, signal) {
      const r = await fetchFn(`${BASE}/side-question?${q(id)}`, {
        ...post({ question }),
        ...signal ? { signal } : {}
      });
      const body = await r.json().catch(() => void 0);
      if (body && "ok" in body) return body;
      if (!r.ok) return { ok: false, error: body?.error ?? `request failed (${r.status})` };
      return { ok: false, error: "the answer could not be read" };
    },
    async cancelSide(id, entry) {
      const r = await fetchFn(`${BASE}/side-question-cancel?${q(id)}&id=${encodeURIComponent(entry)}`, post());
      const body = await r.json().catch(() => void 0);
      return { ok: r.ok && body?.ok === true, ...body?.side ? { side: body.side } : {} };
    },
    mcp: (id) => read(fetchFn, `${BASE}/mcp?${q(id)}`),
    async mcpAction(id, action, server, enabled) {
      const path = action === "reconnect" ? "mcp-reconnect" : action === "toggle" ? "mcp-toggle" : "mcp-auth";
      const extra = action === "toggle" ? `&enabled=${enabled === true ? "true" : "false"}` : "";
      const r = await fetchFn(`${BASE}/${path}?${q(id)}&server=${encodeURIComponent(server)}${extra}`, post());
      return mcpResult(r.status, await r.json().catch(() => void 0));
    },
    async mcpAuthCallback(id, server, url) {
      const r = await fetchFn(`${BASE}/mcp-auth-callback?${q(id)}`, post({ server, url }));
      return mcpResult(r.status, await r.json().catch(() => void 0));
    },
    async localOutput(id, outputId) {
      const r = await fetchFn(`${BASE}/local-output?${q(id)}&id=${encodeURIComponent(outputId)}`);
      if (r.status === 404) return void 0;
      const body = await r.json().catch(() => void 0);
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return body?.kind === "context" && isObj(body.context) ? { kind: "context", context: body.context } : void 0;
    },
    async rewind(id) {
      const body = await read(fetchFn, `${BASE}/rewind?${q(id)}`);
      return parseRewindOptions(body);
    },
    async rewindRestore(id, on) {
      const r = await fetchFn(`${BASE}/rewind-restore?${q(id)}&on=${on ? "1" : "0"}`, post());
      const body = await r.json().catch(() => void 0);
      return {
        ok: r.ok && body?.ok !== false,
        status: r.status,
        ...typeof body?.error === "string" ? { error: body.error } : {}
      };
    },
    async rewindFiles(id, message, dryRun) {
      const r = await fetchFn(
        `${BASE}/rewind-files?${q(id)}&message=${encodeURIComponent(message)}${dryRun ? "&dryRun=1" : ""}`,
        post()
      );
      const body = await r.json().catch(() => void 0);
      const out = { ok: r.ok && body?.ok === true };
      if (typeof body?.code === "string") out.code = body.code;
      if (typeof body?.error === "string") out.error = body.error;
      else if (!r.ok) out.error = `request failed (${r.status})`;
      const result = parseFileRewind(body?.result);
      if (result) out.result = result;
      return out;
    }
  };
}
function parseFileRewind(v4) {
  if (!isObj(v4) || typeof v4.ok !== "boolean") return void 0;
  const files = Array.isArray(v4.filesChanged) ? v4.filesChanged.filter((f) => typeof f === "string") : [];
  const out = { ok: v4.ok, filesChanged: files };
  if (typeof v4.error === "string") out.error = v4.error;
  if (finite(v4.insertions)) out.insertions = v4.insertions;
  if (finite(v4.deletions)) out.deletions = v4.deletions;
  if (finite(v4.skippedLinks)) out.skippedLinks = v4.skippedLinks;
  if (v4.dryRun === true) out.dryRun = true;
  return out;
}
function parseRewindOptions(body) {
  const points = (Array.isArray(body?.points) ? body.points : []).filter(
    (p) => isObj(p) && typeof p.messageId === "string" && p.messageId !== ""
  );
  return {
    running: body?.running === true,
    fileRewind: body?.fileRewind === true,
    unstartedFork: body?.unstartedFork === true,
    restoreCodePending: body?.restoreCodePending === true,
    displayName: typeof body?.displayName === "string" ? body.displayName : "The agent",
    points: points.map((p) => {
      const o = {
        messageId: p.messageId,
        text: typeof p.text === "string" ? p.text : "",
        at: finite(p.at) ? p.at : 0
      };
      if (typeof p.draft === "string" && p.draft !== "") o.draft = p.draft;
      if (p.cut === true) o.cut = true;
      if (finite(p.attachments) && p.attachments > 0) o.attachments = p.attachments;
      if (finite(p.forkSeq)) o.forkSeq = p.forkSeq;
      if (p.inherited === true) o.inherited = true;
      return o;
    })
  };
}
function mcpResult(status, body) {
  const b = isObj(body) ? body : {};
  if (typeof b.ok === "boolean") return b;
  return { ok: false, error: typeof b.error === "string" ? b.error : `request failed (${status})` };
}
var isObj = (v4) => typeof v4 === "object" && v4 !== null && !Array.isArray(v4);
var finite = (v4) => typeof v4 === "number" && Number.isFinite(v4);
function parseContextView(v4) {
  if (!isObj(v4) || !finite(v4.used) || !finite(v4.window) || v4.window <= 0 || v4.used < 0) return void 0;
  const source = v4.source === "report" || v4.source === "compaction" ? v4.source : "call";
  const out = {
    used: v4.used,
    window: v4.window,
    percent: finite(v4.percent) ? v4.percent : Math.round(v4.used / v4.window * 1e3) / 10,
    source,
    at: finite(v4.at) ? v4.at : 0
  };
  if (finite(v4.autoCompactAt)) out.autoCompactAt = v4.autoCompactAt;
  if (typeof v4.autoCompactEnabled === "boolean") out.autoCompactEnabled = v4.autoCompactEnabled;
  if (typeof v4.model === "string") out.model = v4.model;
  if (Array.isArray(v4.categories))
    out.categories = v4.categories.filter(
      (c) => isObj(c) && typeof c.name === "string" && finite(c.tokens)
    );
  return out;
}
function parseUsageAnswer(body) {
  const u = isObj(body?.usage) ? body.usage : {};
  const list = (x) => Array.isArray(x) ? x : [];
  const usage = {
    ...u,
    turns: list(u.turns).filter((t) => isObj(t) && isObj(t.usage)),
    compacting: u.compacting === true,
    compactions: list(u.compactions),
    retries: list(u.retries),
    resets: list(u.resets)
  };
  const ctx = parseContextView(u.context);
  if (ctx) usage.context = ctx;
  else delete usage.context;
  const out = { running: body?.running === true, usage };
  if (typeof body?.error === "string") out.error = body.error;
  return out;
}
function parseChannelLine(text3) {
  const t = text3.trim();
  if (t === "") return void 0;
  let v4;
  try {
    v4 = JSON.parse(t);
  } catch {
    return void 0;
  }
  if (typeof v4 !== "object" || v4 === null) return void 0;
  const o = v4;
  if (o.type === "ping") return { type: "ping" };
  if (o.type !== "asks" || !Array.isArray(o.asks)) return void 0;
  const asks = o.asks.filter(
    (a) => typeof a === "object" && a !== null && typeof a.id === "string" && typeof a.kind === "string" && Array.isArray(a.choices)
  );
  const line = { type: "asks", asks };
  if (typeof o.state === "object" && o.state !== null) line.state = o.state;
  const live = v4.live;
  if (typeof live === "object" && live !== null && !Array.isArray(live)) line.live = live;
  const rows = v4;
  if (Array.isArray(rows.children) && Array.isArray(rows.tasks)) {
    const children = rows.children.filter(
      (c) => typeof c === "object" && c !== null && typeof c.id === "string" && typeof c.label === "string"
    );
    const tasks = rows.tasks.filter(
      (t2) => typeof t2 === "object" && t2 !== null && typeof t2.taskId === "string"
    );
    const team = typeof rows.team === "object" && rows.team !== null && Array.isArray(rows.team.teams) ? rows.team : void 0;
    line.agents = { children, tasks, ...team ? { team } : {} };
  }
  const runs = v4.workflows;
  if (Array.isArray(runs))
    line.workflows = runs.filter(
      (w) => typeof w === "object" && w !== null && typeof w.taskId === "string" && typeof w.runId === "string" && Array.isArray(w.agents) && Array.isArray(w.phases)
    );
  const o6 = v4;
  if (o6.side === null) line.side = null;
  else if (isObj(o6.side) && Array.isArray(o6.side.entries)) line.side = o6.side;
  if (o6.menu === null) line.menu = null;
  else if (isObj(o6.menu) && finite(o6.menu.version))
    line.menu = o6.menu;
  if (o6.mcp === null) line.mcp = null;
  else if (Array.isArray(o6.mcp))
    line.mcp = o6.mcp.filter(
      (m) => isObj(m) && typeof m.name === "string" && typeof m.status === "string"
    );
  const usage = v4.usage;
  if (usage === null) line.usage = null;
  else if (isObj(usage)) line.usage = usage;
  return line;
}
async function readLines(body, signal, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => void 0);
  signal.addEventListener("abort", cancel, { once: true });
  let buf = "";
  try {
    for (; ; ) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    }
    buf += dec.decode();
    if (buf.trim() !== "") onLine(buf);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

// packages/core/src/diff.ts
function splitLines(text3) {
  if (text3 === "") return [];
  const lines = text3.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
var MAX_DIFF_CELLS = 4e6;
function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = a.slice(0, head).map((text3) => ({ op: " ", text: text3 }));
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  if (ma.length * mb.length > MAX_DIFF_CELLS) {
    for (const text3 of ma) out.push({ op: "-", text: text3 });
    for (const text3 of mb) out.push({ op: "+", text: text3 });
  } else {
    const n2 = ma.length;
    const m = mb.length;
    const len = Array.from({ length: n2 + 1 }, () => new Uint32Array(m + 1));
    for (let i2 = n2 - 1; i2 >= 0; i2--)
      for (let j2 = m - 1; j2 >= 0; j2--)
        len[i2][j2] = ma[i2] === mb[j2] ? len[i2 + 1][j2 + 1] + 1 : Math.max(len[i2 + 1][j2], len[i2][j2 + 1]);
    let i = 0;
    let j = 0;
    while (i < n2 && j < m) {
      if (ma[i] === mb[j]) {
        out.push({ op: " ", text: ma[i] });
        i++;
        j++;
      } else if (len[i + 1][j] >= len[i][j + 1]) out.push({ op: "-", text: ma[i++] });
      else out.push({ op: "+", text: mb[j++] });
    }
    while (i < n2) out.push({ op: "-", text: ma[i++] });
    while (j < m) out.push({ op: "+", text: mb[j++] });
  }
  for (const text3 of a.slice(a.length - tail)) out.push({ op: " ", text: text3 });
  return out;
}
function numberDiff(lines, oldStart = 1, newStart = 1) {
  let o = oldStart;
  let n2 = newStart;
  return lines.map((l) => {
    if (l.op === " ") return { ...l, old: o++, new: n2++ };
    if (l.op === "-") return { op: l.op, text: l.text, old: o++ };
    return { op: l.op, text: l.text, new: n2++ };
  });
}
function diffHunks(lines, context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ op: "\u2026", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0) out.push({ op: "\u2026", count: skipped });
  return out;
}
function diffCounts(lines) {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  return { added, removed };
}
function diffText(lines) {
  return lines.map((l) => `${l.op}${l.text}`).join("\n");
}

// packages/core/src/modes.ts
function nextPermissionMode(cycle, current, available) {
  const at = current === void 0 ? -1 : cycle.indexOf(current);
  const order = at < 0 ? cycle : [...cycle.slice(at + 1), ...cycle.slice(0, at)];
  return order.find((id) => id !== current && available(id));
}

// packages/core/src/usage.ts
function totalTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}
function contextTokens(t) {
  return t.input + t.cacheRead + t.cacheWrite;
}
function cacheHitRatio(t) {
  const sent = contextTokens(t);
  return sent > 0 ? t.cacheRead / sent : void 0;
}

// packages/core/src/plugin-api.ts
var RAW_AGENT_CLIENT_SERVICE = "rawAgentClient";
var RAW_AGENT_API_VERSION = 1;
var RawAgentServiceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  name = "RawAgentServiceError";
};
var put = (o, k, v4) => {
  if (v4 !== void 0) o[k] = v4;
};
function sessionInfoFromView(sessionId, backend, view) {
  const b = { kind: backend.kind, displayName: backend.displayName };
  put(b, "version", view.live.version ?? backend.version);
  const info = {
    sessionId,
    backend: b,
    process: view.state.process,
    running: view.state.process === "running",
    busy: view.state.turn,
    backgroundTasks: view.state.backgroundTasks,
    waitingForUser: view.state.waiting ?? view.asks?.length ?? 0
  };
  put(info, "mode", view.live.mode ?? view.choice?.pendingMode);
  put(info, "model", view.live.model);
  put(info, "backendSessionId", view.backendSessionId);
  return info;
}
function usageOf(u) {
  const out = { compacting: u.compacting === true };
  put(out, "tokens", u.tokens);
  put(out, "costUsd", u.costUsd);
  put(out, "costLabel", u.costLabel);
  if (u.context) out.context = { used: u.context.used, window: u.context.window, percent: u.context.percent };
  if (u.limit) {
    const l = { id: u.limit.id, label: u.limit.label };
    put(l, "percent", u.limit.percent);
    put(l, "resetsAt", u.limit.resetsAt);
    put(l, "status", u.limit.status);
    out.limit = l;
  }
  put(out, "limitsAvailable", u.limitsAvailable);
  return out;
}
function workflowsOf(list) {
  return list.map((w) => {
    const r = {
      taskId: w.taskId,
      runId: w.runId,
      name: w.name,
      status: w.status,
      phases: w.phases.map((p) => ({ index: p.index, title: p.title })),
      agents: w.agents.map((a) => {
        const row = { index: a.index, label: a.label, state: a.state };
        put(row, "phaseIndex", a.phaseIndex);
        put(row, "tokens", a.tokens);
        return row;
      }),
      startedAt: w.startedAt
    };
    put(r, "endedAt", w.endedAt);
    return r;
  });
}
function childrenOf(list) {
  return list.map((c) => {
    const r = {
      id: c.id,
      parent: c.parent,
      label: c.label,
      status: c.status,
      background: c.background
    };
    put(r, "hostSessionId", c.hostSessionId);
    put(r, "tokens", c.tokens);
    return r;
  });
}
function asksOf(list) {
  return list.map((a) => ({ id: a.id, kind: a.kind, agent: a.agent, title: a.title, at: a.at }));
}
var PublicEventTracker = class {
  #sessionId;
  #backend;
  #last = /* @__PURE__ */ new Map();
  #ended = false;
  constructor(sessionId, backend) {
    this.#sessionId = sessionId;
    this.#backend = backend;
  }
  update(view) {
    if (this.#ended) return [];
    const id = this.#sessionId;
    const candidates = [
      { type: "state", sessionId: id, info: sessionInfoFromView(id, this.#backend, view) }
    ];
    if (view.usage) candidates.push({ type: "usage", sessionId: id, usage: usageOf(view.usage) });
    if (view.workflows || this.#last.has("workflows"))
      candidates.push({ type: "workflows", sessionId: id, runs: workflowsOf(view.workflows ?? []) });
    if (view.children || this.#last.has("children"))
      candidates.push({ type: "children", sessionId: id, children: childrenOf(view.children ?? []) });
    if (view.asks || this.#last.has("asks"))
      candidates.push({ type: "asks", sessionId: id, asks: asksOf(view.asks ?? []) });
    const out = [];
    for (const e of candidates) {
      const key = JSON.stringify(e);
      if (this.#last.get(e.type) === key) continue;
      this.#last.set(e.type, key);
      out.push(e);
    }
    return out;
  }
  /** The session went away: one `ended` event, then nothing. */
  end() {
    if (this.#ended) return [];
    this.#ended = true;
    return [{ type: "ended", sessionId: this.#sessionId }];
  }
};

// packages/dsh-client/src/view-model.ts
var START_OPTION = "__raw-agent-start__";
function modelSelect(info) {
  const v4 = info.view;
  const name2 = info.backend.displayName;
  const settingsModel = (v4.choice.applied.model === void 0 && !v4.choice.resetPending ? v4.live.model : void 0) ?? info.settings?.model;
  const settingsLabel = settingsModel ? `Your settings (${settingsModel})` : "Your settings";
  const options = [{ value: SETTINGS, label: settingsLabel }];
  for (const m of info.models) options.push({ value: m.value, label: m.displayName || m.value });
  const chosen = v4.choice.model;
  if (chosen !== void 0 && chosen !== SETTINGS && !options.some((o) => o.value === chosen))
    options.push({ value: chosen, label: chosen });
  const running = v4.live.model;
  const sent = v4.choice.applied.model === chosen || v4.choice.refused?.model === chosen;
  if (chosen !== void 0 && chosen !== SETTINGS && running !== void 0 && sent) {
    const opt = options.find((o) => o.value === chosen);
    const same = running === chosen || info.models.some((m) => m.value === chosen && m.displayName === running);
    if (opt && !same && !running.startsWith(chosen) && !chosen.startsWith(running))
      opt.label = `${opt.label} (running: ${running})`;
  }
  if (info.models.length === 0 && v4.state.process === "none")
    options.push({ value: START_OPTION, label: `Start ${name2} to list models` });
  const title = info.modelsFrom === "recent" ? `Model for this session only. The list is from another session and may differ for this folder.` : "Model for this session only. Your settings files are not changed.";
  return { value: chosen ?? SETTINGS, options, title };
}
function effortSelect(info) {
  if (info.efforts.length === 0) return void 0;
  const v4 = info.view;
  const settingsEffort = info.settings?.effort;
  const ultra = v4.live.ultracode;
  const modeEntry = info.efforts.find((e) => e.kind === "mode");
  const running = v4.live.effort;
  const modeOn = modeEntry && ultra?.on === true ? `${modeEntry.label.toLowerCase()} on` : void 0;
  const settingsLevel = running !== void 0 && settingsEffort !== void 0 && running !== settingsEffort ? `${settingsEffort}; running: ${running}` : running !== void 0 && settingsEffort === void 0 ? `running: ${running}` : settingsEffort;
  const fromSettings = [settingsLevel, v4.choice.effort === void 0 ? modeOn : void 0].filter((x) => x !== void 0 && x !== "").join(", ");
  const options = [
    { value: SETTINGS, label: fromSettings ? `Effort: your settings (${fromSettings})` : "Effort: your settings" }
  ];
  const applied = v4.choice.effort !== void 0 && v4.choice.applied.effort === v4.choice.effort;
  const modelId = v4.choice.model ?? v4.live.model;
  const supported = info.models.find((m) => m.value === modelId)?.efforts;
  for (const e of info.efforts) {
    const chosen = e.id === v4.choice.effort;
    const isMode = e.kind === "mode";
    const off = isMode ? ultra?.available === false && !chosen : supported !== void 0 && !supported.includes(e.id) && !chosen;
    const differs = [
      chosen && !isMode && applied && running !== void 0 && running !== e.id ? `running: ${running}` : void 0,
      chosen && !isMode && modeOn !== void 0 ? modeOn : void 0
    ].filter((x) => x !== void 0).join(", ");
    const base = isMode ? `${e.label} (any effort)` : `Effort: ${e.label}`;
    const o = { value: e.id, label: differs !== "" ? `${base} (${differs})` : base };
    const hint = [
      e.description,
      off && isMode ? `${info.backend.displayName} says it is not available for this session and model.` : void 0,
      chosen && isMode && ultra?.available === false ? `${info.backend.displayName} says it cannot take effect now.` : void 0
    ].filter((x) => x !== void 0 && x !== "").join(" ");
    if (hint !== "") o.hint = hint;
    if (off) o.disabled = true;
    options.push(o);
  }
  const title = modeEntry ? `Effort for this session only. ${modeEntry.label} keeps the effort level; picking a level turns it off.` : "Effort for this session only.";
  return { value: v4.choice.effort ?? SETTINGS, options, title };
}
function currentMode(info) {
  const v4 = info.view;
  return v4.choice.pendingMode ?? v4.live.mode ?? info.settings?.permissionMode ?? info.permissionModes[0]?.id ?? "";
}
function activeModel(info) {
  const v4 = info.view;
  const id = v4.choice.model !== void 0 && v4.choice.model !== SETTINGS ? v4.choice.model : v4.live.model ?? info.settings?.model;
  return info.models.find((m) => m.value === id || m.displayName === id);
}
function modeBlocked(info, id) {
  const off = info.unavailableModes?.find((m) => m.id === id);
  if (off)
    return off.optionLabel !== void 0 ? `Needs the plugin option \u201C${off.optionLabel}\u201D.` : "Not available in this session.";
  if (id === "auto" && activeModel(info)?.supportsAutoMode === false && currentMode(info) !== id)
    return `${info.backend.displayName} says this model has no auto mode.`;
  return void 0;
}
function nextModeFor(info) {
  const cycle = info.permissionModeCycle;
  if (!cycle || cycle.length === 0) return void 0;
  const offered = new Set(info.permissionModes.map((m) => m.id));
  return nextPermissionMode(cycle, currentMode(info), (id) => offered.has(id) && modeBlocked(info, id) === void 0);
}
function modeSelect(info) {
  const v4 = info.view;
  const current = currentMode(info);
  const fromSettings = info.settings?.permissionMode;
  const listed = [...info.permissionModes, ...info.unavailableModes ?? []];
  const options = listed.map((m) => {
    const blocked = modeBlocked(info, m.id);
    const o = {
      value: m.id,
      label: m.id === fromSettings ? `${m.label} (your settings)` : m.label
    };
    const hint = [m.description, blocked].filter((x) => x !== void 0 && x !== "").join(" ");
    if (hint !== "") o.hint = hint;
    if (blocked !== void 0 && m.id !== current) o.disabled = true;
    return o;
  });
  if (current !== "" && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  const key = info.permissionModeCycle?.length ? " Shift+Tab: next mode." : "";
  const title = v4.choice.pendingMode !== void 0 ? `Applies when ${info.backend.displayName} starts.${key}` : `Permission mode for this session only.${key}`;
  return { value: current, options, title };
}
function statusLine(info, opts = {}) {
  const v4 = info.view;
  if (v4.choice.resetPending) return `Back to your settings after ${info.backend.displayName} restarts`;
  if (v4.state.lastExit && v4.state.process === "none" && !opts.exitShown)
    return `${info.backend.displayName} stopped${v4.state.lastExit.error ? `: ${v4.state.lastExit.error}` : ""}. Send a message to start it again.`;
  if (v4.live.notice && v4.live.notice.topic !== "lifecycle") {
    const { text: text3, topic } = v4.live.notice;
    const name2 = info.backend.displayName;
    return topic === "mode" || text3.startsWith(name2) ? text3 : `${name2}: ${text3}`;
  }
  if (info.trust && (v4.asks ?? []).every((a) => a.kind !== "trust"))
    return info.trust.state === "untrusted" ? `${info.backend.displayName} does not trust this folder yet${info.trust.effect ? ` (${info.trust.effect})` : ""}. It asks before it starts.` : `${info.backend.displayName} could not tell whether it trusts this folder${info.trust.effect ? ` (${info.trust.effect})` : ""}.`;
  return void 0;
}
function askWho(a, name2) {
  if (a.agent !== "child") return name2;
  return a.agentLabel ? `Subagent \u201C${a.agentLabel}\u201D` : `A ${name2} subagent`;
}
function maskedSegments(masked, secrets) {
  const order = secrets.map((s2, index) => ({ ...s2, index })).filter(
    (s2) => Number.isInteger(s2.start) && Number.isInteger(s2.end) && s2.start >= 0 && s2.end <= masked.length && s2.start < s2.end
  ).sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const s2 of order) {
    if (s2.start < at) continue;
    if (s2.start > at) out.push({ kind: "text", text: masked.slice(at, s2.start) });
    const seg = { kind: "secret", text: masked.slice(s2.start, s2.end), index: s2.index };
    if (s2.key !== void 0) seg.key = s2.key;
    out.push(seg);
    at = s2.end;
  }
  if (at < masked.length) out.push({ kind: "text", text: masked.slice(at) });
  return out;
}
function folderOf(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return ".";
  if (i === 0) return path.slice(0, 1);
  return /^[A-Za-z]:$/.test(path.slice(0, i)) ? path.slice(0, i + 1) : path.slice(0, i);
}
function cdCommand(path) {
  const dir = folderOf(path);
  return dir.includes('"') ? `cd '${dir.replace(/'/g, "'\\''")}'` : `cd "${dir}"`;
}
function keyLayerRows(keys, labelOf) {
  return (keys ?? []).map((k) => {
    const names = k.scopes.map(labelOf);
    if (k.merged) return { key: k.key, text: `combined from ${names.join(" + ")}` };
    if (names.length === 1) return { key: k.key, text: names[0] };
    return { key: k.key, text: `${names[0]} (overrides ${names.slice(1).join(", ")})` };
  });
}
var cap = (s2) => s2 === "" ? s2 : s2.charAt(0).toUpperCase() + s2.slice(1);
function shortModelName(id) {
  let s2 = id.trim().replace(/^.*\//, "");
  const wide = /\[1m\]$/i.test(s2);
  s2 = s2.replace(/\[1m\]$/i, "").replace(/^(?:[a-z]+\.)+/i, "").replace(/-v\d+(?::\d+)?$/i, "").replace(/-\d{8}$/, "");
  const tail = wide ? " (1M)" : "";
  const parts = s2.split("-");
  const words = parts.filter((p) => /^[a-z]+$/i.test(p));
  const version = parts.filter((p) => /^\d{1,2}$/.test(p));
  if (words.length >= 2 && version.length >= 1 && words.length + version.length === parts.length)
    return `${cap(words[words.length - 1].toLowerCase())} ${version.join(".")}${tail}`;
  if (/^[a-z]+$/i.test(s2)) return `${cap(s2.toLowerCase())}${tail}`;
  return s2.length > 24 ? `${s2.slice(0, 23)}\u2026` : `${s2}${tail}`;
}
var selected = (m) => m.options.find((o) => o.value === m.value)?.label ?? m.value;
function modelChip(info) {
  const v4 = info.view;
  const model = modelSelect(info);
  const full = selected(model);
  const chosen = v4.choice.model;
  if (chosen === void 0 || chosen === SETTINGS) {
    const settingsModel = (v4.choice.applied.model === void 0 && !v4.choice.resetPending ? v4.live.model : void 0) ?? info.settings?.model;
    return { text: settingsModel ? shortModelName(settingsModel) : "Model", fromSettings: true, full };
  }
  const running = v4.live.model;
  const sent = v4.choice.applied.model === chosen || v4.choice.refused?.model === chosen;
  const shown = full.includes("(running: ") && running !== void 0 && sent ? running : chosen;
  return { text: shortModelName(shown), fromSettings: false, full };
}
function effortChip(info) {
  const effort = effortSelect(info);
  if (!effort) return void 0;
  const v4 = info.view;
  const full = selected(effort);
  const modeEntry = info.efforts.find((e) => e.kind === "mode");
  const chosen = v4.choice.effort;
  const chosenEntry = info.efforts.find((e) => e.id === chosen);
  if (chosenEntry?.kind === "mode") return { text: chosenEntry.label, fromSettings: false, full, sessionMode: true };
  if (chosen !== void 0) return { text: chosen, fromSettings: false, full };
  if (modeEntry && v4.live.ultracode?.on === true)
    return { text: modeEntry.label, fromSettings: true, full, sessionMode: true };
  const level = v4.live.effort ?? info.settings?.effort;
  return { text: level ?? "Effort", fromSettings: true, full };
}
function modeChip(info) {
  const v4 = info.view;
  const mode = modeSelect(info);
  const id = mode.value;
  const entry = [...info.permissionModes, ...info.unavailableModes ?? []].find((m) => m.id === id);
  const fromSettings = v4.choice.pendingMode === void 0 && info.settings?.permissionMode !== void 0 && id === info.settings.permissionMode;
  return {
    text: entry?.shortLabel ?? entry?.label ?? (id || "Mode"),
    fromSettings,
    full: entry?.label ?? id,
    risk: entry?.risk ?? "neutral"
  };
}
function modePopupOptions(info) {
  const name2 = info.backend.displayName;
  const current = currentMode(info);
  const fromSettings = info.settings?.permissionMode;
  return [...info.permissionModes, ...info.unavailableModes ?? []].map((m) => {
    const blocked = m.id === current ? void 0 : modeBlocked(info, m.id);
    const o = { id: m.id, label: m.label };
    const detail = [m.description, blocked].filter((x) => x !== void 0 && x !== "").join(" ");
    if (detail !== "") o.detail = detail;
    if (blocked !== void 0) o.blocked = blocked;
    if (m.id === fromSettings) o.badge = "your settings";
    if (m.id === current) o.active = true;
    if (m.risk === "danger" && blocked === void 0 && m.id !== current)
      o.confirmation = {
        title: `Switch to ${m.label}?`,
        description: `${name2} then runs every tool without asking, for this session only. Your settings files are not changed.`,
        acknowledgeLabel: "I understand the risk",
        cancelLabel: "Cancel",
        confirmLabel: `Use ${m.label}`
      };
    return o;
  });
}

// packages/dsh-client/src/agents-model.ts
function childTree(children) {
  const ids = new Set(children.map((c) => c.id));
  const byParent = /* @__PURE__ */ new Map();
  for (const c of children) {
    const parent = c.parent !== "main" && ids.has(c.parent) && c.parent !== c.id ? c.parent : "main";
    byParent.set(parent, [...byParent.get(parent) ?? [], c]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const walk = (parent, level) => {
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ child, level, hasChildren: (byParent.get(child.id) ?? []).length > 0 });
      walk(child.id, level + 1);
    }
  };
  walk("main", 0);
  for (const c of children) if (!seen.has(c.id)) out.push({ child: c, level: 0, hasChildren: false });
  return out;
}
function isRunning(c) {
  return c.status === "running" || c.status === "starting";
}
var STATUS_TEXT = {
  starting: "Starting",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped"
};
function childStatusText(c) {
  if (c.stopping && isRunning(c)) return "Stopping\u2026";
  return STATUS_TEXT[c.status] ?? c.status;
}
function taskStatusText(t) {
  return STATUS_TEXT[t.status] ?? t.status;
}
function childRoleText(c) {
  const kind = c.role === "teammate" ? "Teammate" : c.role === "workflow-agent" ? "Workflow agent" : c.background ? "Background agent" : "Subagent";
  return c.agentType && c.agentType !== c.label ? `${kind} \xB7 ${c.agentType}` : kind;
}
function formatTokens(n2) {
  if (n2 === void 0 || !Number.isFinite(n2) || n2 < 0) return void 0;
  if (n2 < 1e3) return `${Math.round(n2)} tokens`;
  if (n2 < 1e6) return `${(n2 / 1e3).toFixed(n2 < 1e4 ? 1 : 0)}k tokens`;
  return `${(n2 / 1e6).toFixed(1)}M tokens`;
}
function formatDuration(ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return void 0;
  const s2 = Math.floor(ms / 1e3);
  if (s2 < 60) return `${s2} s`;
  const m = Math.floor(s2 / 60);
  if (m < 60) return s2 % 60 === 0 ? `${m} min` : `${m} min ${s2 % 60} s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}
function childStats(c, now) {
  const parts = [];
  const tokens = formatTokens(c.tokens);
  if (tokens) parts.push(tokens);
  if (c.toolUses !== void 0) parts.push(`${c.toolUses} ${c.toolUses === 1 ? "tool use" : "tool uses"}`);
  const ms = isRunning(c) ? now - c.startedAt : c.endedAt !== void 0 ? Math.max(c.durationMs ?? 0, c.endedAt - c.startedAt) : c.durationMs ?? now - c.startedAt;
  const d = formatDuration(Math.max(0, ms));
  if (d) parts.push(d);
  return parts.join(" \xB7 ");
}
function childLastLine(c) {
  const l = c.last;
  if (!l || l.text === "") return void 0;
  if (l.kind === "tool") return `Calling ${l.text}`;
  if (l.kind === "reasoning") return `Thinking: ${l.text}`;
  return l.text;
}
function asksForChild(asks, childId) {
  return (asks ?? []).filter((a) => a.agent === "child" && a.agentId === childId);
}
function agentCounts(view) {
  const children = view.children ?? [];
  const tasks = view.tasks ?? [];
  return {
    children: children.length,
    running: children.filter(isRunning).length,
    waiting: (view.asks ?? []).filter((a) => a.agent === "child").length,
    tasks: tasks.length,
    tasksRunning: tasks.filter((t) => t.status === "running").length,
    teammates: children.filter((c) => c.role === "teammate").length
  };
}
function agentsButtonText(counts) {
  if (counts.children === 0 && counts.tasks > 0)
    return counts.tasksRunning > 0 ? `Tasks ${counts.tasks} \xB7 ${counts.tasksRunning} running` : `Tasks ${counts.tasks}`;
  const parts = [`Agents ${counts.children}`];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.tasksRunning > 0) parts.push(`${counts.tasksRunning} ${counts.tasksRunning === 1 ? "task" : "tasks"}`);
  return parts.join(" \xB7 ");
}
function childAddress(sessionId, children, child) {
  if (!child.hostSessionId) return void 0;
  let parentSessionId = sessionId;
  if (child.parent !== "main") parentSessionId = children.find((c) => c.id === child.parent)?.hostSessionId;
  if (!parentSessionId) return void 0;
  return { parentSessionId, childSessionId: child.hostSessionId, mode: "one-shot" };
}
function senderName(id, children, displayName) {
  if (id === "main") return `${displayName} (main)`;
  const c = children.find((x) => x.id === id);
  return c ? c.name ?? c.label : id;
}
function rosterModel(view, displayName) {
  const team = view.team;
  if (!team) return void 0;
  const children = view.children ?? [];
  const teams = team.teams.map((t) => ({
    name: t.name === "" ? "Team" : t.name,
    members: t.members.map((id) => children.find((c) => c.id === id)).filter((c) => c !== void 0)
  }));
  const messages = team.messages.map((m) => {
    const r = {
      from: m.from !== "" ? m.from : senderName(m.sender, children, displayName),
      to: m.to,
      text: m.text,
      at: m.at
    };
    if (m.summary !== void 0) r.summary = m.summary;
    return r;
  });
  const model = { teams, messages, messaging: team.messaging };
  if (!team.messaging)
    model.messagingNote = `This version of ${displayName} does not take a message to a teammate from here. Teammates still message each other, and you can ask the main agent to pass a message on.`;
  return model;
}
function wakeText(c) {
  if (c.wakes <= 0) return void 0;
  const times = c.wakes === 1 ? "once" : `${c.wakes} times`;
  return c.wokenBy ? `woken ${times}, last by ${c.wokenBy}` : `woken ${times}`;
}
function agentSelect(info) {
  if (info.mainAgentPicker === void 0 || info.mainAgentPicker === "none") return void 0;
  const v4 = info.view;
  const name2 = info.backend.displayName;
  const agents = info.agents ?? [];
  const label2 = (n2) => `Agent: ${n2}`;
  if (v4.choice.agentLocked === true) {
    const seated = v4.live.agent ?? v4.choice.agent;
    if (seated === void 0) return void 0;
    return {
      value: seated,
      options: [{ value: seated, label: label2(seated) }],
      title: `The main-thread agent of this session. ${name2} cannot change it after the first message.`,
      locked: true
    };
  }
  const options = [{ value: SETTINGS, label: "Agent: none" }];
  for (const a of agents) {
    const o = { value: a.name, label: label2(a.name) };
    const hint = [a.description, a.model && a.model !== "inherit" ? `Model: ${a.model}` : void 0].filter((x) => x !== void 0 && x !== "").join(" ");
    if (hint !== "") o.hint = hint;
    options.push(o);
  }
  const chosen = v4.choice.agent;
  if (chosen !== void 0 && !options.some((o) => o.value === chosen))
    options.push({ value: chosen, label: label2(chosen) });
  if (agents.length === 0 && v4.state.process === "none")
    options.push({ value: START_OPTION, label: `Start ${name2} to list agents` });
  const title = info.agentsFrom === "recent" ? `Main-thread agent for this new session only. The list is from another session in this folder and may differ.` : `Main-thread agent for this new session only (like --agent). It cannot change after the first message.`;
  return { value: chosen ?? SETTINGS, options, title, locked: false };
}
var WAKE_SOURCE_KIND = "raw-agent-wake";
var record = (v4) => typeof v4 === "object" && v4 !== null && !Array.isArray(v4) ? v4 : void 0;
function wakeTriggerOf(event) {
  if (event.type !== "developer/message") return null;
  const message = record(record(event.data)?.message);
  const source = record(message?.source);
  if (!message || source?.kind !== WAKE_SOURCE_KIND) return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text3 = content.map((c) => record(c)).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim();
  const items = Array.isArray(source.items) ? source.items.filter((i) => typeof i === "string" && i !== "").slice(0, 20) : [];
  const summary = typeof source.summary === "string" ? source.summary : "";
  return { seq: event.seq, time: event.time, text: text3 || summary, items };
}
function wakeHeading(t) {
  const i = t.text.indexOf(" after: ");
  return i > 0 ? t.text.slice(0, i) : t.text;
}

// packages/dsh-client/src/child-links.ts
var CHILD_LINK_RETRY_MS = [1500, 6e3];
var defaultTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h)
};
var ChildLinkStore = class {
  sessionId;
  #api;
  #timers;
  #retry;
  #snapshot = { status: "loading" };
  #listeners = /* @__PURE__ */ new Set();
  #started = false;
  #tries = 0;
  #timer;
  #disposed = false;
  constructor(sessionId, api, timers = defaultTimers, retry = CHILD_LINK_RETRY_MS) {
    this.sessionId = sessionId;
    this.#api = api;
    this.#timers = timers;
    this.#retry = retry;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    if (!this.#started) {
      this.#started = true;
      void this.#look();
    }
    return () => this.#listeners.delete(listener);
  };
  async #look() {
    if (this.#disposed) return;
    let link;
    try {
      link = await this.#api.childOf(this.sessionId);
    } catch {
      link = void 0;
    }
    if (this.#disposed) return;
    if (link) {
      this.#set({ status: "found", link });
      return;
    }
    const wait2 = this.#retry[this.#tries++];
    if (wait2 === void 0) {
      this.#set({ status: "none" });
      return;
    }
    this.#timer = this.#timers.set(() => {
      this.#timer = void 0;
      void this.#look();
    }, wait2);
  }
  #set(next) {
    this.#snapshot = next;
    for (const l of [...this.#listeners]) l();
  }
  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
    if (this.#timer !== void 0) this.#timers.clear(this.#timer);
  }
};
var ChildLinks = class {
  #api;
  #timers;
  #links = /* @__PURE__ */ new Map();
  constructor(api, timers) {
    this.#api = api;
    this.#timers = timers;
  }
  get(sessionId) {
    let l = this.#links.get(sessionId);
    if (!l) {
      l = new ChildLinkStore(sessionId, this.#api, this.#timers);
      this.#links.set(sessionId, l);
    }
    return l;
  }
  dispose() {
    for (const l of this.#links.values()) l.dispose();
    this.#links.clear();
  }
};

// packages/dsh-client/src/session-store.ts
var POLL_MS = { ready: 4e3, active: 1500, absent: 2e4, absentFirst: 1e3, error: 1e4 };
var CHANNEL_RETRY_MS = 2e3;
var defaultTimers2 = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h)
};
var SessionControlStore = class {
  sessionId;
  #api;
  #timers;
  #timings;
  #snapshot = { status: "loading", busy: false };
  #listeners = /* @__PURE__ */ new Set();
  #timer;
  #generation = 0;
  #inflight;
  #absentStreak = 0;
  #sidePrefillTaken = 0;
  #sideOpenClaimed = 0;
  #observers = /* @__PURE__ */ new Set();
  #channel;
  #channelTimer;
  #noChannel = false;
  #presetOurs = false;
  constructor(sessionId, api, timers = defaultTimers2, timings = POLL_MS) {
    this.sessionId = sessionId;
    this.#api = api;
    this.#timers = timers;
    this.#timings = timings;
  }
  getSnapshot = () => this.#snapshot;
  /** 0.1.1: DSH says this session runs one of our presets (its `agentPreset` projection). */
  get presetOurs() {
    return this.#presetOurs;
  }
  /**
   * 0.1.1: note what DSH's `agentPreset` projection says. A session that just became ours while
   * our route still answered 404 is read again at once, not after the 404 back-off (up to 20 s).
   */
  notePreset(ours) {
    const was = this.#presetOurs;
    this.#presetOurs = ours;
    if (ours && !was && this.#snapshot.status === "absent") {
      this.#absentStreak = 0;
      void this.refresh();
    }
  }
  subscribe = (listener) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) void this.refresh();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop();
        this.#closeChannel();
      }
    };
  };
  /**
   * Watch the snapshot without starting any reads (the port's pending-interaction publisher):
   * only a `subscribe` makes the store poll and open the interaction channel.
   */
  observe = (listener) => {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  };
  #set(next) {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
    for (const l of [...this.#observers]) {
      try {
        l();
      } catch {
      }
    }
  }
  #stop() {
    if (this.#timer !== void 0) this.#timers.clear(this.#timer);
    this.#timer = void 0;
  }
  #closeChannel() {
    if (this.#channelTimer !== void 0) this.#timers.clear(this.#channelTimer);
    this.#channelTimer = void 0;
    const c = this.#channel;
    this.#channel = void 0;
    c?.abort();
    if (this.#snapshot.channel === "open") this.#set({ channel: "closed" });
  }
  /**
   * D39: while someone looks at this session and it is ours, keep the interaction channel open,
   * so a new ask (or another browser's answer) shows at once. It reconnects after it ends.
   */
  #openChannel() {
    if (this.#channel || this.#channelTimer !== void 0) return;
    if (this.#listeners.size === 0 || this.#snapshot.status !== "ready") return;
    if (typeof this.#api.interactions !== "function" || this.#noChannel) return;
    const ac = new AbortController();
    this.#channel = ac;
    const onLine = (line) => {
      if (ac.signal.aborted || line.type !== "asks") return;
      const info = this.#snapshot.info;
      const next = { channel: "open" };
      if (info) {
        const view = {
          ...info.view,
          asks: line.asks,
          ...line.state ? { state: line.state } : {},
          ...line.live ? { live: line.live } : {}
        };
        if (line.agents) {
          if (line.agents.children.length > 0) view.children = line.agents.children;
          else delete view.children;
          if (line.agents.team) view.team = line.agents.team;
          else delete view.team;
          if (line.agents.tasks.length > 0) view.tasks = line.agents.tasks;
          else delete view.tasks;
        }
        if (line.workflows) {
          if (line.workflows.length > 0) view.workflows = line.workflows;
          else delete view.workflows;
        }
        if (line.usage !== void 0) {
          if (line.usage) view.usage = line.usage;
          else delete view.usage;
        }
        for (const key of ["side", "menu", "mcp"]) {
          const val = line[key];
          if (val === void 0) continue;
          if (val === null) delete view[key];
          else view[key] = val;
        }
        next.info = { ...info, view };
        ++this.#generation;
      }
      const err = this.#snapshot.askError;
      if (err && !line.asks.some((a) => a.id === err.id)) next.askError = void 0;
      this.#set(next);
    };
    void this.#api.interactions(this.sessionId, ac.signal, onLine).catch((e) => e).then((e) => {
      if (this.#channel !== ac) return;
      this.#channel = void 0;
      if (this.#snapshot.channel === "open") this.#set({ channel: "closed" });
      if (e instanceof RouteError && (e.status === 404 || e.status === 200)) {
        if (e.status === 200) this.#noChannel = true;
        return;
      }
      if (this.#listeners.size === 0) return;
      this.#channelTimer = this.#timers.set(() => {
        this.#channelTimer = void 0;
        this.#openChannel();
      }, CHANNEL_RETRY_MS);
    });
  }
  #schedule() {
    this.#stop();
    if (this.#listeners.size === 0) return;
    const s2 = this.#snapshot;
    const v4 = s2.info?.view;
    const asking = (v4?.asks?.length ?? 0) > 0 && s2.channel !== "open";
    const childRunning = s2.channel !== "open" && (v4?.children ?? []).some((c) => c.status === "running" || c.status === "starting");
    const active = v4 !== void 0 && (v4.state.turn || v4.state.process === "starting" || asking || childRunning);
    const ms = s2.status === "ready" ? active ? this.#timings.active : this.#timings.ready : s2.status === "absent" ? this.#absentDelay() : this.#timings.error;
    if (s2.status !== "absent") this.#absentStreak = 0;
    this.#timer = this.#timers.set(() => void this.refresh(), ms);
    if (s2.status === "ready") this.#openChannel();
    else if (s2.status === "absent") this.#closeChannel();
  }
  #absentDelay() {
    const max = this.#timings.absent;
    const first = Math.min(this.#timings.absentFirst ?? max, max);
    const ms = Math.min(max, first * 2 ** this.#absentStreak);
    this.#absentStreak++;
    return ms;
  }
  /** Read the session now. Concurrent calls share one request. */
  refresh() {
    this.#inflight ??= (async () => {
      const gen = ++this.#generation;
      try {
        const info = await this.#api.session(this.sessionId);
        if (gen !== this.#generation) return;
        const next = { status: "ready", info, error: void 0 };
        const s2 = this.#snapshot;
        if (s2.note !== void 0 && s2.noteProcess !== info.view.state.process) {
          next.note = void 0;
          next.noteProcess = void 0;
        }
        this.#set(next);
      } catch (e) {
        if (gen !== this.#generation) return;
        if (e instanceof RouteError && e.status === 404) this.#set({ status: "absent", info: void 0 });
        else this.#set({ status: this.#snapshot.info ? "ready" : "error", error: String(e?.message ?? e) });
      }
    })().finally(() => {
      this.#inflight = void 0;
      this.#schedule();
    });
    return this.#inflight;
  }
  /** A session-only choice (D35-D38). The Host answers with the new state. */
  async choose(choice) {
    this.#set({ busy: true, error: void 0, note: void 0 });
    try {
      const r = await this.#api.choose(this.sessionId, choice);
      ++this.#generation;
      const next = { busy: false };
      if (r.session) next.info = r.session;
      if (r.ok) {
        next.note = choiceNote(choice, r.note, r.session ?? this.#snapshot.info);
        next.noteProcess = (r.session ?? this.#snapshot.info)?.view.state.process;
      } else next.error = r.error ?? "the choice was refused";
      this.#set(next);
    } catch (e) {
      this.#set({ busy: false, error: String(e?.message ?? e) });
    }
  }
  /**
   * The user's answer to one pending ask (a click; nothing is answered without one). `reply` is a
   * bare choice id, or the choice with its feedback or form. A refused answer keeps the ask open
   * and names the reason on its card; an ask another browser answered first is dropped.
   */
  async answer(askId, reply) {
    if (this.#snapshot.answering === askId) return false;
    this.#set({ error: void 0, answering: askId, askError: void 0 });
    try {
      const r = await this.#api.answer(this.sessionId, askId, reply);
      ++this.#generation;
      const next = { answering: void 0 };
      if (r.session) next.info = r.session;
      else if (r.ok || r.gone) {
        const info = this.#snapshot.info;
        if (info)
          next.info = { ...info, view: { ...info.view, asks: (info.view.asks ?? []).filter((a) => a.id !== askId) } };
      }
      if (!r.ok) {
        const text3 = r.error ?? "that question is no longer open";
        if (r.gone) next.error = `${text3} (answered elsewhere, or withdrawn)`;
        else next.askError = { id: askId, text: text3 };
      }
      this.#set(next);
      return r.ok;
    } catch (e) {
      this.#set({ answering: void 0, askError: { id: askId, text: String(e?.message ?? e) } });
      return false;
    }
  }
  /**
   * The agent's "next mode" key (D38; Claude's Shift+Tab ring). False when the session has no
   * ring, nothing to switch to, a choice is in flight, or an ask waits for the user.
   */
  cycleMode() {
    const s2 = this.#snapshot;
    if (s2.status !== "ready" || !s2.info || s2.busy) return false;
    if ((s2.info.view.asks ?? []).length > 0) return false;
    const next = nextModeFor(s2.info);
    if (next === void 0) return false;
    void this.choose({ mode: next });
    return true;
  }
  /**
   * D46: stop one child agent (the user's click). The others and the main turn keep running. The
   * Host waits up to 2 s for the agent's own end; a later end arrives with the next read.
   */
  async stopChild(childId) {
    return this.#stopOne(childId, () => this.#api.stopChild(this.sessionId, childId));
  }
  /** D47: stop one background task from the plugin's task list (the user's click). */
  async stopTask(taskId) {
    return this.#stopOne(taskId, () => this.#api.stopTask(this.sessionId, taskId));
  }
  /**
   * D48: "Stop entire workflow" (the user's click): the agent's per-task stop on the run. The
   * process, the main turn and other tasks keep running (rule 6).
   */
  async stopWorkflow(taskId) {
    return this.#stopOne(taskId, () => this.#api.stopWorkflow(this.sessionId, taskId));
  }
  /** D48: stop one workflow agent, only where the agent can (the Host refuses it otherwise). */
  async stopWorkflowAgent(taskId, agentId) {
    return this.#stopOne(agentId, () => this.#api.stopWorkflowAgent(this.sessionId, taskId, agentId));
  }
  /** R6.2: read the end of one background shell's or monitor's output (a read, no state kept). */
  taskOutput(taskId) {
    return this.#api.taskOutput(this.sessionId, taskId);
  }
  async #stopOne(id, call) {
    const busy = this.#snapshot.stopping ?? [];
    if (busy.includes(id)) return false;
    this.#set({ stopping: [...busy, id], stopError: void 0 });
    let ok = false;
    try {
      const r = await call();
      ok = r.ok;
      if (!r.ok) this.#set({ stopError: { id, text: r.error ?? "the stop was refused" } });
    } catch (e) {
      this.#set({ stopError: { id, text: String(e?.message ?? e) } });
    }
    this.#set({ stopping: (this.#snapshot.stopping ?? []).filter((x) => x !== id) });
    await this.refresh();
    return ok;
  }
  /** "Start <displayName>" (D4): spawn without a message, for controls that need a process. */
  /** Ask the controls of this session to open one of our panels (D55 `/mcp`, D30 `/rewind`). */
  /** R9.2: hand prefill text to the controls (browser state only; nothing is sent). */
  requestPrefill(text3, target) {
    this.#set({ prefillRequest: { text: text3, target, seq: (this.#snapshot.prefillRequest?.seq ?? 0) + 1 } });
  }
  /**
   * 0.1.2: the side chat tab takes side-question prefill text once. A tab that mounts later (or
   * again) does not take the same text twice. Undefined: no new side-question text.
   */
  takeSidePrefill() {
    const req = this.#snapshot.prefillRequest;
    if (!req || req.target !== "side-question" || req.seq <= this.#sidePrefillTaken) return void 0;
    this.#sidePrefillTaken = req.seq;
    return { text: req.text, seq: req.seq };
  }
  /**
   * 0.1.2: the controls open the side chat tab once per side-question prefill. A composer that
   * mounts again (the user came back to the session) does not open it again for old text.
   */
  claimSideOpen(seq) {
    if (seq <= this.#sideOpenClaimed) return false;
    this.#sideOpenClaimed = seq;
    return true;
  }
  requestPanel(panel) {
    this.#set({ panelRequest: { panel, seq: (this.#snapshot.panelRequest?.seq ?? 0) + 1 } });
  }
  /**
   * Show a line in this session's controls until its process state changes (the same life as a
   * choice's note). Browser state only.
   */
  showNote(text3) {
    this.#set({ note: text3, noteProcess: this.#snapshot.info?.view.state.process });
  }
  async start() {
    this.#set({ busy: true, error: void 0 });
    try {
      await this.#api.start(this.sessionId);
      this.#set({ busy: false });
    } catch (e) {
      this.#set({ busy: false, error: String(e?.message ?? e) });
    }
    await this.refresh();
  }
  dispose() {
    this.#listeners.clear();
    this.#observers.clear();
    this.#stop();
    this.#closeChannel();
  }
};
var SessionStores = class {
  #api;
  #timers;
  #stores = /* @__PURE__ */ new Map();
  #created = /* @__PURE__ */ new Set();
  constructor(api, timers) {
    this.#api = api;
    this.#timers = timers;
  }
  get(sessionId) {
    let s2 = this.#stores.get(sessionId);
    if (!s2) {
      s2 = new SessionControlStore(sessionId, this.#api, this.#timers);
      this.#stores.set(sessionId, s2);
      for (const fn of [...this.#created]) fn(s2);
    }
    return s2;
  }
  /** The store of a session, only if one exists (no store is created). */
  peek(sessionId) {
    return this.#stores.get(sessionId);
  }
  /** Run `fn` for every store, now and when one is created. */
  each(fn) {
    for (const s2 of this.#stores.values()) fn(s2);
    this.#created.add(fn);
    return () => this.#created.delete(fn);
  }
  dispose() {
    for (const s2 of this.#stores.values()) s2.dispose();
    this.#stores.clear();
  }
};
function choiceNote(choice, note, info) {
  const rest = (note ?? "").split("; ").filter((n2) => n2 !== "" && n2 !== "applied").join("; ");
  if (choice.mode !== void 0 && choice.model === void 0 && choice.effort === void 0) {
    const m = [...info?.permissionModes ?? [], ...info?.unavailableModes ?? []].find((x) => x.id === choice.mode);
    return `Permission mode: ${m?.label ?? choice.mode} (this session${rest ? `; ${rest}` : ""})`;
  }
  return note;
}

// packages/dsh-client/src/usage-reader.ts
var UsageReader = class {
  sessionId;
  #api;
  #snapshot = { reading: false, reads: 0 };
  #listeners = /* @__PURE__ */ new Set();
  #seen;
  #open = 0;
  #inflight = 0;
  #pending = {};
  #busy;
  #disposed = false;
  constructor(sessionId, api) {
    this.sessionId = sessionId;
    this.#api = api;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(next) {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
  }
  /** The latest context report read from the route (the pill prefers the newer figure). */
  get report() {
    return this.#snapshot.context?.context;
  }
  /**
   * The panel opened (true) or closed (false). Opening reads the usage and the full breakdown;
   * while open, summary changes read the usage again.
   */
  setOpen(open) {
    this.#open = Math.max(0, this.#open + (open ? 1 : -1));
    if (open) void this.read({ usage: true, context: "full" });
  }
  get open() {
    return this.#open > 0;
  }
  /** Take a new session view; returns what it asked to read (tests). */
  watch(view) {
    if (!view || this.#disposed) return {};
    const s2 = view.usage;
    const now = {
      process: view.state.process,
      turn: view.state.turn,
      compacting: s2?.compacting === true,
      hasContext: s2?.context !== void 0,
      ...s2 !== void 0 ? { key: summaryKey(s2) } : {}
    };
    const was = this.#seen;
    this.#seen = now;
    if (now.process !== "running") return {};
    const want = {};
    const detail = this.open ? "full" : "summary";
    if (was === void 0 || was.process !== "running")
      want.context = detail;
    else if (was.turn && !now.turn)
      want.context = detail;
    else if (was.compacting && !now.compacting)
      want.context = detail;
    else if (was.hasContext && !now.hasContext) want.context = detail;
    if (this.open && was !== void 0 && now.key !== was.key) want.usage = true;
    if (want.context !== void 0 || want.usage) void this.read(want);
    return want;
  }
  /** Read now. Requests while a read runs are merged and run once after it. */
  read(what) {
    if (this.#disposed) return Promise.resolve();
    if (what.usage) this.#pending.usage = true;
    if (what.context === "full" || what.context === "summary" && this.#pending.context === void 0)
      this.#pending.context = what.context;
    this.#busy ??= this.#drain().finally(() => {
      this.#busy = void 0;
    });
    return this.#busy;
  }
  async #drain() {
    while (!this.#disposed && (this.#pending.usage || this.#pending.context !== void 0)) {
      const job = this.#pending;
      this.#pending = {};
      this.#inflight++;
      this.#set({ reading: true });
      const next = {};
      const errors = [];
      await Promise.all([
        job.usage ? this.#api.usage(this.sessionId).then(
          (u) => void (next.usage = u),
          (e) => void errors.push(String(e?.message ?? e))
        ) : void 0,
        job.context !== void 0 ? this.#api.context(this.sessionId, job.context).then(
          (c) => {
            const prior = this.#snapshot.context?.context;
            if (!c.context && prior) c = { ...c, context: prior };
            next.context = c;
          },
          (e) => void errors.push(String(e?.message ?? e))
        ) : void 0
      ]);
      this.#inflight--;
      if (this.#disposed) return;
      this.#set({
        ...next,
        reading: this.#inflight > 0,
        reads: this.#snapshot.reads + 1,
        error: errors.length > 0 ? errors.join("; ") : void 0
      });
    }
  }
  dispose() {
    this.#disposed = true;
    this.#listeners.clear();
  }
};
var UsageReaders = class {
  #api;
  #readers = /* @__PURE__ */ new Map();
  #stores;
  constructor(stores, api) {
    this.#stores = stores;
    this.#api = api;
  }
  get(sessionId) {
    const hit = this.#readers.get(sessionId);
    if (hit) return hit.reader;
    const reader = new UsageReader(sessionId, this.#api);
    const store = this.#stores.get(sessionId);
    const sync = () => {
      const snap = store.getSnapshot();
      if (snap.status === "ready") reader.watch(snap.info?.view);
    };
    const off = store.observe(sync);
    sync();
    this.#readers.set(sessionId, { reader, off });
    return reader;
  }
  dispose() {
    for (const { reader, off } of this.#readers.values()) {
      off();
      reader.dispose();
    }
    this.#readers.clear();
  }
};
function summaryKey(s2) {
  return JSON.stringify(s2, (key, value) => key === "at" ? void 0 : value);
}

// packages/dsh-client/src/ui/agents-panel.tsx
var React4 = __toESM(require("react"), 1);

// packages/dsh-client/src/workflow-model.ts
function isLiveWorkflow(run) {
  return run.status === "starting" || run.status === "running";
}
var RUN_STATUS = {
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  cancelled: "Stopped",
  error: "Failed"
};
function workflowStatusText(run) {
  if (run.stopping === true && isLiveWorkflow(run)) return "Stopping\u2026";
  return RUN_STATUS[run.status] ?? run.status;
}
function isRunningAgent(a) {
  return a.state === "running";
}
function isSettledAgent(a) {
  return a.state === "done" || a.state === "error" || a.state === "stopped";
}
function workflowAgentStatusText(a) {
  switch (a.state) {
    case "queued":
      return a.blocked === true ? "Blocked" : "Queued";
    case "running":
      return "Running";
    case "done":
      return a.cached === true ? "Done (cached)" : "Done";
    case "error":
      return a.blocked === true ? "Blocked" : "Failed";
    case "stopped":
      return "Stopped";
    default:
      return a.rawState ?? String(a.state);
  }
}
function workflowAgentDot(a) {
  if (a.state === "running") return "running";
  if (a.state === "done") return "completed";
  if (a.state === "error") return "failed";
  if (a.state === "stopped") return "stopped";
  return "queued";
}
function workflowAgentRunMs(a, now) {
  if (a.state === "running" && a.startedAt !== void 0) return Math.max(a.durationMs ?? 0, now - a.startedAt);
  if (a.durationMs !== void 0) return a.durationMs;
  if (isSettledAgent(a) && a.startedAt !== void 0 && a.lastProgressAt !== void 0)
    return Math.max(0, a.lastProgressAt - a.startedAt);
  return void 0;
}
function workflowAgentStats(a, now) {
  const parts = [];
  const tokens = formatTokens(a.tokens);
  if (tokens) parts.push(tokens);
  if (a.toolCalls !== void 0) parts.push(`${a.toolCalls} ${a.toolCalls === 1 ? "tool call" : "tool calls"}`);
  const ms = workflowAgentRunMs(a, now);
  const d = formatDuration(ms === void 0 ? void 0 : Math.max(0, ms));
  if (d) parts.push(d);
  return parts.join(" \xB7 ");
}
function workflowAgentChild(a, children) {
  if (a.agentId === void 0) return void 0;
  return (children ?? []).find((c) => c.id === a.agentId);
}
function workflowAgentLast(a, child) {
  if (a.state === "error" && a.error) return a.error;
  if (isSettledAgent(a) && a.resultPreview) return a.resultPreview;
  const live = child ? childLastLine(child) : void 0;
  if (live !== void 0 && !isSettledAgent(a)) return live;
  if (a.lastToolName)
    return a.lastToolSummary ? `Calling ${a.lastToolName}: ${a.lastToolSummary}` : `Calling ${a.lastToolName}`;
  return live;
}
function workflowAgentAddress(sessionId, a, children) {
  const childSessionId = a.childSessionId ?? workflowAgentChild(a, children)?.hostSessionId;
  if (childSessionId === void 0) return void 0;
  return { parentSessionId: sessionId, childSessionId, mode: "one-shot" };
}
function phaseStatus(agents) {
  if (agents.length === 0) return "Not started";
  const running = agents.filter(isRunningAgent).length;
  const failed = agents.filter((a) => a.state === "error").length;
  const done = agents.filter((a) => a.state === "done").length;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${done} of ${agents.length} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" \xB7 ");
}
function workflowPhases(run) {
  const phases = [...run.phases].sort((a, b) => a.index - b.index);
  const groups = /* @__PURE__ */ new Map();
  const keyOf = (index, title) => index !== void 0 ? `i${index}` : title !== void 0 ? `t${title}` : "none";
  for (const p of phases)
    groups.set(keyOf(p.index, void 0), { index: p.index, title: p.title, agents: [], status: "" });
  const agents = [...run.agents].sort((a, b) => a.index - b.index);
  for (const a of agents) {
    let key = keyOf(a.phaseIndex, a.phaseTitle);
    if (a.phaseIndex === void 0 && a.phaseTitle !== void 0) {
      const named = phases.find((p) => p.title === a.phaseTitle);
      if (named) key = keyOf(named.index, void 0);
    }
    let g = groups.get(key);
    if (!g) {
      const title = a.phaseTitle ?? (a.phaseIndex !== void 0 ? `Phase ${a.phaseIndex}` : "Agents");
      g = { title, agents: [], status: "" };
      if (a.phaseIndex !== void 0) g.index = a.phaseIndex;
      groups.set(key, g);
    }
    g.agents.push(a);
  }
  const out = [...groups.values()];
  out.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
  for (const g of out) g.status = phaseStatus(g.agents);
  return out;
}
function workflowTokens(run) {
  if (run.usage?.tokens !== void 0) return run.usage.tokens;
  const known = run.agents.filter((a) => a.tokens !== void 0);
  return known.length === 0 ? void 0 : known.reduce((n2, a) => n2 + (a.tokens ?? 0), 0);
}
function workflowRunMs(run, now) {
  const end = isLiveWorkflow(run) ? now : run.endedAt ?? now;
  return Math.max(run.usage?.durationMs ?? 0, end - run.startedAt, 0);
}
function workflowSummaryLine(run, now) {
  const parts = [];
  if (run.phases.length > 0) parts.push(`${run.phases.length} ${run.phases.length === 1 ? "phase" : "phases"}`);
  parts.push(`${run.agents.length} ${run.agents.length === 1 ? "agent" : "agents"}`);
  const running = run.agents.filter(isRunningAgent).length;
  if (running > 0) parts.push(`${running} running`);
  const done = run.agents.filter((a) => a.state === "done").length;
  if (done > 0) parts.push(`${done} done`);
  const failed = run.agents.filter((a) => a.state === "error").length;
  if (failed > 0) parts.push(`${failed} failed`);
  const tokens = formatTokens(workflowTokens(run));
  if (tokens) parts.push(tokens);
  const d = formatDuration(workflowRunMs(run, now));
  if (d) parts.push(d);
  return parts.join(" \xB7 ");
}
function findWorkflow(view, runId) {
  return view?.workflows?.find((w) => w.runId === runId || w.taskId === runId);
}
function hasTaskOutput(t) {
  return t.kind === "shell" || t.kind === "monitor";
}
var ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
function plainTaskOutput(text3) {
  const noEsc = text3.replace(ANSI, "");
  return noEsc.split("\n").map((line) => {
    const body = line.endsWith("\r") ? line.slice(0, -1) : line;
    const i = body.lastIndexOf("\r");
    return i >= 0 ? body.slice(i + 1) : body;
  }).join("\n");
}
function outputCutNote(o) {
  if (!o.truncated) return void 0;
  const size = (n2) => n2 < 1024 ? `${n2} B` : n2 < 1024 * 1024 ? `${(n2 / 1024).toFixed(0)} KiB` : `${(n2 / 1024 / 1024).toFixed(1)} MiB`;
  return o.totalBytes > 0 ? `Showing the end of the output (${size(o.totalBytes)} in all).` : "Showing the end of the output.";
}
var TASK_OUTPUT_POLL_MS = 2e3;

// packages/dsh-client/src/task-output.ts
var defaultTimers3 = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h)
};
var TaskOutputReader = class {
  #read;
  #timers;
  #pollMs;
  #snapshot = { reading: false, reads: 0 };
  #listeners = /* @__PURE__ */ new Set();
  #running;
  #timer;
  #inflight;
  /** A read was asked for while one was in flight: read once more after it. */
  #again = false;
  #disposed = false;
  constructor(read2, timers = defaultTimers3, pollMs = TASK_OUTPUT_POLL_MS) {
    this.#read = read2;
    this.#timers = timers;
    this.#pollMs = pollMs;
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(next) {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
  }
  /**
   * The task's state from the task row. The first call reads at once. Running: poll. A change to
   * ended: one final read, then no more reads until `refresh()`.
   */
  setRunning(running) {
    if (this.#disposed) return;
    const before = this.#running;
    this.#running = running;
    if (before === running) return;
    this.#clearTimer();
    void this.refresh();
  }
  /** Read now (a running task keeps polling after it). */
  refresh() {
    if (this.#disposed) return Promise.resolve();
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#set({ reading: true });
    this.#inflight = this.#read().then(
      (output) => {
        if (!this.#disposed) this.#set({ output, error: void 0 });
      },
      (e) => {
        if (!this.#disposed) this.#set({ error: String(e?.message ?? e) });
      }
    ).finally(() => {
      this.#inflight = void 0;
      if (this.#disposed) return;
      this.#set({ reading: false, reads: this.#snapshot.reads + 1 });
      if (this.#again) {
        this.#again = false;
        void this.refresh();
        return;
      }
      this.#schedule();
    });
    return this.#inflight;
  }
  #schedule() {
    this.#clearTimer();
    if (this.#running !== true || this.#disposed) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = void 0;
      void this.refresh();
    }, this.#pollMs);
  }
  #clearTimer() {
    if (this.#timer !== void 0) this.#timers.clear(this.#timer);
    this.#timer = void 0;
  }
  dispose() {
    this.#disposed = true;
    this.#clearTimer();
    this.#listeners.clear();
  }
};

// packages/dsh-client/src/ui/ask-cards.tsx
var React2 = __toESM(require("react"), 1);

// packages/dsh-client/src/asks-model.ts
var KIND_VERB = {
  permission: "asks for permission",
  question: "asks you",
  plan: "has a plan",
  elicitation: "asks for input",
  trust: "asks whether you trust this folder"
};
function askHeading(ask, displayName) {
  if (ask.state === "waiting") return `${askWho(ask, displayName)} waits for you to finish in the browser`;
  return `${askWho(ask, displayName)} ${KIND_VERB[ask.kind] ?? "asks"}`;
}
function askTitle(ask) {
  const prefix = ask.agentLabel ? `${ask.agentLabel}: ` : void 0;
  return prefix && ask.title.startsWith(prefix) ? ask.title.slice(prefix.length) : ask.title;
}
var str = (v4) => typeof v4 === "string";
var rec = (v4) => typeof v4 === "object" && v4 !== null && !Array.isArray(v4);
function pathOf(o) {
  for (const k of ["file_path", "notebook_path", "path"]) if (str(o[k]) && o[k] !== "") return o[k];
  return void 0;
}
function prettyJson(v4) {
  try {
    return JSON.stringify(v4, null, 2) ?? String(v4);
  } catch {
    return String(v4);
  }
}
function permissionPreview(input) {
  if (input === void 0 || input === null) return void 0;
  if (!rec(input)) return { kind: "json", text: prettyJson(input) };
  const path = pathOf(input);
  const note = str(input.description) && input.description !== "" ? input.description : void 0;
  if (str(input.command)) return { kind: "command", text: input.command, ...note ? { note } : {} };
  if (str(input.old_string) && str(input.new_string)) {
    const lines = numberDiff(lineDiff(input.old_string, input.new_string));
    const all = input.replace_all === true ? "Every match is replaced." : void 0;
    return { kind: "diff", ...path ? { path } : {}, lines, ...all ? { note: all } : {} };
  }
  if (Array.isArray(input.edits) && input.edits.every((e) => rec(e) && str(e.old_string) && str(e.new_string))) {
    const lines = [];
    input.edits.forEach((e, i) => {
      if (i > 0) lines.push({ op: " ", text: "\u22EF" });
      lines.push(...numberDiff(lineDiff(e.old_string, e.new_string)));
    });
    return { kind: "diff", ...path ? { path } : {}, lines };
  }
  if (str(input.content) && path) {
    return {
      kind: "diff",
      path,
      lines: splitLines(input.content).map((text3, i) => ({ op: "+", text: text3, new: i + 1 })),
      note: "New file content."
    };
  }
  if (str(input.new_source)) {
    const mode = str(input.edit_mode) ? `Cell edit: ${input.edit_mode}.` : void 0;
    return {
      kind: "diff",
      ...path ? { path } : {},
      lines: splitLines(input.new_source).map((text3) => ({ op: "+", text: text3 })),
      ...mode ? { note: mode } : {}
    };
  }
  if (str(input.script) && input.script !== "") {
    const phases = scriptPhases(input.script);
    const parts = [
      ...str(input.name) && input.name !== "" ? [`Workflow: ${input.name}`] : [],
      ...phases.length > 0 ? [`Phases: ${phases.join(" \u2192 ")}`] : []
    ];
    return {
      kind: "text",
      label: "Script",
      text: input.script,
      ...parts.length > 0 ? { note: parts.join(" \xB7 ") } : {}
    };
  }
  if (str(input.url)) {
    const prompt = str(input.prompt) ? input.prompt : void 0;
    return { kind: "text", label: "URL", text: input.url, ...prompt ? { note: prompt } : {} };
  }
  return { kind: "json", text: prettyJson(input) };
}
function scriptPhases(script) {
  const out = [];
  const re = /\bphase\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)\s*[,)]/g;
  for (const m of script.matchAll(re)) {
    const title = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1").trim();
    if (title !== "" && !out.includes(title)) out.push(title);
    if (out.length >= 12) break;
  }
  return out;
}
function clipLines(lines, max, expanded) {
  if (expanded || lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, max), hidden: lines.length - max };
}
function permissionGroups(choices) {
  const allow = [];
  const always = [];
  const reject = [];
  for (const c of choices) {
    if (c.kind?.startsWith("reject")) reject.push(c);
    else if (c.kind === "allow-always" || c.destination !== void 0 || (c.effects?.length ?? 0) > 0) always.push(c);
    else allow.push(c);
  }
  return { allow, always, reject };
}
function editedAlwaysChoice(c, edited) {
  const e = c.editable;
  const next = edited?.trim();
  if (!e || next === void 0 || next === "" || next === e.value) return c;
  const from = `${e.toolName}(${e.value})`;
  const to = `${e.toolName}(${next})`;
  const swap = (t) => t.split(from).join(to);
  const out = { ...c, label: swap(c.label) };
  if (c.effects) out.effects = c.effects.map(swap);
  return out;
}
var emptyDraft = () => ({ picked: [], otherOn: false, other: "", note: "" });
function toggleOption(q2, d, label2) {
  if (q2.multiSelect) {
    const picked = d.picked.includes(label2) ? d.picked.filter((l) => l !== label2) : [...d.picked, label2];
    return { ...d, picked };
  }
  return { ...d, picked: [label2], otherOn: false };
}
function toggleOther(q2, d, on) {
  return q2.multiSelect ? { ...d, otherOn: on } : { ...d, otherOn: on, picked: on ? [] : d.picked };
}
function draftAnswer(q2, d) {
  const other = d.otherOn && q2.allowsOther && d.other.trim() !== "" ? d.other.trim() : void 0;
  if (q2.multiSelect) {
    const all = [...d.picked.filter((l) => q2.options.some((o) => o.label === l)), ...other ? [other] : []];
    return all.length > 0 ? all : void 0;
  }
  if (other) return other;
  const label2 = d.picked[0];
  return label2 !== void 0 && q2.options.some((o) => o.label === label2) ? label2 : void 0;
}
function questionReply(questions, drafts) {
  const answers = {};
  const notes = {};
  const missing = [];
  questions.forEach((q2, i) => {
    const d = drafts[i] ?? emptyDraft();
    const a = draftAnswer(q2, d);
    if (a === void 0) missing.push(q2.question);
    else answers[q2.question] = a;
    if (d.note.trim() !== "") notes[q2.question] = d.note.trim();
  });
  return Object.keys(notes).length > 0 ? { answers, notes, missing } : { answers, missing };
}
function questionPreview(q2, d, focused) {
  if (q2.multiSelect) return void 0;
  const by = (label2) => q2.options.find((o) => o.label === label2)?.preview;
  return by(focused) ?? by(d.picked[0]) ?? q2.options.find((o) => o.preview !== void 0)?.preview;
}
var FORMAT_INPUT = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local"
};
function enumOptions(s2) {
  if (Array.isArray(s2.enum)) {
    const names = Array.isArray(s2.enumNames) ? s2.enumNames : [];
    return s2.enum.filter(str).map((v4, i) => ({ value: v4, label: str(names[i]) ? names[i] : v4 }));
  }
  for (const k of ["oneOf", "anyOf"])
    if (Array.isArray(s2[k]))
      return s2[k].filter((o) => rec(o) && str(o.const)).map((o) => ({ value: o.const, label: str(o.title) ? o.title : o.const }));
  return void 0;
}
function elicitationFields(schema) {
  if (!rec(schema) || !rec(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(str) : []);
  return Object.entries(schema.properties).map(([key, raw]) => {
    const s2 = rec(raw) ? raw : {};
    const f = {
      key,
      title: str(s2.title) && s2.title !== "" ? s2.title : key,
      required: required.has(key),
      kind: "text",
      inputType: "text",
      options: []
    };
    if (str(s2.description) && s2.description !== "") f.description = s2.description;
    const opts = enumOptions(s2);
    if (s2.type === "array") {
      const items = rec(s2.items) ? s2.items : {};
      f.kind = "multi";
      f.options = enumOptions(items) ?? [];
      if (Array.isArray(s2.default)) f.default = s2.default.filter(str);
    } else if (opts) {
      f.kind = "select";
      f.options = opts;
      if (str(s2.default)) f.default = s2.default;
    } else if (s2.type === "boolean") {
      f.kind = "boolean";
      if (typeof s2.default === "boolean") f.default = s2.default;
    } else if (s2.type === "number" || s2.type === "integer") {
      f.kind = s2.type;
      if (typeof s2.default === "number") f.default = String(s2.default);
    } else {
      if (str(s2.format) && FORMAT_INPUT[s2.format]) f.inputType = FORMAT_INPUT[s2.format];
      if (str(s2.default)) f.default = s2.default;
    }
    for (const k of ["minimum", "maximum", "minLength", "maxLength"]) {
      const v4 = s2[k];
      if (typeof v4 !== "number") continue;
      if (k === "minimum") f.min = v4;
      else if (k === "maximum") f.max = v4;
      else f[k] = v4;
    }
    return f;
  });
}
function initialValues(fields) {
  const out = {};
  for (const f of fields) out[f.key] = f.default ?? (f.kind === "boolean" ? false : f.kind === "multi" ? [] : "");
  return out;
}
function elicitationContent(fields, values) {
  const content = {};
  for (const f of fields) {
    const v4 = values[f.key];
    if (f.kind === "boolean") {
      if (v4 === true || f.required || f.default !== void 0) content[f.key] = v4 === true;
      continue;
    }
    if (f.kind === "multi") {
      const list = Array.isArray(v4) ? v4 : [];
      if (list.length === 0) {
        if (f.required) return { error: `${f.title} is required` };
        continue;
      }
      content[f.key] = [...list];
      continue;
    }
    const text3 = str(v4) ? v4.trim() : "";
    if (text3 === "") {
      if (f.required) return { error: `${f.title} is required` };
      continue;
    }
    if (f.kind === "number" || f.kind === "integer") {
      const n2 = Number(text3);
      if (!Number.isFinite(n2)) return { error: `${f.title} must be a number` };
      if (f.kind === "integer" && !Number.isInteger(n2)) return { error: `${f.title} must be a whole number` };
      if (f.min !== void 0 && n2 < f.min) return { error: `${f.title} must be at least ${f.min}` };
      if (f.max !== void 0 && n2 > f.max) return { error: `${f.title} must be at most ${f.max}` };
      content[f.key] = n2;
      continue;
    }
    if (f.kind === "select" && !f.options.some((o) => o.value === text3))
      return { error: `Pick a value for ${f.title}` };
    if (f.minLength !== void 0 && text3.length < f.minLength)
      return { error: `${f.title} needs at least ${f.minLength} characters` };
    if (f.maxLength !== void 0 && text3.length > f.maxLength)
      return { error: `${f.title} takes at most ${f.maxLength} characters` };
    content[f.key] = text3;
  }
  return { content };
}
function safeHttpUrl(url) {
  if (url === void 0) return void 0;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : void 0;
  } catch {
    return void 0;
  }
}
function parseInline(text3) {
  const out = [];
  let plain2 = "";
  const flush = () => {
    if (plain2 !== "") out.push({ t: "text", text: plain2 });
    plain2 = "";
  };
  let i = 0;
  while (i < text3.length) {
    const rest = text3.slice(i);
    let m;
    if (m = /^`([^`]+)`/.exec(rest)) {
      flush();
      out.push({ t: "code", text: m[1] });
      i += m[0].length;
    } else if ((m = /^\*\*(.+?)\*\*/.exec(rest)) || (m = /^__(.+?)__/.exec(rest))) {
      flush();
      out.push({ t: "strong", children: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\*(?!\s)(.+?)\*/.exec(rest)) || !/[A-Za-z0-9]/.test(text3[i - 1] ?? "") && (m = /^_(?!\s)(.+?)_(?![A-Za-z0-9])/.exec(rest))) {
      flush();
      out.push({ t: "em", children: parseInline(m[1]) });
      i += m[0].length;
    } else if (m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)) {
      flush();
      const href = safeHttpUrl(m[2]);
      out.push({ t: "link", ...href ? { href } : {}, children: parseInline(m[1]) });
      i += m[0].length;
    } else {
      plain2 += text3[i];
      i++;
    }
  }
  flush();
  return out;
}
var tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
function parseMarkdown(text3) {
  const lines = text3.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length > 0) out.push({ t: "paragraph", children: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (m = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line)) {
      flushPara();
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      out.push({ t: "code", ...m[2] ? { lang: m[2] } : {}, text: body.join("\n") });
    } else if (m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)) {
      flushPara();
      out.push({ t: "heading", level: m[1].length, children: parseInline(m[2]) });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push({ t: "rule" });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const indent = /^(\s*)/.exec(lines[i])[1].length;
        items.push(parseInline(indent > 0 ? `${"\xA0".repeat(Math.min(indent, 8))}${item}` : item));
        i++;
      }
      i--;
      out.push({ t: "list", ordered, items });
    } else if (/^\s*>/.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      out.push({ t: "quote", children: parseInline(body.join(" ")) });
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flushPara();
      const rows = [tableCells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      out.push({ t: "table", rows });
    } else if (line.trim() === "") flushPara();
    else para.push(line.trim());
  }
  flushPara();
  return out;
}
function numberedChoices(ask) {
  if (ask.state === "waiting") return [];
  if (ask.kind === "permission") {
    const g = permissionGroups(ask.choices);
    return [...g.allow, ...g.always, ...g.reject];
  }
  if (ask.kind === "plan") {
    const keep = ask.choices.find((c) => c.feedback);
    return [...ask.choices.filter((c) => c !== keep), ...keep ? [keep] : []];
  }
  if (ask.kind === "question" || ask.kind === "elicitation") return [];
  return ask.choices.filter((c) => c.submits === void 0);
}
function cardKey(ask, key, mods) {
  if (mods.modified) return void 0;
  if (key === "Escape") {
    if (mods.inText || ask.state === "waiting") return void 0;
    const stop = ask.choices.find((c) => c.id === ask.stopChoice && c.submits === void 0);
    return stop ? { type: "choose", choice: stop } : void 0;
  }
  if (mods.inText) return void 0;
  if (key === "ArrowDown") return { type: "move", by: 1 };
  if (key === "ArrowUp") return { type: "move", by: -1 };
  if (/^[1-9]$/.test(key)) {
    const c = numberedChoices(ask)[Number(key) - 1];
    return c ? { type: "choose", choice: c } : void 0;
  }
  return void 0;
}

// packages/dsh-client/src/ui/markdown.tsx
var React = __toESM(require("react"), 1);

// packages/dsh-client/src/ui/style.ts
var v = (name2, alias, fallback) => `var(--raw-agent-${name2}, var(--dsw-alias-${alias}, ${fallback}))`;
var surface = v("surface", "bg-layer-1", "Canvas");
var text = v("text", "label-primary", "CanvasText");
var muted = v("muted", "label-secondary", "GrayText");
var border = v("border", "border-l2", "rgba(128,128,128,0.35)");
var css = {
  // `flex: 1 1 0%` + `minWidth: 0`: the bar takes the space left in DSH's composer tool row and
  // wraps inside it, so DSH's own items (the mode seat) keep their width and are never drawn over
  // our buttons (live M1: the seat label covered an ask's first button).
  bar: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flexWrap: "wrap",
    font: "inherit",
    flex: "1 1 0%",
    minWidth: 0
  },
  select: {
    font: "inherit",
    fontSize: 12,
    maxWidth: 220,
    color: text,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: "1px 4px"
  },
  button: {
    font: "inherit",
    fontSize: 12,
    color: text,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: "1px 6px",
    cursor: "pointer"
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1e3,
    background: "rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  dialog: {
    background: surface,
    color: text,
    border: `1px solid ${border}`,
    borderRadius: 10,
    width: "min(760px, 94vw)",
    maxHeight: "86vh",
    overflow: "auto",
    padding: 16,
    fontSize: 13
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  hint: { color: muted, fontSize: 12, margin: "6px 0" },
  error: { color: v("danger", "state-error-primary", "#c0392b"), fontSize: 12, margin: "6px 0" },
  file: { borderTop: `1px solid ${border}`, padding: "10px 0" },
  fileHead: { display: "flex", justifyContent: "space-between" },
  path: { fontSize: 12, wordBreak: "break-all", color: muted },
  badge: { fontSize: 11, color: muted, border: `1px solid ${border}`, borderRadius: 4, padding: "0 4px" },
  row: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 },
  pre: {
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 8,
    margin: "8px 0 0",
    maxHeight: 360,
    overflow: "auto"
  },
  secret: {
    font: "inherit",
    color: "inherit",
    background: v("secret", "markdown-code-block", "rgba(128,128,128,0.2)"),
    border: "none",
    borderRadius: 3,
    padding: "0 2px",
    cursor: "pointer"
  },
  status: { fontSize: 11, color: muted },
  // The inline cards (no composer takeover): a full row of the controls bar.
  ask: { display: "block", flexBasis: "100%", minWidth: 0 },
  askDetail: {
    fontSize: 11,
    color: muted,
    maxWidth: 480,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  // Interaction cards (D39-D43). They take over the composer, so they size to its width and
  // scroll inside themselves; nothing is clipped without a "Show all" control.
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    color: text,
    background: surface,
    border: `1px solid ${v("ask-border", "state-warn-primary", "orange")}`,
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    maxHeight: "70vh",
    overflow: "auto",
    boxSizing: "border-box",
    width: "100%"
  },
  cardHead: { display: "flex", flexDirection: "column", gap: 2 },
  cardWho: { fontSize: 12, color: muted },
  cardTitle: { fontWeight: 600, wordBreak: "break-word", whiteSpace: "pre-wrap" },
  cardNote: { fontSize: 12, color: muted, wordBreak: "break-word", whiteSpace: "pre-wrap" },
  cardError: { fontSize: 12, color: v("danger", "state-error-primary", "#c0392b") },
  choiceRow: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" },
  choiceCol: { display: "flex", flexDirection: "column", gap: 6 },
  primary: {
    font: "inherit",
    fontSize: 12,
    color: v("on-accent", "label-primary-foreground", "HighlightText"),
    background: v("accent", "button-primary-fill", "Highlight"),
    border: `1px solid ${v("accent", "button-primary-fill", "Highlight")}`,
    borderRadius: 6,
    padding: "3px 10px",
    cursor: "pointer",
    textAlign: "left"
  },
  choice: {
    font: "inherit",
    fontSize: 12,
    color: text,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: "3px 10px",
    cursor: "pointer",
    textAlign: "left",
    textDecoration: "none",
    display: "inline-block"
  },
  always: { display: "flex", flexDirection: "column", gap: 2, maxWidth: "100%" },
  effects: { fontSize: 11, color: muted, margin: "0 0 0 12px", padding: 0, wordBreak: "break-word" },
  previewBox: {
    fontFamily: "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 8,
    margin: 0,
    overflow: "auto"
  },
  diffAdd: { background: v("diff-add", "code-diff-added", "rgba(46,160,67,0.18)") },
  diffDel: { background: v("diff-del", "code-diff-deleted", "rgba(248,81,73,0.18)") },
  diffGap: { color: muted },
  diffNum: { color: muted, userSelect: "none", whiteSpace: "pre" },
  textarea: {
    font: "inherit",
    fontSize: 12,
    color: text,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 6,
    minHeight: 36,
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical"
  },
  input: {
    font: "inherit",
    fontSize: 12,
    color: text,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: "3px 6px",
    boxSizing: "border-box",
    maxWidth: "100%"
  },
  question: { display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${border}`, paddingTop: 8 },
  questionBody: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" },
  options: { display: "flex", flexDirection: "column", gap: 4, flex: "1 1 220px", minWidth: 0 },
  option: { display: "flex", gap: 6, alignItems: "flex-start", cursor: "pointer" },
  optionDesc: { display: "block", fontSize: 11, color: muted },
  questionPreview: { flex: "1 1 260px", minWidth: 0, maxHeight: 320 },
  chip: {
    fontSize: 11,
    color: muted,
    border: `1px solid ${border}`,
    borderRadius: 4,
    padding: "0 4px",
    alignSelf: "flex-start"
  },
  field: { display: "flex", flexDirection: "column", gap: 2 },
  /** A boolean field: the box sits at the start of its label, not stretched across the row. */
  fieldCheck: { display: "flex", flexDirection: "row", gap: 6, alignItems: "center", cursor: "pointer" },
  checkbox: { margin: 0, flex: "none", alignSelf: "center" },
  /** The number key of a choice, before its label. */
  keyHint: { opacity: 0.6, marginRight: 6, fontVariantNumeric: "tabular-nums" },
  link: { color: v("link", "link", "LinkText"), wordBreak: "break-all" },
  url: { fontSize: 12, wordBreak: "break-all", whiteSpace: "pre-wrap" },
  more: { display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11, color: muted, alignItems: "center" },
  inlineCode: {
    fontFamily: "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: "0.92em",
    background: v("code-bg", "markdown-code-block", "rgba(128,128,128,0.15)"),
    borderRadius: 3,
    padding: "0 3px"
  },
  mdHeading: { fontWeight: 600, margin: "8px 0 4px" },
  mdBlock: { margin: "4px 0", lineHeight: 1.45 },
  mdList: { margin: "4px 0", paddingLeft: 20, lineHeight: 1.45 },
  mdCode: {
    fontFamily: "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background: v("code-bg", "markdown-code-block", "rgba(128,128,128,0.12)"),
    borderRadius: 6,
    padding: 8,
    margin: "6px 0"
  },
  mdQuote: { margin: "4px 0", paddingLeft: 10, borderLeft: `3px solid ${border}`, color: muted },
  mdRule: { border: "none", borderTop: `1px solid ${border}`, margin: "8px 0" },
  mdTable: { borderCollapse: "collapse", margin: "6px 0", fontSize: 12 },
  mdCell: { border: `1px solid ${border}`, padding: "2px 6px", textAlign: "left", verticalAlign: "top" }
};
var CHIP_CLASS = "raw-agent-chip";
var STATUS_CLASS = "raw-agent-status";
var tok = (name2, alias, fallback) => `var(--raw-agent-${name2}, var(--dsw-alias-${alias}, ${fallback}))`;
var riskTone = {
  plan: tok("chip-plan", "state-business-primary", "#4176e6"),
  caution: tok("chip-caution", "state-warn-primary", "#f59e0b"),
  danger: tok("chip-danger", "state-error-primary", "#ec1313")
};
var label = "var(--dsw-alias-label-primary, CanvasText)";
var riskRule = (risk, textShare, fill) => `.${CHIP_CLASS}[data-risk="${risk}"]{color:color-mix(in srgb, ${riskTone[risk]} ${textShare}%, ${label});background:color-mix(in srgb, ${riskTone[risk]} ${fill}%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, ${riskTone[risk]} 40%, transparent)}`;
var CHIP_CSS = [
  `.${CHIP_CLASS}{position:relative;display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;max-width:220px;min-width:0;padding:1px 8px;border:none;border-radius:var(--raw-agent-chip-radius, var(--dsw-radius-sm, 8px));background:transparent;color:${tok("chip-text", "label-tertiary", "GrayText")};font:inherit;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px));white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}`,
  `.${CHIP_CLASS}:hover,.${CHIP_CLASS}:focus-within{background:${tok("chip-hover", "interactive-bg-hover", "rgba(128,128,128,0.15)")};color:${tok("chip-text-hover", "label-secondary", "CanvasText")}}`,
  `.${CHIP_CLASS}:focus-visible,.${CHIP_CLASS}:has(select:focus-visible){outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));outline-offset:1px}`,
  `.${CHIP_CLASS}[data-disabled]{opacity:.55;cursor:default}`,
  `.${CHIP_CLASS} select{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:inherit;font:inherit;color:CanvasText;background:Canvas;border:none;appearance:none}`,
  `.${CHIP_CLASS} [data-chip-text]{overflow:hidden;text-overflow:ellipsis;min-width:0}`,
  `.${CHIP_CLASS} [data-chip-dot]{flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.55}`,
  `.${CHIP_CLASS} svg{flex:none;width:10px;height:10px;opacity:.7}`,
  `.${CHIP_CLASS}[data-session-mode]{font-weight:600;color:color-mix(in srgb, ${tok("chip-session-mode", "state-done-primary", "#7c3aed")} 70%, ${label})}`,
  riskRule("plan", 75, 12),
  riskRule("caution", 55, 16),
  riskRule("danger", 70, 14),
  // The status line: shown, then faded out of the row; screen readers still have it (aria-live).
  `.${STATUS_CLASS}{font-size:11px;color:${tok("muted", "label-tertiary", "GrayText")};transition:opacity .4s ease}`,
  `.${STATUS_CLASS}[data-level="error"]{color:${tok("danger", "state-error-primary", "#c0392b")}}`,
  `.${STATUS_CLASS}[data-fading]{opacity:0}`,
  `.${STATUS_CLASS}[data-faded]{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;opacity:0}`
].join("\n");

// packages/dsh-client/src/ui/markdown.tsx
function inline(nodes, key = "") {
  return nodes.map((n2, i) => {
    const k = `${key}${i}`;
    switch (n2.t) {
      case "text":
        return /* @__PURE__ */ React.createElement(React.Fragment, { key: k }, n2.text);
      case "code":
        return /* @__PURE__ */ React.createElement("code", { key: k, style: css.inlineCode }, n2.text);
      case "strong":
        return /* @__PURE__ */ React.createElement("strong", { key: k }, inline(n2.children, `${k}.`));
      case "em":
        return /* @__PURE__ */ React.createElement("em", { key: k }, inline(n2.children, `${k}.`));
      case "link":
        return n2.href ? /* @__PURE__ */ React.createElement("a", { key: k, href: n2.href, target: "_blank", rel: "noopener noreferrer", style: css.link }, inline(n2.children, `${k}.`)) : /* @__PURE__ */ React.createElement("span", { key: k }, inline(n2.children, `${k}.`));
    }
  });
}
function block(b, i) {
  switch (b.t) {
    case "heading": {
      const size = [0, 16, 15, 14, 13, 13, 13][b.level] ?? 13;
      return /* @__PURE__ */ React.createElement("div", { key: i, role: "heading", "aria-level": b.level, style: { ...css.mdHeading, fontSize: size } }, inline(b.children));
    }
    case "paragraph":
      return /* @__PURE__ */ React.createElement("p", { key: i, style: css.mdBlock }, inline(b.children));
    case "list": {
      const items = b.items.map((it, j) => /* @__PURE__ */ React.createElement("li", { key: j }, inline(it, `${j}.`)));
      return b.ordered ? /* @__PURE__ */ React.createElement("ol", { key: i, style: css.mdList }, items) : /* @__PURE__ */ React.createElement("ul", { key: i, style: css.mdList }, items);
    }
    case "code":
      return /* @__PURE__ */ React.createElement("pre", { key: i, style: css.mdCode, "data-lang": b.lang }, b.text);
    case "quote":
      return /* @__PURE__ */ React.createElement("blockquote", { key: i, style: css.mdQuote }, inline(b.children));
    case "rule":
      return /* @__PURE__ */ React.createElement("hr", { key: i, style: css.mdRule });
    case "table":
      return /* @__PURE__ */ React.createElement("table", { key: i, style: css.mdTable }, /* @__PURE__ */ React.createElement("tbody", null, b.rows.map((row, r) => /* @__PURE__ */ React.createElement("tr", { key: r }, row.map(
        (cell, c) => r === 0 ? /* @__PURE__ */ React.createElement("th", { key: c, style: css.mdCell }, inline(cell, `${r}.${c}.`)) : /* @__PURE__ */ React.createElement("td", { key: c, style: css.mdCell }, inline(cell, `${r}.${c}.`))
      )))));
  }
}
function Markdown(props) {
  const blocks = React.useMemo(() => parseMarkdown(props.text), [props.text]);
  return /* @__PURE__ */ React.createElement("div", { "data-raw-agent": props.testId ?? "markdown" }, blocks.map(block));
}

// packages/dsh-client/src/ui/ask-cards.tsx
var PREVIEW_LINES = 40;
var formOf = (ask, type) => ask.form?.type === type ? ask.form : void 0;
var KeyHint = React2.createContext(() => void 0);
function Button(props) {
  const n2 = React2.useContext(KeyHint)(props.choice);
  return /* @__PURE__ */ React2.createElement(
    "button",
    {
      type: "button",
      style: props.primary ? css.primary : css.choice,
      disabled: props.disabled,
      autoFocus: props.autoFocus,
      "data-raw-agent": "ask-choice",
      "data-choice": props.choice.id,
      ...n2 !== void 0 ? { "aria-keyshortcuts": String(n2), title: `Key ${n2}` } : {},
      onClick: props.onClick
    },
    n2 !== void 0 && /* @__PURE__ */ React2.createElement("span", { style: css.keyHint }, n2),
    props.choice.label
  );
}
function isTextTarget(t) {
  const tag = t?.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(String(t?.type ?? "text"));
}
function onCardKey(ask, e) {
  const k = cardKey(ask, e.key, {
    inText: isTextTarget(e.target),
    modified: e.ctrlKey || e.metaKey || e.altKey
  });
  if (!k) return;
  const root = e.currentTarget;
  const buttons = Array.from(root.querySelectorAll('[data-raw-agent="ask-choice"]')).filter((b) => !b.disabled);
  if (k.type === "choose") {
    const b = buttons.find((x) => x.getAttribute("data-choice") === k.choice.id);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    b.click();
    return;
  }
  if (buttons.length === 0) return;
  const active = globalThis.document?.activeElement ?? null;
  const at = active ? buttons.indexOf(active) : -1;
  const next = buttons[(at + k.by + buttons.length) % buttons.length] ?? buttons[0];
  e.preventDefault();
  next.focus();
}
function Clipped(props) {
  const [all, setAll] = React2.useState(false);
  const [copied, setCopied] = React2.useState(false);
  const { shown, hidden } = clipLines(props.lines, PREVIEW_LINES, all);
  return /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement("pre", { style: css.previewBox, "data-raw-agent": props.testId }, shown), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, hidden > 0 && /* @__PURE__ */ React2.createElement("button", { type: "button", style: css.button, "data-raw-agent": "show-all", onClick: () => setAll(true) }, "Show all (", hidden, " more ", hidden === 1 ? "line" : "lines", ")"), all && props.lines.length > PREVIEW_LINES && /* @__PURE__ */ React2.createElement("button", { type: "button", style: css.button, onClick: () => setAll(false) }, "Show less"), /* @__PURE__ */ React2.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      onClick: () => void props.actions.copy(props.copyText).then((ok) => setCopied(ok))
    },
    copied ? "Copied" : "Copy"
  )));
}
function plainLines(text3) {
  const lines = splitLines(text3);
  return (lines.length > 0 ? lines : [""]).map((l, i) => /* @__PURE__ */ React2.createElement("div", { key: i }, l === "" ? "\xA0" : l));
}
function PreviewView(props) {
  const { preview: p, actions } = props;
  const [full, setFull] = React2.useState(false);
  if (p.kind === "diff") {
    const changed = p.lines.some((l) => l.op !== " ");
    const hunks = full || !changed ? p.lines : diffHunks(p.lines);
    const folded = hunks.length < p.lines.length;
    const numbered = p.lines.some((l) => l.old !== void 0 || l.new !== void 0);
    const width = String(p.lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length;
    const rows = hunks.map(
      (l, i) => l.op === "\u2026" ? /* @__PURE__ */ React2.createElement("div", { key: i, style: css.diffGap }, `\u22EF ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}`) : /* @__PURE__ */ React2.createElement("div", { key: i, style: l.op === "+" ? css.diffAdd : l.op === "-" ? css.diffDel : void 0, "data-op": l.op }, numbered && /* @__PURE__ */ React2.createElement("span", { style: css.diffNum, "data-raw-agent": "diff-num", "aria-hidden": "true" }, `${l.old ?? ""}`.padStart(width), " ", `${l.new ?? ""}`.padStart(width), " "), `${l.op} ${l.text}`)
    );
    return /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, p.path && /* @__PURE__ */ React2.createElement("span", { style: css.path }, p.path), p.note && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, p.note), /* @__PURE__ */ React2.createElement(Clipped, { lines: rows, copyText: diffText(p.lines), actions, testId: "preview-diff" }), (folded || full) && changed && /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement("button", { type: "button", style: css.button, onClick: () => setFull(!full) }, full ? "Show only the changes" : "Show the whole text")));
  }
  if (p.kind === "command")
    return /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement(Clipped, { lines: plainLines(p.text), copyText: p.text, actions, testId: "preview-command" }), p.note && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, p.note));
  if (p.kind === "text")
    return /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, p.label), /* @__PURE__ */ React2.createElement(Clipped, { lines: plainLines(p.text), copyText: p.text, actions, testId: "preview-text" }), p.note && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, p.note));
  return /* @__PURE__ */ React2.createElement(Clipped, { lines: plainLines(p.text), copyText: p.text, actions, testId: "preview-json" });
}
function Feedback(props) {
  return /* @__PURE__ */ React2.createElement(
    "textarea",
    {
      style: css.textarea,
      value: props.value,
      placeholder: props.placeholder,
      "aria-label": props.placeholder ?? "Feedback",
      "data-raw-agent": props.testId ?? "feedback",
      onChange: (e) => props.onChange(e.currentTarget.value)
    }
  );
}
function ToolCallLink(props) {
  const { callId, actions } = props;
  const [found, setFound] = React2.useState(false);
  React2.useEffect(() => {
    if (!callId || !actions.markToolCall) return void 0;
    let mark = actions.markToolCall(callId, "Waiting for your approval");
    setFound(mark.found);
    const timer = setInterval(() => {
      if (mark.found) return;
      mark.undo();
      mark = actions.markToolCall(callId, "Waiting for your approval");
      setFound(mark.found);
    }, 1e3);
    return () => {
      clearInterval(timer);
      mark.undo();
    };
  }, [callId, actions]);
  if (!callId || !found || !actions.revealToolCall) return null;
  return /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "reveal-tool-call",
      onClick: () => actions.revealToolCall?.(callId)
    },
    "Show the tool call"
  ));
}
function PermissionBody(props) {
  const { ask, actions, busy, onAnswer } = props;
  const form = formOf(ask, "permission");
  const [feedback, setFeedback] = React2.useState("");
  const [rules, setRules] = React2.useState({});
  const groups = permissionGroups(ask.choices);
  const preview = React2.useMemo(() => permissionPreview(form?.input), [form?.input]);
  const reject = groups.reject.find((c) => c.feedback) ?? groups.reject[0];
  const noFirst = form?.defaultToNo === true;
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, form?.mcpServer && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "MCP server: ", form.mcpServer.name, " (", form.mcpServer.source, ")"), form?.reason && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Why it asks: ", form.reason), form?.blockedPath && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Path: ", form.blockedPath), preview ? /* @__PURE__ */ React2.createElement(PreviewView, { preview, actions }) : ask.detail && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, ask.detail), form?.description && preview?.kind !== "command" && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, form.description), form?.inputTruncated && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "The tool input is too large to show here (over 512 KB). The agent's terminal app shows it."), /* @__PURE__ */ React2.createElement(ToolCallLink, { ...ask.callId ? { callId: ask.callId } : {}, actions }), /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, groups.allow.map((c, i) => /* @__PURE__ */ React2.createElement(
    Button,
    {
      key: c.id,
      choice: c,
      primary: i === 0 && !noFirst,
      autoFocus: i === 0 && !noFirst,
      disabled: busy,
      onClick: () => onAnswer({ choice: c.id })
    }
  ))), groups.always.map((original) => {
    const c = editedAlwaysChoice(original, rules[original.id]);
    return /* @__PURE__ */ React2.createElement("span", { key: c.id, style: css.always, "data-raw-agent": "always" }, /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement(
      Button,
      {
        choice: c,
        disabled: busy || c.editable !== void 0 && (rules[c.id] ?? c.editable.value).trim() === "",
        onClick: () => {
          const edited = c.editable ? (rules[c.id] ?? c.editable.value).trim() : void 0;
          onAnswer(
            c.editable && edited !== void 0 && edited !== c.editable.value ? { choice: c.id, rule: edited } : { choice: c.id }
          );
        }
      }
    )), c.editable && /* @__PURE__ */ React2.createElement("label", { style: css.choiceRow }, /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Don't ask again for: ", c.editable.toolName, "("), /* @__PURE__ */ React2.createElement(
      "input",
      {
        type: "text",
        style: { ...css.input, minWidth: "16em" },
        value: rules[c.id] ?? c.editable.value,
        placeholder: c.editable.placeholder,
        "aria-label": c.editable.placeholder ?? "Rule",
        "data-raw-agent": "always-rule",
        onChange: (e) => {
          const v4 = e.currentTarget.value;
          setRules((all) => ({ ...all, [c.id]: v4 }));
        }
      }
    ), /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, ")")), c.destination && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote, "data-raw-agent": "always-destination" }, "Saved to: ", c.destination), (c.effects?.length ?? 0) > 0 && /* @__PURE__ */ React2.createElement("ul", { style: css.effects }, c.effects.map((e, i) => /* @__PURE__ */ React2.createElement("li", { key: i }, e))));
  }), reject?.feedback && /* @__PURE__ */ React2.createElement(
    Feedback,
    {
      value: feedback,
      onChange: setFeedback,
      ...reject.feedbackPlaceholder ? { placeholder: reject.feedbackPlaceholder } : {}
    }
  ), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, groups.reject.map((c) => /* @__PURE__ */ React2.createElement(
    Button,
    {
      key: c.id,
      choice: c,
      primary: noFirst && c === reject,
      autoFocus: noFirst && c === reject,
      disabled: busy,
      onClick: () => onAnswer(c.feedback && feedback.trim() !== "" ? { choice: c.id, feedback } : { choice: c.id })
    }
  )))));
}
function QuestionView(props) {
  const { q: q2, draft, index } = props;
  const [focused, setFocused] = React2.useState();
  const [noteOpen, setNoteOpen] = React2.useState(draft.note !== "");
  const preview = questionPreview(q2, draft, focused);
  const name2 = `raw-agent-q-${index}`;
  return /* @__PURE__ */ React2.createElement("div", { style: css.question, "data-raw-agent": "question", "data-question": q2.question }, q2.header && /* @__PURE__ */ React2.createElement("span", { style: css.chip }, q2.header), /* @__PURE__ */ React2.createElement("span", { style: css.cardTitle }, q2.question), q2.multiSelect && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Pick one or more."), /* @__PURE__ */ React2.createElement("div", { style: css.questionBody }, /* @__PURE__ */ React2.createElement("div", { style: css.options, role: q2.multiSelect ? "group" : "radiogroup", "aria-label": q2.question }, q2.options.map((o) => /* @__PURE__ */ React2.createElement(
    "label",
    {
      key: o.label,
      style: css.option,
      onMouseEnter: () => setFocused(o.label),
      onFocus: () => setFocused(o.label)
    },
    /* @__PURE__ */ React2.createElement(
      "input",
      {
        type: q2.multiSelect ? "checkbox" : "radio",
        name: name2,
        checked: draft.picked.includes(o.label),
        "data-raw-agent": "question-option",
        onChange: () => props.onChange(toggleOption(q2, draft, o.label))
      }
    ),
    /* @__PURE__ */ React2.createElement("span", null, o.label, o.description && /* @__PURE__ */ React2.createElement("span", { style: css.optionDesc }, o.description))
  )), q2.allowsOther && /* @__PURE__ */ React2.createElement("label", { style: css.option }, /* @__PURE__ */ React2.createElement(
    "input",
    {
      type: q2.multiSelect ? "checkbox" : "radio",
      name: name2,
      checked: draft.otherOn,
      "data-raw-agent": "question-other",
      onChange: (e) => props.onChange(toggleOther(q2, draft, q2.multiSelect ? e.currentTarget.checked : true))
    }
  ), /* @__PURE__ */ React2.createElement("span", { style: { flex: 1 } }, props.otherLabel, draft.otherOn && /* @__PURE__ */ React2.createElement(
    "input",
    {
      type: "text",
      style: { ...css.input, display: "block", width: "100%", marginTop: 2 },
      value: draft.other,
      "aria-label": `${props.otherLabel}: ${q2.question}`,
      "data-raw-agent": "question-other-text",
      autoFocus: true,
      onChange: (e) => props.onChange({ ...draft, other: e.currentTarget.value })
    }
  )))), preview !== void 0 && /* @__PURE__ */ React2.createElement("div", { style: { ...css.previewBox, ...css.questionPreview }, "data-raw-agent": "question-preview" }, props.previewFormat === "markdown" ? /* @__PURE__ */ React2.createElement(Markdown, { text: preview, testId: "preview-markdown" }) : preview)), noteOpen ? /* @__PURE__ */ React2.createElement(
    Feedback,
    {
      value: draft.note,
      placeholder: "Notes for this answer (optional)",
      testId: "question-note",
      onChange: (note) => props.onChange({ ...draft, note })
    }
  ) : /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement("button", { type: "button", style: css.button, onClick: () => setNoteOpen(true) }, "Add a note")));
}
function QuestionBody(props) {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, "question");
  const questions = form?.questions ?? [];
  const [drafts, setDrafts] = React2.useState(() => questions.map(() => emptyDraft()));
  const reply = questionReply(questions, drafts);
  const submit = ask.choices.find((c) => c.submits === "answers" && !c.partial);
  const chat = ask.choices.find((c) => c.submits === "answers" && c.partial);
  const others = ask.choices.filter((c) => c.submits === void 0 && !/^option-\d+$/.test(c.id));
  const answered = Object.keys(reply.answers).length;
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, questions.map((q2, i) => /* @__PURE__ */ React2.createElement(
    QuestionView,
    {
      key: `${i}:${q2.question}`,
      q: q2,
      index: i,
      draft: drafts[i] ?? emptyDraft(),
      otherLabel: form?.otherLabel ?? "Other",
      previewFormat: form?.previewFormat ?? "markdown",
      onChange: (d) => setDrafts((all) => all.map((x, j) => j === i ? d : x))
    }
  )), answered > 0 && reply.missing.length > 0 && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Not answered yet: ", reply.missing.join(" / ")), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, submit && /* @__PURE__ */ React2.createElement(
    Button,
    {
      choice: submit,
      primary: true,
      disabled: busy || answered === 0,
      onClick: () => onAnswer({
        choice: submit.id,
        answers: reply.answers,
        ...reply.notes ? { notes: reply.notes } : {}
      })
    }
  ), chat && /* @__PURE__ */ React2.createElement(
    Button,
    {
      choice: chat,
      disabled: busy,
      onClick: () => onAnswer({ choice: chat.id, answers: reply.answers, ...reply.notes ? { notes: reply.notes } : {} })
    }
  ), others.map((c) => /* @__PURE__ */ React2.createElement(Button, { key: c.id, choice: c, disabled: busy, onClick: () => onAnswer({ choice: c.id }) }))));
}
function PlanBody(props) {
  const { ask, actions, sessionId, busy, onAnswer } = props;
  const form = formOf(ask, "plan");
  const [feedback, setFeedback] = React2.useState("");
  const [open, setOpen] = React2.useState(false);
  const keep = ask.choices.find((c) => c.feedback);
  const approve = ask.choices.filter((c) => c !== keep);
  const plan = form?.plan ?? ask.detail ?? "";
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement(
    "div",
    {
      style: { ...css.previewBox, fontFamily: "inherit", ...open ? {} : { maxHeight: "40vh" } },
      "data-raw-agent": "plan"
    },
    /* @__PURE__ */ React2.createElement(Markdown, { text: plan, testId: "plan-markdown" })
  ), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, /* @__PURE__ */ React2.createElement("button", { type: "button", style: css.button, onClick: () => setOpen(!open) }, open ? "Show less" : "Show the whole plan"), form?.planFilePath && /* @__PURE__ */ React2.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      title: form.planFilePath,
      "data-raw-agent": "open-plan",
      onClick: () => actions.openPreview(sessionId, form.planFilePath)
    },
    "Open the plan file"
  )), /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, approve.map((c, i) => /* @__PURE__ */ React2.createElement("span", { key: c.id }, /* @__PURE__ */ React2.createElement(
    Button,
    {
      choice: c,
      primary: i === 0,
      autoFocus: i === 0,
      disabled: busy,
      onClick: () => onAnswer({ choice: c.id })
    }
  ))), keep && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement(
    Feedback,
    {
      value: feedback,
      onChange: setFeedback,
      ...keep.feedbackPlaceholder ? { placeholder: keep.feedbackPlaceholder } : {}
    }
  ), /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement(
    Button,
    {
      choice: keep,
      disabled: busy,
      onClick: () => onAnswer(feedback.trim() !== "" ? { choice: keep.id, feedback } : { choice: keep.id })
    }
  )))));
}
function FieldView(props) {
  const { f, value } = props;
  const label2 = /* @__PURE__ */ React2.createElement("span", null, f.title, f.required ? " *" : "");
  let input;
  if (f.kind === "boolean")
    return /* @__PURE__ */ React2.createElement("span", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement("label", { style: css.fieldCheck, "data-raw-agent": "field-boolean" }, /* @__PURE__ */ React2.createElement(
      "input",
      {
        type: "checkbox",
        style: css.checkbox,
        checked: value === true,
        "aria-label": f.title,
        "data-field": f.key,
        onChange: (e) => props.onChange(e.currentTarget.checked)
      }
    ), label2), f.description && /* @__PURE__ */ React2.createElement("span", { style: css.optionDesc }, f.description));
  if (f.kind === "select")
    input = /* @__PURE__ */ React2.createElement(
      "select",
      {
        style: css.input,
        value: typeof value === "string" ? value : "",
        "aria-label": f.title,
        "data-field": f.key,
        onChange: (e) => props.onChange(e.currentTarget.value)
      },
      /* @__PURE__ */ React2.createElement("option", { value: "" }, "\u2013"),
      f.options.map((o) => /* @__PURE__ */ React2.createElement("option", { key: o.value, value: o.value }, o.label))
    );
  else if (f.kind === "multi") {
    const list = Array.isArray(value) ? value : [];
    input = /* @__PURE__ */ React2.createElement("span", { style: css.choiceCol, role: "group", "aria-label": f.title }, f.options.map((o) => /* @__PURE__ */ React2.createElement("label", { key: o.value, style: css.option }, /* @__PURE__ */ React2.createElement(
      "input",
      {
        type: "checkbox",
        "data-field": `${f.key}:${o.value}`,
        checked: list.includes(o.value),
        onChange: () => props.onChange(list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])
      }
    ), o.label)));
  } else
    input = /* @__PURE__ */ React2.createElement(
      "input",
      {
        style: css.input,
        type: f.kind === "number" || f.kind === "integer" ? "number" : f.inputType,
        step: f.kind === "integer" ? 1 : void 0,
        min: f.min,
        max: f.max,
        value: typeof value === "string" ? value : "",
        "aria-label": f.title,
        "data-field": f.key,
        onChange: (e) => props.onChange(e.currentTarget.value)
      }
    );
  return /* @__PURE__ */ React2.createElement("label", { style: css.field }, label2, input, f.description && /* @__PURE__ */ React2.createElement("span", { style: css.optionDesc }, f.description));
}
function ElicitationBody(props) {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, "elicitation");
  const fields = React2.useMemo(() => elicitationFields(form?.requestedSchema), [form?.requestedSchema]);
  const [values, setValues] = React2.useState(() => initialValues(fields));
  const [problem, setProblem] = React2.useState();
  const accept = ask.choices.find((c) => c.id === "accept") ?? ask.choices.find((c) => c.submits === "content");
  const rest = ask.choices.filter((c) => c !== accept);
  const url = safeHttpUrl(form?.url);
  const waiting = ask.state === "waiting";
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, form?.description && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, form.description), form?.mode === "url" && /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React2.createElement("span", { style: css.url, "data-raw-agent": "elicitation-url" }, form.url), !url && /* @__PURE__ */ React2.createElement("span", { style: css.cardError }, "This is not an http(s) link, so it is not opened from here."), waiting && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, "Finish in the page that opened. This card closes when ", form.displayName ?? form.serverName, " says it is done.")), form?.mode === "form" && fields.map((f) => /* @__PURE__ */ React2.createElement(
    FieldView,
    {
      key: f.key,
      f,
      value: values[f.key] ?? "",
      onChange: (v4) => setValues((all) => ({ ...all, [f.key]: v4 }))
    }
  )), problem && /* @__PURE__ */ React2.createElement("span", { style: css.cardError }, problem), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, waiting && url && /* @__PURE__ */ React2.createElement("a", { href: url, target: "_blank", rel: "noopener noreferrer", style: css.choice, "data-raw-agent": "open-url" }, "Open the link again"), accept && form?.mode === "url" && !waiting && /* @__PURE__ */ React2.createElement(
    "a",
    {
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
      style: {
        ...css.primary,
        textDecoration: "none",
        ...url && !busy ? {} : { pointerEvents: "none", opacity: 0.5 }
      },
      "aria-disabled": !url || busy,
      "data-raw-agent": "ask-choice",
      "data-choice": accept.id,
      onClick: () => {
        if (url && !busy) onAnswer({ choice: accept.id });
      }
    },
    accept.label
  ), accept && form?.mode !== "url" && /* @__PURE__ */ React2.createElement(
    Button,
    {
      choice: accept,
      primary: true,
      disabled: busy,
      onClick: () => {
        const r = elicitationContent(fields, values);
        if ("error" in r) {
          setProblem(r.error);
          return;
        }
        setProblem(void 0);
        onAnswer({ choice: accept.id, content: r.content });
      }
    }
  ), rest.map((c) => /* @__PURE__ */ React2.createElement(Button, { key: c.id, choice: c, disabled: busy, onClick: () => onAnswer({ choice: c.id }) }))));
}
function TrustBody(props) {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, "trust");
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, form && /* @__PURE__ */ React2.createElement("span", { style: css.path }, form.directory), /* @__PURE__ */ React2.createElement("div", { style: { ...css.cardNote, color: "inherit" }, "data-raw-agent": "trust-body" }, form?.body ?? ask.detail), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, ask.choices.map((c, i) => /* @__PURE__ */ React2.createElement(Button, { key: c.id, choice: c, primary: i === 0, disabled: busy, onClick: () => onAnswer({ choice: c.id }) }))));
}
function PlainBody(props) {
  const { ask, busy, onAnswer } = props;
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, ask.detail && /* @__PURE__ */ React2.createElement("span", { style: css.cardNote }, ask.detail), /* @__PURE__ */ React2.createElement("span", { style: css.choiceRow }, ask.choices.filter((c) => c.submits === void 0).map((c) => /* @__PURE__ */ React2.createElement(Button, { key: c.id, choice: c, disabled: busy, onClick: () => onAnswer({ choice: c.id }) }))));
}
function AskCard(props) {
  const { ask } = props;
  const body = ask.kind === "permission" && ask.form?.type === "permission" ? /* @__PURE__ */ React2.createElement(PermissionBody, { ...props }) : ask.kind === "question" && ask.form?.type === "question" ? /* @__PURE__ */ React2.createElement(QuestionBody, { ...props }) : ask.kind === "plan" ? /* @__PURE__ */ React2.createElement(PlanBody, { ...props }) : ask.kind === "elicitation" && ask.form?.type === "elicitation" ? /* @__PURE__ */ React2.createElement(ElicitationBody, { ...props }) : ask.kind === "trust" ? /* @__PURE__ */ React2.createElement(TrustBody, { ...props }) : /* @__PURE__ */ React2.createElement(PlainBody, { ...props });
  const numbered = numberedChoices(ask);
  const hint = (c) => {
    const i = numbered.findIndex((x) => x.id === c.id);
    return i >= 0 && i < 9 ? i + 1 : void 0;
  };
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      style: css.card,
      "data-raw-agent": "ask-card",
      "data-ask": ask.id,
      "data-kind": ask.kind,
      role: "alert",
      onKeyDown: (e) => onCardKey(ask, e)
    },
    /* @__PURE__ */ React2.createElement(KeyHint.Provider, { value: hint }, /* @__PURE__ */ React2.createElement("div", { style: css.cardHead }, /* @__PURE__ */ React2.createElement("span", { style: css.cardWho, "data-raw-agent": "ask-who" }, askHeading(ask, props.displayName)), /* @__PURE__ */ React2.createElement("span", { style: css.cardTitle }, askTitle(ask))), body, props.error && /* @__PURE__ */ React2.createElement("span", { style: css.cardError, role: "status" }, props.error))
  );
}
function AskPanel(props) {
  const { store, actions, only } = props;
  const snap = React2.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [picked, setPicked] = React2.useState();
  const info = snap.info;
  if (!info) return null;
  const asks = [...info.view.asks ?? []].filter((a) => !only || only(a)).sort((a, b) => a.at - b.at);
  if (asks.length === 0) return null;
  const ask = asks.find((a) => a.id === picked) ?? asks.find((a) => a.id === props.askId) ?? asks[0];
  const others = asks.filter((a) => a !== ask);
  const name2 = info.backend.displayName;
  return /* @__PURE__ */ React2.createElement("div", { style: css.choiceCol, "data-raw-agent": "ask-panel" }, /* @__PURE__ */ React2.createElement(
    AskCard,
    {
      key: ask.id + (ask.state ?? ""),
      ask,
      displayName: name2,
      sessionId: store.sessionId,
      actions,
      busy: snap.answering === ask.id,
      ...snap.askError?.id === ask.id ? { error: snap.askError.text } : {},
      onAnswer: (reply) => void store.answer(ask.id, reply)
    }
  ), info.view.state.turn && actions.stopTurn && // The takeover hides DSH's Stop button. Stop only interrupts the turn (rule 6); it never
  // answers an ask, so a background agent's ask stays open (D39).
  /* @__PURE__ */ React2.createElement("span", null, /* @__PURE__ */ React2.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "ask-stop",
      title: "Stop the running turn, as the Stop button does. Open asks of background work stay open.",
      onClick: () => actions.stopTurn?.(store.sessionId)
    },
    "Stop the turn"
  )), others.length > 0 && /* @__PURE__ */ React2.createElement("span", { style: css.more, "data-raw-agent": "ask-more" }, others.length === 1 ? "1 more ask waits:" : `${others.length} more asks wait:`, others.map((a) => /* @__PURE__ */ React2.createElement("button", { key: a.id, type: "button", style: css.button, onClick: () => setPicked(a.id) }, askHeading(a, name2), ": ", askTitle(a)))), snap.error && /* @__PURE__ */ React2.createElement("span", { style: css.cardError, role: "status" }, snap.error));
}

// packages/dsh-client/src/ui/workflow-panel.tsx
var React3 = __toESM(require("react"), 1);
var muted2 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var border2 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
var styles = {
  card: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" },
  head: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" },
  name: { fontWeight: 600, wordBreak: "break-word" },
  meta: { fontSize: 11, color: muted2 },
  phase: { borderTop: `1px solid ${border2}`, paddingTop: 4, marginTop: 2 },
  phaseHead: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 },
  agent: { display: "flex", flexDirection: "column", gap: 2, padding: "4px 0 4px 12px" },
  last: {
    fontSize: 12,
    color: muted2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  },
  detail: { fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "2px 0" }
};
var dot = (status) => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 4,
  flex: "none",
  background: status === "running" || status === "starting" ? "var(--raw-agent-running, var(--dsw-alias-state-business-primary, #3b82f6))" : status === "completed" ? "var(--raw-agent-done, var(--dsw-alias-state-success-primary, #22a06b))" : status === "failed" || status === "error" ? "var(--raw-agent-danger, var(--dsw-alias-state-error-primary, #c0392b))" : muted2
});
function useNow(on) {
  const [now, setNow] = React3.useState(() => Date.now());
  React3.useEffect(() => {
    if (!on) return void 0;
    const t = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}
function WorkflowAgentRow(props) {
  const { run, agent: a, info, snap, store, actions, sessionId, now } = props;
  const [details, setDetails] = React3.useState(false);
  const children = info.view.children;
  const child = workflowAgentChild(a, children);
  const address = workflowAgentAddress(sessionId, a, children);
  const last = workflowAgentLast(a, child);
  const stats = workflowAgentStats(a, now);
  const canStop = info.view.workflowAgentStop === true && a.state === "running" && a.agentId !== void 0;
  const stopping = a.agentId !== void 0 && (snap.stopping ?? []).includes(a.agentId);
  const err = a.agentId !== void 0 && snap.stopError?.id === a.agentId ? snap.stopError.text : void 0;
  const hasDetails = a.promptPreview !== void 0 || a.resultPreview !== void 0 || a.error !== void 0;
  return /* @__PURE__ */ React3.createElement("div", { style: styles.agent, "data-raw-agent": "workflow-agent", "data-agent-index": a.index }, /* @__PURE__ */ React3.createElement("div", { style: styles.head }, /* @__PURE__ */ React3.createElement("span", { style: dot(workflowAgentDot(a)), "aria-hidden": "true" }), /* @__PURE__ */ React3.createElement("span", { style: styles.name }, a.label), /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, workflowAgentStatusText(a), a.attempt !== void 0 && a.attempt > 1 ? ` \xB7 attempt ${a.attempt}` : "", a.model ? ` \xB7 ${a.model}` : "")), stats !== "" && /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, stats), last !== void 0 && /* @__PURE__ */ React3.createElement("span", { style: styles.last, title: last, "data-raw-agent": "workflow-agent-last" }, last), details && /* @__PURE__ */ React3.createElement("div", { "data-raw-agent": "workflow-agent-details" }, a.promptPreview !== void 0 && /* @__PURE__ */ React3.createElement("div", { style: styles.detail }, /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, "Task: "), a.promptPreview), a.resultPreview !== void 0 && /* @__PURE__ */ React3.createElement("div", { style: styles.detail }, /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, "Result: "), a.resultPreview), a.error !== void 0 && /* @__PURE__ */ React3.createElement("div", { style: { ...styles.detail, ...css.cardError } }, a.error)), /* @__PURE__ */ React3.createElement("div", { style: css.row }, address && actions.openChild && /* @__PURE__ */ React3.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "workflow-agent-open",
      title: "Open this agent's session (its full output)",
      onClick: () => actions.openChild?.(address)
    },
    "Open"
  ), address && actions.openChildAside && /* @__PURE__ */ React3.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      title: "Open beside this conversation",
      onClick: () => actions.openChildAside?.(address)
    },
    "Open beside"
  ), hasDetails && /* @__PURE__ */ React3.createElement("button", { type: "button", style: css.button, onClick: () => setDetails(!details) }, details ? "Hide details" : "Details"), canStop && /* @__PURE__ */ React3.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "workflow-agent-stop",
      disabled: stopping,
      title: "Stop this agent only. The rest of the workflow keeps running.",
      onClick: () => void store.stopWorkflowAgent(run.taskId, a.agentId)
    },
    stopping ? "Stopping\u2026" : "Stop"
  )), err !== void 0 && /* @__PURE__ */ React3.createElement("span", { style: css.cardError }, err));
}
function WorkflowRunCard(props) {
  const { run, info, snap, store, now } = props;
  const live = isLiveWorkflow(run);
  const stopping = run.stopping === true || (snap.stopping ?? []).includes(run.taskId);
  const err = snap.stopError?.id === run.taskId ? snap.stopError.text : void 0;
  const name2 = info.backend.displayName;
  const groups = workflowPhases(run);
  return /* @__PURE__ */ React3.createElement("div", { style: styles.card, "data-raw-agent": "workflow-run", "data-run-id": run.runId, "data-task-id": run.taskId }, /* @__PURE__ */ React3.createElement("div", { style: styles.head }, /* @__PURE__ */ React3.createElement(
    "span",
    {
      style: dot(live ? "running" : run.status === "completed" ? "completed" : run.status),
      "aria-hidden": "true"
    }
  ), /* @__PURE__ */ React3.createElement("span", { style: styles.name }, run.name), /* @__PURE__ */ React3.createElement("span", { style: styles.meta, "data-raw-agent": "workflow-status" }, "Workflow \xB7 ", workflowStatusText(run))), run.label !== void 0 && run.label !== run.name && /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, run.label), /* @__PURE__ */ React3.createElement("span", { style: styles.meta, "data-raw-agent": "workflow-summary" }, workflowSummaryLine(run, now)), live && /* @__PURE__ */ React3.createElement("div", { style: css.row }, /* @__PURE__ */ React3.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "workflow-stop",
      disabled: stopping,
      title: `Stop every agent of this workflow. ${name2} and the conversation keep running.`,
      onClick: () => void store.stopWorkflow(run.taskId)
    },
    stopping ? "Stopping\u2026" : "Stop entire workflow"
  ), info.view.workflowAgentStop !== true && /* @__PURE__ */ React3.createElement("span", { style: styles.meta, "data-raw-agent": "workflow-no-agent-stop" }, name2, " cannot stop one agent of a workflow; stop the whole workflow instead.")), err !== void 0 && /* @__PURE__ */ React3.createElement("span", { style: css.cardError }, err), !live && run.summary !== void 0 && /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, run.summary), groups.map((g) => /* @__PURE__ */ React3.createElement("div", { key: `${g.index ?? "x"}-${g.title}`, style: styles.phase, "data-raw-agent": "workflow-phase" }, /* @__PURE__ */ React3.createElement("div", { style: styles.phaseHead }, /* @__PURE__ */ React3.createElement("span", { style: styles.name }, g.title), /* @__PURE__ */ React3.createElement("span", { style: styles.meta }, g.status)), g.agents.map((a) => /* @__PURE__ */ React3.createElement(WorkflowAgentRow, { key: `${a.index}-${a.attempt ?? 1}`, ...props, agent: a })))));
}
function WorkflowRuns(props) {
  const { store, snap, info, actions } = props;
  const runs = [...info.view.workflows ?? []].sort((a, b) => b.startedAt - a.startedAt);
  const now = useNow(runs.some(isLiveWorkflow));
  if (runs.length === 0) return /* @__PURE__ */ React3.createElement("div", { style: styles.meta }, "No workflows in this session yet.");
  return /* @__PURE__ */ React3.createElement("div", { "data-raw-agent": "workflow-runs" }, runs.map((run) => /* @__PURE__ */ React3.createElement(
    WorkflowRunCard,
    {
      key: run.taskId,
      run,
      sessionId: store.sessionId,
      info,
      snap,
      store,
      actions,
      now
    }
  )));
}
function WorkflowNodeView(props) {
  const store = props.stores.get(props.sessionId);
  const snap = React3.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  const run = findWorkflow(info?.view, props.runId);
  const now = useNow(run !== void 0 && isLiveWorkflow(run));
  if (snap.status !== "ready" || !info || !run) return null;
  return (
    // Leftover M4: the chat card grows with its rows (no inner scroll box that cut off agent rows).
    /* @__PURE__ */ React3.createElement(
      "div",
      {
        style: { ...css.card, padding: "4px 10px", maxHeight: "none", overflow: "visible" },
        "data-raw-agent": "workflow-node"
      },
      /* @__PURE__ */ React3.createElement(
        WorkflowRunCard,
        {
          run,
          sessionId: props.sessionId,
          info,
          snap,
          store,
          actions: props.actions,
          now
        }
      )
    )
  );
}

// packages/dsh-client/src/ui/agents-panel.tsx
var muted3 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var border3 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
var warn = "var(--raw-agent-ask-border, var(--dsw-alias-state-warn-primary, orange))";
var styles2 = {
  popover: {
    position: "fixed",
    top: 56,
    right: 16,
    zIndex: 1e3,
    width: "min(560px, 94vw)",
    maxHeight: "76vh",
    overflow: "auto",
    boxShadow: "0 6px 24px rgba(0,0,0,0.25)"
  },
  tabs: { display: "flex", gap: 4, borderBottom: `1px solid ${border3}`, paddingBottom: 6 },
  tab: { fontWeight: 600 },
  row: { display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderTop: `1px solid ${border3}` },
  rowHead: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" },
  label: { fontWeight: 600, wordBreak: "break-word" },
  meta: { fontSize: 11, color: muted3 },
  last: {
    fontSize: 12,
    color: muted3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  },
  waiting: { fontSize: 11, color: warn, fontWeight: 600 },
  message: { fontSize: 12, padding: "4px 0", borderTop: `1px solid ${border3}`, wordBreak: "break-word" }
};
var dot2 = (status) => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 4,
  flex: "none",
  background: status === "running" || status === "starting" ? "var(--raw-agent-running, var(--dsw-alias-state-business-primary, #3b82f6))" : status === "completed" ? "var(--raw-agent-done, var(--dsw-alias-state-success-primary, #22a06b))" : status === "failed" ? "var(--raw-agent-danger, var(--dsw-alias-state-error-primary, #c0392b))" : muted3
});
function useNow2(on) {
  const [now, setNow] = React4.useState(() => Date.now());
  React4.useEffect(() => {
    if (!on) return void 0;
    const t = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}
function useWaitingMarks(children, asks, actions) {
  const calls = children.filter((c) => c.callId !== void 0 && asksForChild(asks, c.id).length > 0).map((c) => `${c.callId}\0${c.name ?? c.label}`).join("");
  React4.useEffect(() => {
    if (calls === "" || !actions.markToolCall) return void 0;
    const marks = calls.split("").map((entry) => {
      const [callId, label2] = entry.split("\0");
      const text3 = `Subagent \u201C${label2}\u201D is waiting for your approval`;
      return { callId, text: text3, mark: actions.markToolCall(callId, text3) };
    });
    const timer = setInterval(() => {
      for (const m of marks) {
        if (m.mark.found) continue;
        m.mark.undo();
        m.mark = actions.markToolCall(m.callId, m.text);
      }
    }, 1e3);
    return () => {
      clearInterval(timer);
      for (const m of marks) m.mark.undo();
    };
  }, [calls, actions]);
}
function canStopChild(c, info) {
  return isRunning(c) && (c.role !== "workflow-agent" || info.view.workflowAgentStop === true);
}
function ChildRow(props) {
  const { child: c, info, snap, store, actions, sessionId } = props;
  const [showAsk, setShowAsk] = React4.useState(false);
  const children = info.view.children ?? [];
  const asks = asksForChild(info.view.asks, c.id);
  const address = childAddress(sessionId, children, c);
  const last = childLastLine(c);
  const stats = childStats(c, props.now);
  const stopping = (snap.stopping ?? []).includes(c.id) || c.stopping === true;
  const err = snap.stopError?.id === c.id ? snap.stopError.text : void 0;
  return /* @__PURE__ */ React4.createElement("div", { style: { ...styles2.row, paddingLeft: props.level * 16 }, "data-raw-agent": "child-row", "data-child-id": c.id }, /* @__PURE__ */ React4.createElement("div", { style: styles2.rowHead }, /* @__PURE__ */ React4.createElement("span", { style: dot2(c.status), "aria-hidden": "true" }), /* @__PURE__ */ React4.createElement("span", { style: styles2.label }, c.name ?? c.label), /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, childRoleText(c), " \xB7 ", childStatusText(c)), asks.length > 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.waiting, "data-raw-agent": "child-waiting" }, "Waiting for your approval")), c.name !== void 0 && c.label !== c.name && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, c.label), stats !== "" && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, stats), last !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.last, title: last, "data-raw-agent": "child-last" }, last), c.summary !== void 0 && !isRunning(c) && c.summary !== last && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, c.summary), c.noSession === true && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, "The host could not make a child session for this agent, so its steps are not shown."), /* @__PURE__ */ React4.createElement("div", { style: css.row }, props.open !== false && address && actions.openChild && /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, onClick: () => actions.openChild?.(address) }, "Open"), props.open !== false && address && actions.openChildAside && /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      title: "Open beside this conversation",
      onClick: () => actions.openChildAside?.(address)
    },
    "Open beside"
  ), asks.length > 0 && /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, "data-raw-agent": "child-show-ask", onClick: () => setShowAsk(!showAsk) }, showAsk ? "Hide the question" : "Answer"), canStopChild(c, info) && /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "child-stop",
      disabled: stopping,
      title: "Stop this agent only. The others and the main conversation keep running.",
      onClick: () => void store.stopChild(c.id)
    },
    stopping ? "Stopping\u2026" : "Stop"
  )), isRunning(c) && !canStopChild(c, info) && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta, "data-raw-agent": "child-no-stop" }, info.backend.displayName, " cannot stop one agent of a workflow. Use \u201CStop entire workflow\u201D in the Workflows tab or in the chat."), err !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: css.cardError }, err), showAsk && asks.length > 0 && /* @__PURE__ */ React4.createElement(AskPanel, { store, actions, askId: asks[0].id, only: (a) => a.agentId === c.id }));
}
function TaskOutputView(props) {
  const { task, store, pollMs } = props;
  const reader = React4.useMemo(
    () => new TaskOutputReader(() => store.taskOutput(task.taskId), void 0, pollMs),
    [store, task.taskId, pollMs]
  );
  React4.useEffect(() => () => reader.dispose(), [reader]);
  const running = task.status === "running";
  React4.useEffect(() => reader.setRunning(running), [reader, running]);
  const snap = React4.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  return /* @__PURE__ */ React4.createElement(TaskOutputBody, { snap, running, onRefresh: () => void reader.refresh() });
}
function TaskOutputBody(props) {
  const { snap, running } = props;
  const out = snap.output;
  const text3 = out ? plainTaskOutput(out.output) : void 0;
  const cut = out ? outputCutNote(out) : void 0;
  return /* @__PURE__ */ React4.createElement("div", { "data-raw-agent": "task-output", style: css.choiceCol }, cut !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, cut), text3 !== void 0 && /* @__PURE__ */ React4.createElement("pre", { style: { ...css.pre, maxHeight: 260, overflow: "auto" }, "data-raw-agent": "task-output-text" }, text3 === "" ? running ? "No output yet." : "No output." : text3), text3 === void 0 && snap.error === void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, "Reading the output\u2026"), snap.error !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: css.cardError }, snap.error), /* @__PURE__ */ React4.createElement("div", { style: css.row }, /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, running ? "Updates while the task runs." : "The task has ended."), !running && props.onRefresh && /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, disabled: snap.reading, onClick: props.onRefresh }, "Read again")));
}
function TaskRow(props) {
  const { task: t, snap, store } = props;
  const [showOutput, setShowOutput] = React4.useState(false);
  const stopping = (snap.stopping ?? []).includes(t.taskId);
  const err = snap.stopError?.id === t.taskId ? snap.stopError.text : void 0;
  const output = hasTaskOutput(t);
  return /* @__PURE__ */ React4.createElement("div", { style: styles2.row, "data-raw-agent": "task-row", "data-task-id": t.taskId }, /* @__PURE__ */ React4.createElement("div", { style: styles2.rowHead }, /* @__PURE__ */ React4.createElement("span", { style: dot2(t.status), "aria-hidden": "true" }), /* @__PURE__ */ React4.createElement("span", { style: styles2.label }, t.label), /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, t.kind, " \xB7 ", taskStatusText(t), t.job ? " \xB7 in the job list" : "")), t.progress !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.last }, t.progress), t.note !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, t.note), (t.status === "running" || output) && /* @__PURE__ */ React4.createElement("div", { style: css.row }, output && /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "task-output-toggle",
      "aria-expanded": showOutput,
      onClick: () => setShowOutput(!showOutput)
    },
    showOutput ? "Hide output" : "Show output"
  ), t.status === "running" && /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "task-stop",
      disabled: stopping,
      onClick: () => void store.stopTask(t.taskId)
    },
    stopping ? "Stopping\u2026" : "Stop"
  )), err !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: css.cardError }, err), showOutput && output && /* @__PURE__ */ React4.createElement(TaskOutputView, { task: t, store }));
}
function TeamRoster(props) {
  const { roster, info, sessionId, actions } = props;
  const children = info.view.children ?? [];
  return /* @__PURE__ */ React4.createElement("div", { "data-raw-agent": "team-roster", style: css.choiceCol }, roster.teams.map((t) => /* @__PURE__ */ React4.createElement("div", { key: t.name }, /* @__PURE__ */ React4.createElement("div", { style: styles2.label }, t.name), t.members.map((m) => {
    const address = childAddress(sessionId, children, m);
    const woken = wakeText(m);
    return /* @__PURE__ */ React4.createElement("div", { key: m.id, style: styles2.row, "data-raw-agent": "team-member", "data-child-id": m.id }, /* @__PURE__ */ React4.createElement("div", { style: styles2.rowHead }, /* @__PURE__ */ React4.createElement("span", { style: dot2(m.status), "aria-hidden": "true" }), /* @__PURE__ */ React4.createElement("span", { style: styles2.label }, m.name ?? m.label), /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, childStatusText(m), woken ? ` \xB7 ${woken}` : "")), address && actions.openChild && /* @__PURE__ */ React4.createElement("div", { style: css.row }, /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, onClick: () => actions.openChild?.(address) }, "Open transcript"), actions.openChildAside && /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, onClick: () => actions.openChildAside?.(address) }, "Open beside")));
  }))), /* @__PURE__ */ React4.createElement("div", null, /* @__PURE__ */ React4.createElement("div", { style: styles2.label }, "Messages"), roster.messages.length === 0 && /* @__PURE__ */ React4.createElement("div", { style: styles2.meta }, "No messages between agents yet."), roster.messages.map((m, i) => /* @__PURE__ */ React4.createElement("div", { key: `${m.at}-${i}`, style: styles2.message, "data-raw-agent": "team-message" }, /* @__PURE__ */ React4.createElement("div", { style: styles2.meta }, m.from, " \u2192 ", m.to, m.summary ? ` \xB7 ${m.summary}` : ""), /* @__PURE__ */ React4.createElement("div", { style: { whiteSpace: "pre-wrap" } }, m.text)))), /* @__PURE__ */ React4.createElement("div", { style: css.choiceCol }, /* @__PURE__ */ React4.createElement(
    "textarea",
    {
      style: css.textarea,
      disabled: !roster.messaging,
      placeholder: "Message a teammate",
      "aria-label": "Message a teammate",
      "data-raw-agent": "team-message-box"
    }
  ), roster.messagingNote !== void 0 && /* @__PURE__ */ React4.createElement("span", { style: styles2.meta }, roster.messagingNote)));
}
function AgentsPanel(props) {
  const { store, actions } = props;
  const snap = React4.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  const children = info?.view.children ?? [];
  const now = useNow2(children.some(isRunning));
  const [tab, setTab] = React4.useState(props.initialTab ?? "agents");
  if (!info) return null;
  const roster = rosterModel(info.view, info.backend.displayName);
  const tasks = info.view.tasks ?? [];
  const tabs = [["agents", `Agents (${children.length})`]];
  if (roster) tabs.push(["team", "Team"]);
  const runs = info.view.workflows ?? [];
  if (runs.length > 0) tabs.push(["workflows", `Workflows (${runs.length})`]);
  if (tasks.length > 0) tabs.push(["tasks", `Background tasks (${tasks.length})`]);
  const shown = tabs.some(([t]) => t === tab) ? tab : "agents";
  return /* @__PURE__ */ React4.createElement("div", { style: { ...css.card, ...styles2.popover }, "data-raw-agent": "agents-panel", role: "dialog", "aria-label": "Agents" }, /* @__PURE__ */ React4.createElement("div", { style: css.header }, /* @__PURE__ */ React4.createElement("div", { style: styles2.tabs, role: "tablist" }, tabs.map(([t, label2]) => /* @__PURE__ */ React4.createElement(
    "button",
    {
      key: t,
      type: "button",
      role: "tab",
      "aria-selected": shown === t,
      style: shown === t ? { ...css.button, ...styles2.tab } : css.button,
      "data-raw-agent": `agents-tab-${t}`,
      onClick: () => setTab(t)
    },
    label2
  ))), props.onClose && /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, onClick: props.onClose, "aria-label": "Close" }, "Close")), shown === "agents" && (children.length === 0 ? /* @__PURE__ */ React4.createElement("div", { style: styles2.meta }, "No subagents in this session yet.") : childTree(children).map((r) => /* @__PURE__ */ React4.createElement(
    ChildRow,
    {
      key: r.child.id,
      child: r.child,
      level: r.level,
      sessionId: store.sessionId,
      info,
      snap,
      store,
      actions,
      now
    }
  ))), shown === "team" && roster && /* @__PURE__ */ React4.createElement(TeamRoster, { roster, info, sessionId: store.sessionId, actions }), shown === "workflows" && /* @__PURE__ */ React4.createElement(WorkflowRuns, { store, snap, info, actions }), shown === "tasks" && tasks.map((t) => /* @__PURE__ */ React4.createElement(TaskRow, { key: t.taskId, task: t, snap, store })));
}
function AgentsHeader(props) {
  const store = props.stores.get(props.sessionId);
  const snap = React4.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (snap.status === "absent") return /* @__PURE__ */ React4.createElement(ChildStrip, { ...props });
  if (snap.status !== "ready" || !snap.info) return null;
  return /* @__PURE__ */ React4.createElement(AgentsButton, { store, actions: props.actions });
}
function AgentsButton(props) {
  const { store, actions } = props;
  const snap = React4.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = React4.useState(false);
  const info = snap.info;
  useWaitingMarks(info?.view.children ?? [], info?.view.asks ?? [], actions);
  if (!info) return null;
  const counts = agentCounts(info.view);
  if (counts.children === 0 && counts.tasks === 0 && !info.view.team) return null;
  return /* @__PURE__ */ React4.createElement(React4.Fragment, null, /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: counts.waiting > 0 ? { ...css.button, borderColor: warn } : css.button,
      "data-raw-agent": "agents-button",
      "aria-expanded": open,
      title: "Subagents, teammates and background tasks of this session",
      onClick: () => setOpen(!open)
    },
    agentsButtonText(counts)
  ), open && actions.portal(/* @__PURE__ */ React4.createElement(AgentsPanel, { store, actions, onClose: () => setOpen(false) })));
}
function ChildStrip(props) {
  const link = props.links.get(props.sessionId);
  const l = React4.useSyncExternalStore(link.subscribe, link.getSnapshot, link.getSnapshot);
  if (l.status !== "found" || !l.link) return null;
  return /* @__PURE__ */ React4.createElement(ChildStripBody, { ...props, parentSession: l.link.parentSession, childId: l.link.childId });
}
function ChildStripBody(props) {
  const store = props.stores.get(props.parentSession);
  const snap = React4.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = React4.useState(false);
  const info = snap.info;
  const child = info?.view.children?.find((c) => c.id === props.childId);
  const now = useNow2(child !== void 0 && isRunning(child));
  if (!info || !child) return null;
  const asks = asksForChild(info.view.asks, child.id);
  const stopping = (snap.stopping ?? []).includes(child.id) || child.stopping === true;
  return /* @__PURE__ */ React4.createElement(React4.Fragment, null, /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: asks.length > 0 ? { ...css.button, borderColor: warn } : css.button,
      "data-raw-agent": "child-strip",
      "aria-expanded": open,
      title: childRoleText(child),
      onClick: () => setOpen(!open)
    },
    childStatusText(child),
    asks.length > 0 ? " \xB7 waiting for your approval" : ""
  ), canStopChild(child, info) && /* @__PURE__ */ React4.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "child-strip-stop",
      disabled: stopping,
      title: "Stop this agent only. The others and the main conversation keep running.",
      onClick: () => void store.stopChild(child.id)
    },
    stopping ? "Stopping\u2026" : "Stop"
  ), open && props.actions.portal(
    /* @__PURE__ */ React4.createElement("div", { style: { ...css.card, ...styles2.popover }, "data-raw-agent": "child-panel", role: "dialog" }, /* @__PURE__ */ React4.createElement("div", { style: css.header }, /* @__PURE__ */ React4.createElement("span", { style: styles2.label }, child.name ?? child.label), /* @__PURE__ */ React4.createElement("button", { type: "button", style: css.button, onClick: () => setOpen(false) }, "Close")), /* @__PURE__ */ React4.createElement(
      ChildRow,
      {
        child,
        level: 0,
        sessionId: props.parentSession,
        info,
        snap,
        store,
        actions: props.actions,
        now,
        open: false
      }
    ))
  ));
}

// packages/dsh-client/src/ui/controls.tsx
var React10 = __toESM(require("react"), 1);

// packages/dsh-client/src/drafts.ts
function insertAtCaret(target, text3) {
  try {
    if (target.captureInsertion && target.insertText)
      return target.insertText(text3, target.captureInsertion()) === true;
  } catch {
    return false;
  }
  return false;
}
async function restoreReturnedDrafts(api, sessionId, target, held) {
  if (!target) return held ? { held, droppedAttachments: 0 } : { droppedAttachments: 0 };
  const { returnedDrafts } = await api.state(sessionId);
  const parts = returnedDrafts.map((d) => d.text.trim()).filter(Boolean);
  if (held) parts.unshift(held);
  const droppedAttachments = returnedDrafts.reduce((n2, d) => n2 + (d.attachments ?? 0), 0);
  const text3 = parts.join("\n\n");
  if (text3 === "") return { droppedAttachments };
  return insertAtCaret(target, text3) ? { inserted: text3, droppedAttachments } : { held: text3, droppedAttachments };
}
function takePrefill(req, seenSeq, target) {
  if (!req || req.seq <= seenSeq) return void 0;
  if (req.target === "side-question") return { kind: "side", seq: req.seq, text: req.text };
  if (!target) return void 0;
  return insertAtCaret(target, req.text) ? { kind: "inserted", seq: req.seq } : { kind: "held", seq: req.seq, text: req.text };
}

// packages/dsh-client/src/ui/settings-panel.tsx
var React6 = __toESM(require("react"), 1);

// packages/dsh-client/src/ui/grants-panel.tsx
var React5 = __toESM(require("react"), 1);
var msg = (e) => String(e?.message ?? e);
function grantNote(g) {
  const parts = [`created ${new Date(g.created).toLocaleString()}`];
  if (g.uses > 0) parts.push(`used ${g.uses === 1 ? "once" : `${g.uses} times`} in this run`);
  parts.push(g.saved ? "saved: kept after a DSH restart" : "kept until DSH restarts (not saved)");
  return parts.join(" \xB7 ");
}
function GrantsPanel(props) {
  const { plugin } = props;
  const name2 = props.displayName ?? "the agent";
  const [state, setState] = React5.useState({ kind: "loading" });
  const [label2, setLabel] = React5.useState("");
  const [busy, setBusy] = React5.useState(false);
  const [error, setError] = React5.useState();
  const [fresh, setFresh] = React5.useState();
  React5.useEffect(() => {
    let live = true;
    plugin.grants().then(
      (grants) => live && setState({ kind: "ok", grants }),
      (e) => live && setState({ kind: "error", message: msg(e) })
    );
    return () => {
      live = false;
    };
  }, [plugin]);
  const create = () => {
    if (busy || label2.trim() === "") return;
    setBusy(true);
    setError(void 0);
    plugin.createGrant(label2).then(
      (r) => {
        setBusy(false);
        setLabel("");
        setFresh({ label: r.grant.label, token: r.token });
        setState({ kind: "ok", grants: r.grants });
      },
      (e) => {
        setBusy(false);
        setError(msg(e));
      }
    );
  };
  const revoke = (id) => {
    setBusy(true);
    setError(void 0);
    plugin.revokeGrant(id).then(
      (r) => {
        setBusy(false);
        setState({ kind: "ok", grants: r.grants });
        if (!r.saved)
          setError("Revoked for this DSH run. The stored list could not be updated; revoke it again after a restart.");
      },
      (e) => {
        setBusy(false);
        setError(msg(e));
      }
    );
  };
  return /* @__PURE__ */ React5.createElement("div", { "data-raw-agent": "grants-panel", style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React5.createElement("strong", null, "Agent plugin access"), /* @__PURE__ */ React5.createElement("p", { style: css.hint }, "Other plugins can always read the session state and put text into the composer for you to send. To let one plugin send messages and side questions to ", name2, " without asking, create a grant for it and paste the token into that plugin's config. Messages it sends are marked with the grant's name in the session log."), /* @__PURE__ */ React5.createElement("p", { style: css.hint }, "This is a consent switch between plugins you installed, not a security boundary: every DSH plugin runs in the same process and could read your config."), state.kind === "loading" && /* @__PURE__ */ React5.createElement("p", { style: css.hint }, "Loading\u2026"), state.kind === "error" && /* @__PURE__ */ React5.createElement("p", { style: css.error }, state.message), state.kind === "ok" && state.grants.length === 0 && /* @__PURE__ */ React5.createElement("p", { style: css.hint, "data-raw-agent": "grants-empty" }, "No plugin may send messages without asking."), state.kind === "ok" && state.grants.map((g) => /* @__PURE__ */ React5.createElement("div", { key: g.id, "data-raw-agent": "grant-row", style: { display: "flex", gap: 8, alignItems: "center" } }, /* @__PURE__ */ React5.createElement("span", { style: { flex: "1 1 auto" } }, "Let ", /* @__PURE__ */ React5.createElement("strong", null, g.label), " send messages without asking", /* @__PURE__ */ React5.createElement("br", null), /* @__PURE__ */ React5.createElement("span", { style: css.hint }, grantNote(g))), /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: busy,
      "data-raw-agent": "grant-revoke",
      onClick: () => revoke(g.id)
    },
    "Revoke"
  ))), fresh && /* @__PURE__ */ React5.createElement("div", { "data-raw-agent": "grant-token", style: { display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ React5.createElement("span", null, "Token for ", /* @__PURE__ */ React5.createElement("strong", null, fresh.label), ". Copy it now: it is not shown again."), /* @__PURE__ */ React5.createElement("code", { style: css.pre }, fresh.token), /* @__PURE__ */ React5.createElement("span", { style: { display: "flex", gap: 4 } }, /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      "data-raw-agent": "grant-copy",
      onClick: () => void props.copy(fresh.token).then((ok) => ok && setFresh({ ...fresh, copied: true }))
    },
    fresh.copied ? "Copied" : "Copy token"
  ), /* @__PURE__ */ React5.createElement("button", { type: "button", style: css.button, onClick: () => setFresh(void 0) }, "Done"))), /* @__PURE__ */ React5.createElement("span", { style: { display: "flex", gap: 4 } }, /* @__PURE__ */ React5.createElement(
    "input",
    {
      "aria-label": "Plugin name for a new grant",
      placeholder: "Plugin name, for example my-reminders",
      value: label2,
      maxLength: 80,
      "data-raw-agent": "grant-label",
      style: { ...css.select, maxWidth: "none", flex: "1 1 auto" },
      onChange: (e) => setLabel(e.currentTarget.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") create();
      }
    }
  ), /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: busy || label2.trim() === "",
      "data-raw-agent": "grant-create",
      onClick: create
    },
    "Create grant"
  )), error && /* @__PURE__ */ React5.createElement("p", { style: css.error }, error));
}

// packages/dsh-client/src/ui/settings-panel.tsx
var msg2 = (e) => String(e?.message ?? e);
function SettingsPanel(props) {
  const { sessionId, api, onClose } = props;
  const [files, setFiles] = React6.useState({ kind: "loading" });
  React6.useEffect(() => {
    let live = true;
    api.configFiles(sessionId).then(
      (r) => live && setFiles({ kind: "ok", value: r.files }),
      (e) => live && setFiles({ kind: "error", message: msg2(e) })
    );
    return () => {
      live = false;
    };
  }, [api, sessionId]);
  const dialog = React6.useRef(null);
  React6.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    globalThis.addEventListener?.("keydown", onKey, true);
    dialog.current?.focus?.();
    return () => globalThis.removeEventListener?.("keydown", onKey, true);
  }, [onClose]);
  const labelOf = (scope) => (files.kind === "ok" ? files.value.find((f) => f.scope === scope)?.label : void 0) ?? scope;
  const rows = keyLayerRows(props.keys, labelOf);
  return /* @__PURE__ */ React6.createElement("div", { style: css.backdrop, "data-raw-agent": "settings-backdrop", onClick: onClose }, /* @__PURE__ */ React6.createElement(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      ref: dialog,
      tabIndex: -1,
      "aria-label": `${props.displayName} settings files`,
      style: css.dialog,
      "data-raw-agent": "settings-panel",
      onClick: (e) => e.stopPropagation()
    },
    /* @__PURE__ */ React6.createElement("div", { style: css.header }, /* @__PURE__ */ React6.createElement("strong", null, props.displayName, " settings files"), /* @__PURE__ */ React6.createElement("button", { type: "button", style: css.button, onClick: onClose, "aria-label": "Close" }, "Close")),
    /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "Read-only. This plugin never changes these files. Hidden values are masked: click one to show it. To edit a file, use your editor or a terminal."),
    files.kind === "loading" && /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "Loading\u2026"),
    files.kind === "error" && /* @__PURE__ */ React6.createElement("p", { style: css.error }, "Could not list the files: ", files.message),
    files.kind === "ok" && files.value.map((f) => /* @__PURE__ */ React6.createElement(FileRow, { key: f.scope, file: f, ...props })),
    rows.length > 0 && /* @__PURE__ */ React6.createElement("section", { style: css.file, "data-raw-agent": "settings-keys" }, /* @__PURE__ */ React6.createElement("strong", null, "Which file sets each key"), /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "The first file named wins; objects and lists set in several files are combined. Read from the files only: managed (policy) settings are not shown, and the running session may report other values."), /* @__PURE__ */ React6.createElement("table", null, /* @__PURE__ */ React6.createElement("tbody", null, rows.map((r) => /* @__PURE__ */ React6.createElement("tr", { key: r.key, "data-raw-agent": "settings-key" }, /* @__PURE__ */ React6.createElement("td", null, /* @__PURE__ */ React6.createElement("code", null, r.key)), /* @__PURE__ */ React6.createElement("td", { style: css.hint }, r.text)))))),
    props.plugin && /* @__PURE__ */ React6.createElement("section", { style: css.file }, /* @__PURE__ */ React6.createElement(GrantsPanel, { plugin: props.plugin, copy: props.actions.copy, displayName: props.displayName }))
  ));
}
function FileRow(props) {
  const { file, actions, sessionId, api } = props;
  const [open, setOpen] = React6.useState(false);
  const [note, setNote] = React6.useState();
  const flash = (text3) => setNote(text3);
  return /* @__PURE__ */ React6.createElement("section", { style: css.file, "data-raw-agent": "settings-file", "data-scope": file.scope }, /* @__PURE__ */ React6.createElement("div", { style: css.fileHead }, /* @__PURE__ */ React6.createElement("div", null, /* @__PURE__ */ React6.createElement("div", null, /* @__PURE__ */ React6.createElement("strong", null, file.label), " ", /* @__PURE__ */ React6.createElement("span", { style: css.badge }, file.exists ? "exists" : "not created yet")), /* @__PURE__ */ React6.createElement("code", { style: css.path }, file.path))), /* @__PURE__ */ React6.createElement("div", { style: css.row }, /* @__PURE__ */ React6.createElement("button", { type: "button", style: css.button, disabled: !file.exists, onClick: () => setOpen(!open) }, open ? "Hide" : "Preview"), /* @__PURE__ */ React6.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      onClick: () => void actions.copy(file.path).then((ok) => flash(ok ? "Path copied" : "Could not copy"))
    },
    "Copy path"
  ), /* @__PURE__ */ React6.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: !file.exists,
      title: "Opens the file unmasked in the DSH preview",
      onClick: () => flash(actions.openPreview(sessionId, file.path) ? "Opened in the preview" : "No preview here")
    },
    "Open in DSH preview"
  ), /* @__PURE__ */ React6.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      title: "Opens a DSH terminal and copies a command that goes to this file's folder",
      onClick: () => {
        const opened = actions.openTerminal(sessionId);
        const command = cdCommand(file.path);
        void actions.copy(command).then(
          (copied) => flash(
            opened ? copied ? `Terminal opened. Paste the copied command to go to the file's folder: ${command}` : `Terminal opened in the session folder. To go to the file's folder, run: ${command}` : "No terminal here"
          )
        );
      }
    },
    "Open in terminal"
  ), note && /* @__PURE__ */ React6.createElement("span", { style: css.hint }, note)), open && /* @__PURE__ */ React6.createElement(Preview, { api, sessionId, scope: file.scope }));
}
function Preview(props) {
  const { api, sessionId, scope } = props;
  const [state, setState] = React6.useState({ kind: "loading" });
  const [shown, setShown] = React6.useState({});
  React6.useEffect(() => {
    let live = true;
    api.configFile(sessionId, scope).then(
      (value) => live && setState({ kind: "ok", value }),
      (e) => live && setState({ kind: "error", message: msg2(e) })
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, scope]);
  if (state.kind === "loading") return /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "Loading\u2026");
  if (state.kind === "error") return /* @__PURE__ */ React6.createElement("p", { style: css.error }, state.message);
  const p = state.value;
  if (!p.exists) return /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "The file does not exist.");
  if (p.tooLarge) return /* @__PURE__ */ React6.createElement("p", { style: css.hint }, "The file is too large to preview.");
  if (p.error) return /* @__PURE__ */ React6.createElement("p", { style: css.error }, p.error);
  const segments = maskedSegments(p.masked ?? "", p.secrets ?? []);
  const toggle = (index) => {
    if (shown[index] !== void 0) {
      const next = { ...shown };
      delete next[index];
      setShown(next);
      return;
    }
    api.reveal(sessionId, scope, index).then(
      (r) => setShown((s2) => ({ ...s2, [index]: r.value })),
      (e) => setShown((s2) => ({ ...s2, [index]: `[could not show: ${msg2(e)}]` }))
    );
  };
  return /* @__PURE__ */ React6.createElement("pre", { style: css.pre, "data-raw-agent": "settings-preview" }, segments.map(
    (s2, i) => s2.kind === "text" ? /* @__PURE__ */ React6.createElement(React6.Fragment, { key: i }, s2.text) : /* @__PURE__ */ React6.createElement(
      "button",
      {
        key: i,
        type: "button",
        style: css.secret,
        "data-raw-agent": "secret",
        title: shown[s2.index] !== void 0 ? "Hide this value" : `Show ${s2.key ?? "this value"}`,
        onClick: () => toggle(s2.index)
      },
      shown[s2.index] ?? s2.text
    )
  ));
}

// packages/dsh-client/src/commands-model.ts
function latestSide(side) {
  const list = side?.entries ?? [];
  return list.length > 0 ? list[list.length - 1] : void 0;
}
var sideOpen = (e) => e.status === "asking" || e.status === "waiting";
function sideStatusText(e, displayName, now = Date.now()) {
  switch (e.status) {
    case "waiting":
      return `Waiting for ${displayName} to start. Start it to get the answer.`;
    case "asking": {
      const s2 = Math.max(0, Math.round((now - e.at) / 1e3));
      return `Thinking\u2026 ${s2}s`;
    }
    case "failed":
      return e.error ? `No answer: ${e.error}` : "No answer.";
    case "cancelled":
      return "Cancelled.";
    default:
      return e.synthetic ? `${displayName} gave no answer to this question.` : void 0;
  }
}
function sideShouldOpen(side, dismissedId) {
  const last = latestSide(side);
  return last !== void 0 && last.id !== dismissedId;
}
function sideNote(displayName, historySize) {
  const ctx = historySize > 0 ? ` and the last ${historySize} side ${historySize === 1 ? "answer" : "answers"}` : "";
  return `${displayName} answers from the conversation so far${ctx}, without tools. Nothing here is added to the conversation.`;
}
var MCP_LABEL = {
  connected: "connected",
  pending: "connecting",
  failed: "failed",
  "needs-auth": "needs sign-in",
  disabled: "disabled"
};
function mcpStatusLabel(status) {
  return MCP_LABEL[status] ?? status;
}
function mcpLevel(status) {
  if (status === "connected") return "ok";
  if (status === "pending") return "pending";
  if (status === "needs-auth") return "warn";
  if (status === "disabled") return "off";
  return status === "failed" ? "error" : "pending";
}
function mcpActions(s2, running) {
  const off = s2.status === "disabled";
  return {
    reconnect: running && !off,
    toggle: off ? "enable" : "disable",
    signIn: running && s2.status === "needs-auth"
  };
}
function mcpButtonLabel(mcp) {
  const list = mcp ?? [];
  if (list.length === 0) return "MCP";
  const bad = list.filter((m) => m.status === "failed" || m.status === "needs-auth").length;
  const ok = list.filter((m) => m.status === "connected").length;
  return bad > 0 ? `MCP ${ok}/${list.length} \u26A0` : `MCP ${ok}/${list.length}`;
}
function mcpDetail(s2) {
  const parts = [];
  if (s2.scope) parts.push(s2.scope);
  if (s2.transport) parts.push(s2.transport);
  if (s2.source && s2.source !== s2.scope) parts.push(`from ${s2.source}`);
  if (s2.serverName && s2.serverName !== s2.name) parts.push(s2.serverName);
  if (s2.serverVersion) parts.push(`v${s2.serverVersion}`);
  if (s2.tools && s2.tools.length > 0) parts.push(`${s2.tools.length} ${s2.tools.length === 1 ? "tool" : "tools"}`);
  return parts.join(" \xB7 ");
}
function signInUrl(url) {
  if (!url) return void 0;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : void 0;
  } catch {
    return void 0;
  }
}
function commandRowText(r, displayName) {
  const line = `/${r.name}${r.argumentHint ? ` ${r.argumentHint}` : ""}`;
  const where = r.menu === "listed" ? "in the / menu" : r.menu === "taken" ? `in the / menu, ${r.note ?? "taken by DSH in this session"}: typed, DSH's command runs` : r.menu === "terminal-only" ? `in the / menu; ${displayName} runs this only in its terminal app` : r.menu === "mcp-panel" ? "in the / menu; on its own it opens this MCP panel, with words it goes to the agent" : r.menu === "rewind-panel" ? "in the / menu; it opens the rewind dialog" : "opens the side panel; never sent to the conversation";
  return { line, where };
}
var KIND_LABEL = {
  builtin: "built-in",
  skill: "skill",
  "mcp-prompt": "MCP prompt",
  custom: "custom"
};
function commandKindLabel(kind) {
  return kind ? KIND_LABEL[kind] : void 0;
}
function filterCommands(rows, query) {
  const q2 = query.trim().toLowerCase().replace(/^\//, "");
  if (q2 === "") return [...rows];
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q2) || (r.description ?? "").toLowerCase().includes(q2) || (r.aliases ?? []).some((a) => a.toLowerCase().includes(q2))
  );
}
function startCandidateName(displayName) {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}
var matches = (q2, name2, aliases) => q2 === "" || name2.toLowerCase().includes(q2) || (aliases ?? []).some((a) => a.toLowerCase().includes(q2));
var matchRank = (q2, name2, aliases) => {
  const n2 = name2.toLowerCase();
  const al = (aliases ?? []).map((a) => a.toLowerCase());
  if (n2 === q2) return 0;
  if (al.includes(q2)) return 1;
  if (n2.startsWith(q2)) return 2;
  if (al.some((a) => a.startsWith(q2))) return 3;
  return 4;
};
function sourceCandidates(answer, query) {
  if (!answer) return [];
  const q2 = query.trim().toLowerCase();
  const name2 = answer.displayName ?? "the agent";
  const out = [];
  const side = answer.sideQuestionCommand;
  if (side !== void 0 && side.toLowerCase().startsWith(q2))
    out.push({
      name: side,
      description: `Ask ${name2} a side question: full context, no tools, not added to the conversation`,
      hint: "<question>",
      value: "side"
    });
  if (answer.rows.length === 0 && !answer.running) {
    const start = startCandidateName(name2);
    if (matches(q2, start) || matches(q2, "start"))
      out.push({
        name: start,
        label: `Start ${name2}`,
        description: `${name2} commands \u2014 Start ${name2} to list them`,
        value: "start"
      });
    return out;
  }
  const rows = answer.rows.filter((r) => r.menu !== "side-question" && matches(q2, r.name, r.aliases));
  if (q2 !== "") rows.sort((a, b) => matchRank(q2, a.name, a.aliases) - matchRank(q2, b.name, b.aliases));
  for (const r of rows) {
    const kind = commandKindLabel(r.kind);
    const notes = [];
    if (r.menu === "taken") notes.push(r.note ?? "taken by DSH in this session");
    if (r.menu === "terminal-only") notes.push(`runs only in ${name2}'s terminal app`);
    if (r.menu === "mcp-panel") notes.push("on its own it opens the MCP panel");
    if (r.menu === "rewind-panel") notes.push("opens the rewind dialog");
    if (r.aliases && r.aliases.length > 0) notes.push(`also ${r.aliases.map((a) => `/${a}`).join(", ")}`);
    const c = { name: r.name };
    const short = shortCommandLabel(r.name);
    if (short !== void 0) c.label = short;
    const d = [r.description, kind, ...notes].filter(Boolean).join(" \xB7 ");
    if (d) c.description = d;
    if (r.argumentHint) c.hint = r.argumentHint;
    c.value = r.menu === "taken" ? "taken" : r.menu === "mcp-panel" ? "mcp" : "line";
    out.push(c);
  }
  return out;
}
var COMMAND_LABEL_MAX = 36;
function shortCommandLabel(name2, max = COMMAND_LABEL_MAX) {
  if (name2.length <= max) return void 0;
  const parts = name2.split(":");
  let label2 = parts.length >= 3 ? `${parts[0]}:\u2026:${parts[parts.length - 1]}` : name2;
  if (label2.length > max) {
    const tail = max - 1 - Math.min(8, Math.floor(max / 4));
    label2 = `${label2.slice(0, max - 1 - tail)}\u2026${label2.slice(label2.length - tail)}`;
  }
  return label2;
}
function sourcePickText(name2) {
  return `/${name2} `;
}
function leadingCommand(line) {
  const t = line.trim();
  if (!t.startsWith("/")) return void 0;
  const ws = t.search(/\s/);
  const name2 = (ws === -1 ? t : t.slice(0, ws)).slice(1);
  if (name2 === "") return void 0;
  return { name: name2, rest: ws === -1 ? "" : t.slice(ws).trim() };
}
function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => b?.type === "text" ? String(b.text ?? "") : "").filter((t) => t !== "").join("\n\n");
}
var MARKDOWN_LINE = /^ {0,3}(?:#|\||[-*+] |\d+\. |>|```)/u;
function localTextFormat(text3) {
  const lines = text3.split("\n");
  if (text3.includes("**") || lines.some((l) => MARKDOWN_LINE.test(l))) return "markdown";
  return lines.length > 1 ? "plain" : "markdown";
}
function localCommandOf(source, seq) {
  const raw = source?.rawAgent?.localCommand;
  if (typeof raw !== "object" || raw === null) return void 0;
  const r = raw;
  const out = { seq };
  if (typeof r.name === "string" && r.name !== "") out.name = r.name;
  if (typeof r.args === "string" && r.args !== "") out.args = r.args;
  if (r.unavailable === true) out.unavailable = true;
  if (typeof r.structured === "string") out.structured = r.structured;
  if (typeof r.outputId === "string" && r.outputId !== "") out.outputId = r.outputId;
  return out;
}
var CLEAR = /* @__PURE__ */ new Set(["clear", "reset", "new"]);
var USAGE = /* @__PURE__ */ new Set(["usage", "cost", "stats"]);
function localRender(d) {
  if (d.unavailable || !d.name) return "none";
  if (CLEAR.has(d.name)) return "cleared";
  if (d.name === "compact") return "compacted";
  if (d.name === "context") return "context";
  if (USAGE.has(d.name)) return "usage";
  return "none";
}
function clearedText(displayName) {
  return `Conversation cleared \u2014 ${displayName} starts fresh here`;
}

// packages/dsh-client/src/ui/mcp-panel.tsx
var React7 = __toESM(require("react"), 1);
var LEVEL_COLOR = {
  ok: "var(--raw-agent-done, var(--dsw-alias-state-success-primary, #22a06b))",
  pending: "var(--raw-agent-running, var(--dsw-alias-state-business-primary, #3b82f6))",
  warn: "var(--raw-agent-warn, var(--dsw-alias-state-warn-label, #d9822b))",
  error: "var(--raw-agent-danger, var(--dsw-alias-state-error-primary, #c0392b))",
  off: "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))"
};
var styles3 = {
  server: { borderTop: "1px solid var(--raw-agent-border, rgba(128,128,128,0.35))", padding: "8px 0" },
  name: { fontWeight: 600, wordBreak: "break-all" },
  errorText: { ...css.error, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  cmd: { display: "grid", gridTemplateColumns: "minmax(8em, max-content) 1fr", gap: "2px 12px", fontSize: 12 },
  cmdName: { fontFamily: "var(--raw-agent-mono, ui-monospace, monospace)", wordBreak: "break-all" }
};
function Dot(props) {
  return /* @__PURE__ */ React7.createElement(
    "span",
    {
      "aria-hidden": "true",
      style: {
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 6,
        background: LEVEL_COLOR[mcpLevel(props.status)]
      }
    }
  );
}
function McpServerRow(props) {
  const { server: s2 } = props;
  const a = mcpActions(s2, props.running);
  const [tools, setTools] = React7.useState(false);
  const [pasted, setPasted] = React7.useState("");
  const url = signInUrl(props.auth?.url);
  const detail = mcpDetail(s2);
  return /* @__PURE__ */ React7.createElement("div", { style: styles3.server, "data-raw-agent": "mcp-server", "data-status": s2.status }, /* @__PURE__ */ React7.createElement("div", { style: css.fileHead }, /* @__PURE__ */ React7.createElement("span", null, /* @__PURE__ */ React7.createElement(Dot, { status: s2.status }), /* @__PURE__ */ React7.createElement("span", { style: styles3.name }, s2.name)), /* @__PURE__ */ React7.createElement("span", { style: css.badge, "data-raw-agent": "mcp-status" }, mcpStatusLabel(s2.status))), detail && /* @__PURE__ */ React7.createElement("div", { style: css.hint }, detail), s2.error && /* @__PURE__ */ React7.createElement("div", { style: styles3.errorText, "data-raw-agent": "mcp-error" }, s2.error), /* @__PURE__ */ React7.createElement("div", { style: css.row }, a.reconnect && /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, disabled: props.busy, onClick: () => props.onAction("reconnect") }, "Reconnect"), /* @__PURE__ */ React7.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: props.busy || !props.running,
      "data-raw-agent": "mcp-toggle",
      onClick: () => props.onAction("toggle", a.toggle === "enable")
    },
    a.toggle === "enable" ? "Enable" : "Disable"
  ), a.signIn && /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, disabled: props.busy, onClick: () => props.onAction("authenticate") }, "Sign in"), s2.tools && s2.tools.length > 0 && /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, onClick: () => setTools(!tools) }, tools ? "Hide tools" : "Show tools")), tools && s2.tools && /* @__PURE__ */ React7.createElement("ul", { style: { ...css.effects, marginTop: 4 }, "data-raw-agent": "mcp-tools" }, s2.tools.map((t) => /* @__PURE__ */ React7.createElement("li", { key: t.name }, /* @__PURE__ */ React7.createElement("code", null, t.name), t.description ? ` \u2014 ${t.description.split("\n")[0]}` : "", t.readOnly ? " (read-only)" : t.destructive ? " (destructive)" : ""))), props.auth && /* @__PURE__ */ React7.createElement("div", { style: css.choiceCol, "data-raw-agent": "mcp-auth" }, url ? /* @__PURE__ */ React7.createElement("a", { href: url, target: "_blank", rel: "noreferrer noopener", style: css.link }, "Open the sign-in page") : !props.auth.needsUserAction && /* @__PURE__ */ React7.createElement("span", { style: css.hint }, "Nothing to do: already signed in."), props.auth.callbackExpected && /* @__PURE__ */ React7.createElement(React7.Fragment, null, /* @__PURE__ */ React7.createElement("span", { style: css.hint }, "If the sign-in page ends on an address that does not load (it points to the agent's own machine), paste that address here."), /* @__PURE__ */ React7.createElement("span", { style: css.row }, /* @__PURE__ */ React7.createElement(
    "input",
    {
      type: "url",
      style: { ...css.input, minWidth: "18em" },
      value: pasted,
      placeholder: "http://localhost:\u2026/callback?code=\u2026",
      "aria-label": "Address the sign-in ended on",
      onChange: (e) => setPasted(e.currentTarget.value)
    }
  ), /* @__PURE__ */ React7.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: props.busy || !/^https?:\/\//i.test(pasted.trim()),
      onClick: () => props.onCallback(pasted.trim())
    },
    "Finish sign-in"
  )))));
}
function CommandList(props) {
  const [query, setQuery] = React7.useState("");
  const rows = filterCommands(props.answer.rows, query);
  return /* @__PURE__ */ React7.createElement("div", { style: css.choiceCol, "data-raw-agent": "command-list" }, !props.answer.full && /* @__PURE__ */ React7.createElement("span", { style: css.hint }, "Only the names are known so far; descriptions come once ", props.displayName, " lists them."), /* @__PURE__ */ React7.createElement(
    "input",
    {
      type: "search",
      style: css.input,
      value: query,
      placeholder: "Filter commands",
      "aria-label": "Filter commands",
      onChange: (e) => setQuery(e.currentTarget.value)
    }
  ), /* @__PURE__ */ React7.createElement("div", { style: styles3.cmd }, rows.map((r) => {
    const t = commandRowText(r, props.displayName);
    const kind = commandKindLabel(r.kind);
    return /* @__PURE__ */ React7.createElement(React7.Fragment, { key: r.name }, /* @__PURE__ */ React7.createElement("span", { style: styles3.cmdName, "data-raw-agent": "command-name", "data-menu": r.menu }, /* @__PURE__ */ React7.createElement(
      "button",
      {
        type: "button",
        style: { ...css.button, fontFamily: "inherit" },
        title: "Copy the command",
        onClick: () => void props.actions.copy(`/${r.name} `)
      },
      t.line
    )), /* @__PURE__ */ React7.createElement("span", null, r.description, kind ? /* @__PURE__ */ React7.createElement("span", { style: css.hint }, ` \xB7 ${kind}`) : null, r.aliases && r.aliases.length > 0 ? /* @__PURE__ */ React7.createElement("span", { style: css.hint }, ` \xB7 also ${r.aliases.map((a) => `/${a}`).join(", ")}`) : null, r.menu !== "listed" ? /* @__PURE__ */ React7.createElement("span", { style: css.hint }, ` \xB7 ${t.where}`) : null));
  })), rows.length === 0 && /* @__PURE__ */ React7.createElement("span", { style: css.hint }, "No command matches."));
}
function McpPanel(props) {
  const { api, sessionId, displayName } = props;
  const [tab, setTab] = React7.useState("mcp");
  const [mcp, setMcp] = React7.useState(props.initial?.mcp);
  const [commands, setCommands] = React7.useState(props.initial?.commands);
  const [busy, setBusy] = React7.useState();
  const [note, setNote] = React7.useState();
  const [error, setError] = React7.useState();
  const [auth, setAuth] = React7.useState({});
  const onServers = React7.useRef(props.onServers);
  onServers.current = props.onServers;
  const load = React7.useCallback(() => {
    if (api.mcp)
      api.mcp(sessionId).then(
        (m) => {
          setMcp(m);
          if (m.from === "live") onServers.current?.();
        },
        (e) => setError(String(e?.message ?? e))
      );
    if (api.commands)
      api.commands(sessionId).then(setCommands, (e) => setError(String(e?.message ?? e)));
  }, [api, sessionId]);
  React7.useEffect(() => {
    if (!props.initial) load();
  }, [load, props.initial]);
  const act = (server, run) => {
    const p = run();
    if (!p) return;
    setBusy(server);
    setError(void 0);
    setNote(void 0);
    p.then(
      (r) => {
        setBusy(void 0);
        if (r.mcp) {
          setMcp(r.mcp);
          props.onServers?.();
        }
        if (!r.ok) setError(r.error ?? "the action failed");
        if (r.note) setNote(r.note);
        if (r.auth) setAuth((all) => ({ ...all, [server]: r.auth }));
      },
      (e) => {
        setBusy(void 0);
        setError(String(e?.message ?? e));
      }
    );
  };
  return /* @__PURE__ */ React7.createElement("div", { style: css.backdrop, onClick: props.onClose, "data-raw-agent": "mcp-backdrop" }, /* @__PURE__ */ React7.createElement(
    "div",
    {
      style: css.dialog,
      role: "dialog",
      "aria-label": `${displayName} MCP servers and commands`,
      "data-raw-agent": "mcp-panel",
      onClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => e.key === "Escape" && props.onClose()
    },
    /* @__PURE__ */ React7.createElement("div", { style: css.header }, /* @__PURE__ */ React7.createElement("span", { style: css.row }, /* @__PURE__ */ React7.createElement(
      "button",
      {
        type: "button",
        style: { ...css.button, fontWeight: tab === "mcp" ? 600 : 400 },
        onClick: () => setTab("mcp")
      },
      "MCP servers"
    ), /* @__PURE__ */ React7.createElement(
      "button",
      {
        type: "button",
        style: { ...css.button, fontWeight: tab === "commands" ? 600 : 400 },
        onClick: () => setTab("commands")
      },
      "Commands"
    )), /* @__PURE__ */ React7.createElement("span", { style: css.row }, /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, onClick: load }, "Refresh"), /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, "aria-label": "Close", onClick: props.onClose }, "\xD7"))),
    error && /* @__PURE__ */ React7.createElement("div", { style: css.error }, error),
    note && /* @__PURE__ */ React7.createElement("div", { style: css.hint, "data-raw-agent": "mcp-note" }, note),
    tab === "mcp" ? /* @__PURE__ */ React7.createElement("div", { "data-raw-agent": "mcp-list" }, mcp && !mcp.running && /* @__PURE__ */ React7.createElement("div", { style: css.row }, /* @__PURE__ */ React7.createElement("span", { style: css.hint }, displayName, " is not running. Start it to read the live MCP state", mcp.servers.length > 0 ? "; the list below is from its last start report" : "", "."), /* @__PURE__ */ React7.createElement("button", { type: "button", style: css.button, onClick: props.onStart }, "Start ", displayName)), mcp?.reason && mcp.running && /* @__PURE__ */ React7.createElement("div", { style: css.hint }, "The live read failed: ", mcp.reason), mcp && mcp.servers.length === 0 && /* @__PURE__ */ React7.createElement("div", { style: css.hint }, "No MCP servers."), !mcp && /* @__PURE__ */ React7.createElement("div", { style: css.hint }, "Reading\u2026"), mcp?.servers.map((s2) => /* @__PURE__ */ React7.createElement(
      McpServerRow,
      {
        key: s2.name,
        server: s2,
        running: mcp.running,
        busy: busy !== void 0,
        ...auth[s2.name] ? { auth: auth[s2.name] } : {},
        onAction: (action, enabled) => act(s2.name, () => api.mcpAction?.(sessionId, action, s2.name, enabled)),
        onCallback: (url) => act(s2.name, () => api.mcpAuthCallback?.(sessionId, s2.name, url))
      }
    ))) : commands ? /* @__PURE__ */ React7.createElement(CommandList, { answer: commands, displayName, actions: props.actions }) : /* @__PURE__ */ React7.createElement("div", { style: css.hint }, "Reading\u2026")
  ));
}

// packages/dsh-client/src/ui/side-panel.tsx
var React8 = __toESM(require("react"), 1);
var muted4 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var border4 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
var styles4 = {
  panel: {
    // Top right (M6 review: at the bottom it covered the composer's MCP and Settings buttons).
    position: "fixed",
    right: 16,
    top: 64,
    zIndex: 900,
    width: "min(440px, 92vw)",
    maxHeight: "min(60vh, calc(100vh - 220px))",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    boxSizing: "border-box",
    background: "var(--raw-agent-surface, var(--dsw-alias-bg-layer-1, Canvas))",
    color: "var(--raw-agent-text, var(--dsw-alias-label-primary, CanvasText))",
    border: `1px solid ${border4}`,
    borderRadius: 12,
    boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
    fontSize: 13
  },
  // The tab takes the sidebar's own ground colour (DSH: "a column of the page, not a card").
  tab: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    height: "100%",
    minHeight: 0,
    padding: 12,
    boxSizing: "border-box",
    color: "var(--raw-agent-text, var(--dsw-alias-label-primary, CanvasText))",
    fontSize: 13
  },
  list: { display: "flex", flexDirection: "column", gap: 10, overflow: "auto", minHeight: 0 },
  tabList: { display: "flex", flexDirection: "column", gap: 10, overflow: "auto", minHeight: 0, flex: "1 1 auto" },
  entry: { display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${border4}`, paddingTop: 8 },
  question: { fontWeight: 600, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  status: { fontSize: 12, color: muted4 }
};
function useTick(on) {
  const [now, setNow] = React8.useState(() => Date.now());
  React8.useEffect(() => {
    if (!on) return void 0;
    const t = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
function SideEntryView(props) {
  const { entry: e } = props;
  const status = sideStatusText(e, props.displayName, props.now);
  return /* @__PURE__ */ React8.createElement("div", { style: styles4.entry, "data-raw-agent": "side-entry", "data-status": e.status }, /* @__PURE__ */ React8.createElement("span", { style: styles4.question }, e.question), e.answer !== void 0 && e.answer !== "" && /* @__PURE__ */ React8.createElement("div", { "data-raw-agent": "side-answer" }, /* @__PURE__ */ React8.createElement(Markdown, { text: e.answer })), e.fallback && /* @__PURE__ */ React8.createElement("span", { style: styles4.status }, e.fallback.fallbackModel, " answered after ", e.fallback.originalModel, " declined."), status && /* @__PURE__ */ React8.createElement("span", { style: styles4.status, role: "status" }, status), sideOpen(e) && /* @__PURE__ */ React8.createElement("span", { style: css.row }, e.status === "waiting" && props.onStart && /* @__PURE__ */ React8.createElement("button", { type: "button", style: css.button, onClick: props.onStart, "data-raw-agent": "side-start" }, "Start ", props.displayName), props.onCancel && /* @__PURE__ */ React8.createElement("button", { type: "button", style: css.button, onClick: props.onCancel, "data-raw-agent": "side-cancel" }, "Cancel")));
}
function SidePanelBody(props) {
  const tab = props.variant === "tab";
  const [draft, setDraft] = React8.useState("");
  const prefillSeq = props.prefill?.seq;
  const prefillText = props.prefill?.text;
  React8.useEffect(() => {
    if (prefillSeq === void 0 || prefillText === void 0) return;
    setDraft((d) => d.trim() === "" ? prefillText : `${d}
${prefillText}`);
  }, [prefillSeq, prefillText]);
  const entries = props.side?.entries ?? [];
  const asking = entries.some(sideOpen);
  const listRef = React8.useRef(null);
  React8.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, latestSide(props.side)?.status]);
  const submit = () => {
    const q2 = draft.trim();
    if (q2 === "" || asking || props.busy) return;
    props.onAsk(q2);
    setDraft("");
  };
  const parts = /* @__PURE__ */ React8.createElement(React8.Fragment, null, /* @__PURE__ */ React8.createElement("span", { style: styles4.status }, sideNote(props.displayName, props.side?.historySize ?? 0)), /* @__PURE__ */ React8.createElement(
    "div",
    {
      style: tab ? styles4.tabList : styles4.list,
      ref: listRef,
      ...tab ? { role: "log", "aria-label": "Side questions and answers", "aria-live": "polite" } : {}
    },
    entries.length === 0 && /* @__PURE__ */ React8.createElement("span", { style: styles4.status }, "Ask something about the conversation", props.command ? `, here or with /${props.command} in the composer` : "", "."),
    entries.map((e) => /* @__PURE__ */ React8.createElement(
      SideEntryView,
      {
        key: e.id,
        entry: e,
        displayName: props.displayName,
        now: props.now,
        onCancel: () => props.onCancel(e.id),
        onStart: props.onStart
      }
    ))
  ), props.error && /* @__PURE__ */ React8.createElement("span", { style: css.error, role: "alert", "data-raw-agent": "side-error" }, props.error), /* @__PURE__ */ React8.createElement(
    "textarea",
    {
      ref: props.inputRef,
      style: css.textarea,
      value: draft,
      placeholder: asking ? "Wait for the answer\u2026" : entries.length === 0 ? "Ask a side question" : "Ask another side question",
      "aria-label": "Side question",
      "data-raw-agent": "side-input",
      onChange: (e) => setDraft(e.currentTarget.value),
      onKeyDown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      }
    }
  ), /* @__PURE__ */ React8.createElement("span", { style: css.row }, /* @__PURE__ */ React8.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      disabled: asking || props.busy || draft.trim() === "",
      onClick: submit,
      "data-raw-agent": "side-ask"
    },
    props.busy ? "Asking\u2026" : "Ask"
  )));
  if (tab)
    return /* @__PURE__ */ React8.createElement("section", { style: styles4.tab, "aria-label": "Side chat", "aria-busy": asking || props.busy, "data-raw-agent": "side-chat" }, parts);
  return /* @__PURE__ */ React8.createElement(
    "div",
    {
      style: styles4.panel,
      role: "dialog",
      "aria-label": "Side question",
      "data-raw-agent": "side-panel",
      onKeyDown: (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose?.();
        }
      }
    },
    /* @__PURE__ */ React8.createElement("div", { style: css.header }, /* @__PURE__ */ React8.createElement("strong", null, "Side question"), /* @__PURE__ */ React8.createElement("button", { type: "button", style: css.button, "aria-label": "Close", onClick: props.onClose, "data-raw-agent": "side-close" }, "\xD7")),
    parts
  );
}
function useSideAsk(store, api) {
  const [busy, setBusy] = React8.useState(false);
  const [error, setError] = React8.useState();
  React8.useEffect(() => {
    setBusy(false);
    setError(void 0);
  }, [store]);
  const ask = React8.useCallback(
    (question) => {
      if (!api.askSide) {
        setError("Side questions are not available here.");
        return;
      }
      setBusy(true);
      setError(void 0);
      void store.refresh();
      api.askSide(store.sessionId, question).then(
        (r) => {
          setBusy(false);
          if (!r.ok) setError(r.error ?? "the question was refused");
          void store.refresh();
        },
        (e) => {
          setBusy(false);
          setError(String(e?.message ?? e));
        }
      );
      setTimeout(() => void store.refresh(), 300);
    },
    [store, api]
  );
  const cancel = React8.useCallback(
    (id) => {
      void api.cancelSide?.(store.sessionId, id).then(() => store.refresh());
    },
    [store, api]
  );
  return { busy, error, ask, cancel };
}
function SidePanel(props) {
  const { store, api, actions } = props;
  const snap = React8.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const side = snap.info?.view.side;
  const [dismissed, setDismissed] = React8.useState();
  const baseline = React8.useRef(props.initiallyOpen ? null : void 0);
  if (baseline.current === void 0 && snap.status === "ready") baseline.current = latestSide(side)?.id ?? null;
  const [forced, setForced] = React8.useState(props.initiallyOpen === true);
  const { busy, error, ask: askNow, cancel } = useSideAsk(store, api);
  const open = props.open === true || forced || baseline.current !== void 0 && sideShouldOpen(side, dismissed ?? baseline.current ?? void 0);
  const { onOpenChange } = props;
  React8.useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  React8.useEffect(() => {
    if (props.open) setForced(true);
  }, [props.open]);
  const prefillSeq = props.prefill?.seq;
  React8.useEffect(() => {
    if (prefillSeq !== void 0) setForced(true);
  }, [prefillSeq]);
  const now = useTick(open && (side?.entries ?? []).some((e) => e.status === "asking"));
  if (!open) return null;
  const close = () => {
    setForced(false);
    setDismissed(latestSide(side)?.id ?? "");
    onOpenChange?.(false);
  };
  const ask = (question) => {
    setForced(true);
    askNow(question);
  };
  return actions.portal(
    /* @__PURE__ */ React8.createElement(
      SidePanelBody,
      {
        side,
        displayName: props.displayName,
        ...props.command ? { command: props.command } : {},
        busy,
        ...error ? { error } : {},
        now,
        onAsk: ask,
        onCancel: cancel,
        onStart: () => void store.start(),
        onClose: close,
        ...props.prefill ? { prefill: props.prefill } : {}
      }
    )
  );
}

// packages/dsh-client/src/lifecycle-model.ts
function howItEnded(e) {
  if (e.signal !== void 0) return e.signal === "SIGKILL" ? "killed (SIGKILL)" : `ended by ${e.signal}`;
  if (e.code !== void 0 && e.code !== 0) return `exit code ${e.code}`;
  return void 0;
}
function exitBanner(info) {
  const v4 = info.view;
  const e = v4.state.lastExit;
  if (!e || v4.state.process !== "none") return void 0;
  if (e.reason === "disposed" || e.reason === "force-stopped") return void 0;
  const name2 = info.backend.displayName;
  const how = howItEnded(e);
  const ended = e.reason === "ended";
  const title = ended ? `${name2} ended by itself${e.duringTurn ? " during a reply" : ""}.` : `${name2} ${e.duringTurn ? "crashed during a reply" : "stopped unexpectedly"}${how ? ` (${how})` : ""}.`;
  const b = {
    key: `exit-${e.at}`,
    level: ended ? "warning" : "error",
    title,
    restartLabel: `Restart ${name2}`
  };
  const detail = [e.error?.trim(), e.stderr?.trim() ? `Its last error output:
${e.stderr.trim()}` : void 0].filter((x) => x !== void 0 && x !== "").join("\n\n");
  if (detail !== "") b.detail = detail;
  if (e.duringTurn) {
    const r = v4.lifecycle?.recovered;
    b.reply = r && r.why === "crash" && r.at >= e.at && r.steps > 0 ? `What ${name2} wrote before it stopped was read back from its own record (${r.steps} ${r.steps === 1 ? "step" : "steps"}).` : `The reply that was running ended here. Restart ${name2}, or send a message, to go on: it resumes the same conversation.`;
  } else b.reply = `Restart ${name2}, or send a message: it resumes the same conversation.`;
  return b;
}
function filesText(r) {
  const n2 = r.filesChanged.length;
  const lines = r.insertions !== void 0 || r.deletions !== void 0 ? ` (+${r.insertions ?? 0} \u2212${r.deletions ?? 0} lines)` : "";
  const links = r.skippedLinks ? `; ${r.skippedLinks} left alone (a link sits at the path)` : "";
  return `${n2} ${n2 === 1 ? "file" : "files"}${lines}${links}`;
}
function rewindResultText(r, name2) {
  if (!r.ok) return `${name2} did not restore the files: ${r.error ?? "no reason given"}.`;
  if (r.dryRun)
    return r.filesChanged.length === 0 ? "No file changed since this message." : `Restore code would change ${filesText(r)}.`;
  return r.filesChanged.length === 0 ? "No file needed restoring." : `Restored ${filesText(r)}.`;
}
function lifecycleNotes(info) {
  const l = info.view.lifecycle;
  if (!l) return [];
  const name2 = info.backend.displayName;
  const out = [];
  if (l.unstartedFork)
    out.push({
      id: "fork",
      level: "info",
      text: `This is a branch. ${name2} remembers the conversation up to the branch point and goes on from there when you send a message.`
    });
  if (l.restoreCodePending)
    out.push({
      id: "restore-pending",
      level: "info",
      text: `When ${name2} starts in this branch, it first puts the files back as they were at the branch point.`
    });
  if (l.forkedFromChild)
    out.push({
      id: "child-fork",
      level: "warning",
      text: `This branch was made from a subagent's session. ${name2} starts a new conversation here and does not remember the subagent's work.`
    });
  if (l.endedByStop && l.endedByStop.length > 0)
    out.push({
      id: `ended-by-stop-${l.endedByStop.join("|")}`,
      level: "warning",
      text: `When DSH last stopped, ${l.endedByStop.join(", ")} ended too. ${name2} was not told.`
    });
  if (l.recovered && l.recovered.why === "restart" && (l.recovered.steps > 0 || l.recovered.note))
    out.push({
      id: `recovered-${l.recovered.at}`,
      level: "info",
      text: `${name2} wrote ${l.recovered.steps > 0 ? `${l.recovered.steps} ${l.recovered.steps === 1 ? "step" : "steps"}` : "more"} while DSH was not looking; read back from its own record.` + (l.recovered.note ? ` ${l.recovered.note}.` : "")
    });
  if (l.recoveryProblem) out.push({ id: `recovery-problem`, level: "warning", text: l.recoveryProblem });
  if (l.rewind && !l.rewind.result.dryRun)
    out.push({
      id: `rewind-${l.rewind.at}`,
      level: l.rewind.result.ok ? "info" : "warning",
      text: rewindResultText(l.rewind.result, name2)
    });
  return out;
}
function rewindChoices(opts, point, preview) {
  const name2 = opts.displayName;
  const forkable = point.forkSeq !== void 0;
  const noFork = forkable ? void 0 : "Nothing comes before the first message: open a new session to start over.";
  const noCheckpoints = opts.fileRewind ? void 0 : `${name2} keeps no file checkpoints here (its settings turn them off).`;
  const out = [];
  const both = {
    id: "both",
    label: "Restore code and conversation",
    hint: `A new branch that ends before this message; when ${name2} starts there, the files go back as they were before it.`
  };
  const bothBlocked = noFork ?? noCheckpoints;
  if (bothBlocked) both.disabled = bothBlocked;
  out.push(both);
  const conv = {
    id: "conversation",
    label: "Restore conversation",
    hint: `A new branch that ends before this message. ${name2} forgets what came after; the files stay as they are.`
  };
  if (noFork) conv.disabled = noFork;
  out.push(conv);
  const code = {
    id: "code",
    label: "Restore code",
    hint: `The files go back as they were before this message. The conversation here stays as it is.`
  };
  if (noCheckpoints) code.disabled = noCheckpoints;
  else if (!opts.running) code.disabled = `Start ${name2} first: it restores the files from its checkpoints.`;
  else if (preview.state === "done" && preview.result?.ok && preview.result.filesChanged.length === 0)
    code.disabled = "No file changed since this message.";
  else if (preview.state === "done" && preview.result && !preview.result.ok)
    code.disabled = rewindResultText(preview.result, name2);
  out.push(code);
  out.push({ id: "cancel", label: "Never mind", hint: "Close without changes." });
  return out;
}
function pointLabel(p) {
  const text3 = p.text.replace(/\s+/g, " ").trim();
  const att = p.attachments ? ` [+${p.attachments} ${p.attachments === 1 ? "attachment" : "attachments"}]` : "";
  return (text3 === "" ? "(no text)" : text3) + att;
}
function rewindDraft(p) {
  const text3 = p.cut ? p.draft : p.text;
  const out = {};
  if (text3 !== void 0 && text3.trim() !== "") out.text = text3;
  const lost = [];
  if (p.cut && p.draft === void 0) lost.push("the message is too long to put back");
  if (p.attachments)
    lost.push(
      `its ${p.attachments === 1 ? "attachment was" : `${p.attachments} attachments were`} not put back; attach ${p.attachments === 1 ? "it" : "them"} again if you need ${p.attachments === 1 ? "it" : "them"}`
    );
  if (lost.length > 0)
    out.note = `${out.text ? "Your rewound message is in the composer, but " : "Your rewound message: "}${lost.join("; ")}.`;
  return out;
}
var REWIND_STATS_MAX = 10;
function pointStats(r) {
  if (!r?.ok) return void 0;
  const n2 = r.filesChanged.length;
  if (n2 === 0) return "no file changed since";
  const lines = r.insertions !== void 0 || r.deletions !== void 0 ? ` +${r.insertions ?? 0} \u2212${r.deletions ?? 0}` : "";
  return `${n2} ${n2 === 1 ? "file" : "files"}${lines} since`;
}
var REWIND_SUMMARIZE_NOTE = "The terminal app's \u201CSummarize from here\u201D and \u201CSummarize up to here\u201D are not available outside it.";
var CLEAR_NAMES = /* @__PURE__ */ new Set(["clear", "reset", "new"]);
var COMPACT_NAME = "compact";
function commandMarkerOf(text3, seq, time) {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(text3.trim());
  if (!match) return void 0;
  const name2 = match[1];
  const args = (match[2] ?? "").trim();
  if (CLEAR_NAMES.has(name2) && args === "") return { kind: "cleared", seq, time };
  if (name2 === COMPACT_NAME) {
    const out = { kind: "compacted", seq, time };
    if (args !== "") out.args = args;
    return out;
  }
  return void 0;
}
var COMPACT_MATCH_WINDOW_MS = 30 * 60 * 1e3;
function compactOutcome(time, usage, compactingNow) {
  const rows = [...usage?.compactions ?? []].sort((a, b) => a.at - b.at);
  const start = rows.findIndex(
    (r) => r.at >= time && r.at - time <= COMPACT_MATCH_WINDOW_MS && r.trigger !== "auto" && r.phase === "start"
  );
  const from = start >= 0 ? start : -1;
  const end = rows.findIndex(
    (r, i) => i > from && r.phase === "end" && r.trigger !== "auto" && r.at >= time && r.at - time <= COMPACT_MATCH_WINDOW_MS
  );
  if (end >= 0) {
    const r = rows[end];
    if (r.error !== void 0) return { state: "failed", error: r.error };
    const o = { state: "done" };
    if (r.preTokens !== void 0) o.preTokens = r.preTokens;
    if (r.postTokens !== void 0) o.postTokens = r.postTokens;
    return o;
  }
  if (start >= 0 && compactingNow) return { state: "running" };
  if (start >= 0) return { state: "unknown" };
  return { state: compactingNow ? "running" : "unknown" };
}
function compactMarkerText(o, name2, fmt) {
  switch (o.state) {
    case "done":
      return o.preTokens !== void 0 && o.postTokens !== void 0 ? `Conversation compacted (${fmt(o.preTokens)} \u2192 ${fmt(o.postTokens)} tokens)` : "Conversation compacted";
    case "failed":
      return `Compaction failed: ${o.error ?? "no reason given"}`;
    case "running":
      return `${name2} is compacting the conversation\u2026`;
    default:
      return `Compaction requested here (${name2}'s result is not known in this view)`;
  }
}

// packages/dsh-client/src/ui/rewind-panel.tsx
var React9 = __toESM(require("react"), 1);

// packages/dsh-client/src/rewind-actions.ts
var wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function requestRestoreAtStart(api, forkSessionId, retry = {}) {
  if (!api.rewindRestore) return { ok: false, error: "this plugin version cannot restore code at a branch start" };
  const attempts = Math.max(1, retry.attempts ?? 20);
  const sleep = retry.sleep ?? wait;
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retry.delayMs ?? 500);
    try {
      const r = await api.rewindRestore(forkSessionId, true);
      if (r.ok) return { ok: true };
      last = r.error ?? `request failed (${r.status})`;
      if (r.status !== 404 && r.status !== 409) break;
    } catch (e) {
      last = String(e?.message ?? e);
    }
  }
  return { ok: false, error: last ?? "no answer" };
}
function handBackDraft(branch, draft) {
  if (!branch) return;
  if (draft.text !== void 0) branch.requestPrefill(draft.text, "composer");
  if (draft.note !== void 0) branch.showNote(draft.note);
}

// packages/dsh-client/src/ui/rewind-panel.tsx
var msg3 = (e) => String(e?.message ?? e);
var listStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: 280,
  overflowY: "auto",
  margin: "6px 0"
};
function RewindPanel(props) {
  const { sessionId, api, actions, onClose } = props;
  const [load, setLoad] = React9.useState(
    props.initial?.options ? { kind: "ok", value: props.initial.options } : { kind: "loading" }
  );
  const [picked, setPicked] = React9.useState(props.initial?.picked);
  const [preview, setPreview] = React9.useState(props.initial?.preview ?? { state: "none" });
  const [busy, setBusy] = React9.useState(false);
  const [outcome, setOutcome] = React9.useState();
  React9.useEffect(() => {
    if (props.initial?.options || !api.rewind) {
      if (!api.rewind && !props.initial?.options) setLoad({ kind: "error", message: "This session cannot rewind." });
      return void 0;
    }
    let live = true;
    api.rewind(sessionId).then(
      (value) => live && setLoad({ kind: "ok", value }),
      (e) => live && setLoad({ kind: "error", message: msg3(e) })
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, props.initial?.options]);
  const dialog = React9.useRef(null);
  React9.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    globalThis.addEventListener?.("keydown", onKey, true);
    dialog.current?.focus?.();
    return () => globalThis.removeEventListener?.("keydown", onKey, true);
  }, [onClose]);
  const opts = load.kind === "ok" ? load.value : void 0;
  const point = opts?.points.find((p) => p.messageId === picked);
  const name2 = opts?.displayName ?? "The agent";
  const [stats, setStats] = React9.useState(props.initial?.stats ?? {});
  React9.useEffect(() => {
    if (!opts || !opts.running || !opts.fileRewind || !api.rewindFiles || props.initial?.stats) return void 0;
    const rewindFiles = api.rewindFiles.bind(api);
    let live = true;
    const ids = [...opts.points].reverse().slice(0, REWIND_STATS_MAX).map((p) => p.messageId);
    void (async () => {
      for (const id of ids) {
        if (!live) return;
        try {
          const r = await rewindFiles(sessionId, id, true);
          if (live && r.result) setStats((all) => ({ ...all, [id]: r.result }));
        } catch {
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [api, sessionId, opts, props.initial?.stats]);
  React9.useEffect(() => {
    if (!opts || !point || !opts.running || !opts.fileRewind || !api.rewindFiles) return void 0;
    if (props.initial?.preview && point.messageId === props.initial.picked) return void 0;
    let live = true;
    setPreview({ state: "loading" });
    api.rewindFiles(sessionId, point.messageId, true).then(
      (r) => live && setPreview(
        r.result ? { state: "done", result: r.result } : { state: "failed", error: r.error ?? "no preview" }
      ),
      (e) => live && setPreview({ state: "failed", error: msg3(e) })
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, opts, point, props.initial?.preview, props.initial?.picked]);
  const branch = async (restoreCode2) => {
    if (!point || point.forkSeq === void 0) return;
    if (!actions.forkSession) {
      setOutcome({ text: "DSH offers no branch action here.", error: true });
      return;
    }
    setBusy(true);
    try {
      const child = await actions.forkSession(sessionId, point.forkSeq);
      handBackDraft(props.stores?.get(child), rewindDraft(point));
      actions.openSession?.(child);
      if (restoreCode2) {
        void requestRestoreAtStart(api, child, props.retry).then((r) => {
          if (!r.ok)
            props.stores?.get(child).showNote(`The files will not be restored at this branch's start: ${r.error ?? "no answer"}.`);
        });
      }
      onClose();
    } catch (e) {
      setOutcome({ text: `DSH did not make the branch: ${msg3(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };
  const restoreCode = async () => {
    if (!point || !api.rewindFiles) return;
    setBusy(true);
    try {
      const r = await api.rewindFiles(sessionId, point.messageId, false);
      setOutcome(
        r.result ? { text: rewindResultText(r.result, name2), error: !r.ok } : { text: r.error ?? "The files were not restored.", error: true }
      );
      void props.store.refresh();
    } catch (e) {
      setOutcome({ text: msg3(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const run = (id) => {
    if (id === "cancel") onClose();
    else if (id === "conversation") void branch(false);
    else if (id === "both") void branch(true);
    else void restoreCode();
  };
  const points = opts ? [...opts.points].reverse() : [];
  return /* @__PURE__ */ React9.createElement("div", { style: css.backdrop, "data-raw-agent": "rewind-backdrop", onClick: onClose }, /* @__PURE__ */ React9.createElement(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      ref: dialog,
      tabIndex: -1,
      "aria-label": `Rewind ${name2}`,
      style: css.dialog,
      "data-raw-agent": "rewind-panel",
      onClick: (e) => e.stopPropagation()
    },
    /* @__PURE__ */ React9.createElement("div", { style: css.header }, /* @__PURE__ */ React9.createElement("strong", null, "Rewind"), /* @__PURE__ */ React9.createElement("button", { type: "button", style: css.button, onClick: onClose, "aria-label": "Close" }, "Close")),
    /* @__PURE__ */ React9.createElement("p", { style: css.hint }, "Pick one of your earlier messages. Restoring the conversation opens a new branch that ends before it; this session stays as it is."),
    load.kind === "loading" && /* @__PURE__ */ React9.createElement("p", { style: css.hint }, "Loading\u2026"),
    load.kind === "error" && /* @__PURE__ */ React9.createElement("p", { style: css.error }, load.message),
    opts && points.length === 0 && /* @__PURE__ */ React9.createElement("p", { style: css.hint, "data-raw-agent": "rewind-empty" }, "There is no message of yours to go back to yet."),
    opts && points.length > 0 && /* @__PURE__ */ React9.createElement("div", { style: listStyle, role: "listbox", "aria-label": "Your messages", "data-raw-agent": "rewind-points" }, points.map((p) => /* @__PURE__ */ React9.createElement(
      "button",
      {
        key: p.messageId,
        type: "button",
        role: "option",
        "aria-selected": p.messageId === picked,
        "data-raw-agent": "rewind-point",
        style: {
          ...css.choice,
          textAlign: "left",
          fontWeight: p.messageId === picked ? 600 : void 0
        },
        onClick: () => {
          setPicked(p.messageId);
          setOutcome(void 0);
          setPreview({ state: "none" });
        }
      },
      pointLabel(p),
      p.inherited ? " (before this branch)" : "",
      pointStats(stats[p.messageId]) !== void 0 && /* @__PURE__ */ React9.createElement("span", { style: css.optionDesc, "data-raw-agent": "rewind-point-stats" }, pointStats(stats[p.messageId]))
    ))),
    opts && point && /* @__PURE__ */ React9.createElement("div", { "data-raw-agent": "rewind-choices", style: css.choiceCol }, preview.state === "loading" && /* @__PURE__ */ React9.createElement("span", { style: css.hint }, "Reading what \u201CRestore code\u201D would change\u2026"), preview.state === "done" && preview.result && /* @__PURE__ */ React9.createElement("span", { style: css.hint, "data-raw-agent": "rewind-preview" }, rewindResultText(preview.result, name2), preview.result.ok && preview.result.filesChanged.length > 0 ? ` ${preview.result.filesChanged.slice(0, 8).join(", ")}${preview.result.filesChanged.length > 8 ? ", \u2026" : ""}` : ""), preview.state === "failed" && /* @__PURE__ */ React9.createElement("span", { style: css.hint }, "No preview: ", preview.error), rewindChoices(opts, point, preview).map((c) => /* @__PURE__ */ React9.createElement(
      "button",
      {
        key: c.id,
        type: "button",
        style: c.id === "cancel" ? css.button : css.choice,
        disabled: busy || c.disabled !== void 0,
        title: c.disabled ?? c.hint,
        "data-raw-agent": `rewind-${c.id}`,
        onClick: () => run(c.id)
      },
      c.label,
      /* @__PURE__ */ React9.createElement("span", { style: css.optionDesc }, c.disabled ?? c.hint)
    ))),
    outcome && /* @__PURE__ */ React9.createElement("p", { style: outcome.error ? css.error : css.hint, role: "status", "data-raw-agent": "rewind-outcome" }, outcome.text),
    /* @__PURE__ */ React9.createElement("p", { style: css.hint }, REWIND_SUMMARIZE_NOTE)
  ));
}

// packages/dsh-client/src/ui/controls.tsx
var Chevron = () => /* @__PURE__ */ React10.createElement("svg", { viewBox: "0 0 10 10", "aria-hidden": "true", focusable: "false" }, /* @__PURE__ */ React10.createElement("path", { d: "M2 3.5 5 6.5 8 3.5", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }));
function Picker(props) {
  const { model, chip } = props;
  const from = chip.fromSettings ? ", from your settings" : "";
  const tip = `${chip.fromSettings ? "From your settings: " : ""}${chip.full}. ${model.title}`;
  return /* @__PURE__ */ React10.createElement(
    "span",
    {
      className: CHIP_CLASS,
      title: tip,
      "data-raw-agent": `${props.testId}-chip`,
      ...chip.risk ? { "data-risk": chip.risk } : {},
      ...chip.fromSettings ? { "data-from-settings": "" } : {},
      ...chip.sessionMode ? { "data-session-mode": "" } : {},
      ...props.disabled ? { "data-disabled": "" } : {}
    },
    /* @__PURE__ */ React10.createElement("span", { "data-chip-text": "", "aria-hidden": "true" }, chip.text),
    chip.fromSettings && /* @__PURE__ */ React10.createElement("span", { "data-chip-dot": "", "aria-hidden": "true" }),
    /* @__PURE__ */ React10.createElement(Chevron, null),
    /* @__PURE__ */ React10.createElement(
      "select",
      {
        ref: props.selectRef,
        "aria-label": `${props.label}: ${chip.full}${from}`,
        title: tip,
        value: model.value,
        disabled: props.disabled,
        "data-raw-agent": props.testId,
        onChange: (e) => props.onPick(e.currentTarget.value)
      },
      model.options.map((o) => /* @__PURE__ */ React10.createElement("option", { key: o.value, value: o.value, disabled: o.disabled, title: o.hint }, o.label))
    )
  );
}
var NOTE_SHOW_MS = 5e3;
var ERROR_SHOW_MS = 12e3;
var FADE_MS = 400;
var FADE_TIMERS = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h)
};
function useFade(text3, error, timers = FADE_TIMERS) {
  const [phase, setPhase] = React10.useState("shown");
  React10.useEffect(() => {
    setPhase("shown");
    if (text3 === void 0) return void 0;
    const a = timers.set(() => setPhase("fading"), error ? ERROR_SHOW_MS : NOTE_SHOW_MS);
    const b = timers.set(() => setPhase("faded"), (error ? ERROR_SHOW_MS : NOTE_SHOW_MS) + FADE_MS);
    return () => {
      timers.clear(a);
      timers.clear(b);
    };
  }, [text3, error, timers]);
  return phase;
}
function openPicker(el) {
  if (!el || el.disabled) return false;
  el.focus?.();
  try {
    el.showPicker?.();
    return true;
  } catch {
    return false;
  }
}
function SessionControls(props) {
  const { store, api, actions } = props;
  const snap = React10.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [panel, setPanel] = React10.useState(false);
  const close = React10.useCallback(() => setPanel(false), []);
  const [mcpPanel, setMcpPanel] = React10.useState(false);
  const closeMcp = React10.useCallback(() => setMcpPanel(false), []);
  const [rewindPanel, setRewindPanel] = React10.useState(false);
  const modelRef = React10.useRef(null);
  const closeRewind = React10.useCallback(() => setRewindPanel(false), []);
  const panelSeq = snap.panelRequest?.seq ?? 0;
  const panelName = snap.panelRequest?.panel;
  const panelSeen = React10.useRef(panelSeq);
  React10.useEffect(() => {
    if (panelSeq > panelSeen.current) {
      if (panelName === "mcp") setMcpPanel(true);
      else if (panelName === "rewind") setRewindPanel(true);
      else if (panelName === "model") openPicker(modelRef.current);
    }
    panelSeen.current = panelSeq;
  }, [panelSeq, panelName]);
  const [sideShown, setSideShown] = React10.useState(false);
  const [sideWanted, setSideWanted] = React10.useState(false);
  const [sideFallback, setSideFallback] = React10.useState(false);
  const onSideOpen = React10.useCallback((open) => {
    setSideShown(open);
    if (!open) {
      setSideWanted(false);
      setSideFallback(false);
    }
  }, []);
  const subscribeSide = React10.useCallback((fn) => actions.onSideChatChange?.(fn) ?? (() => {
  }), [actions]);
  const readSide = React10.useCallback(() => actions.sideChatInSidebar?.() === true, [actions]);
  const tabbed = React10.useSyncExternalStore(subscribeSide, readSide, readSide);
  const openSide = React10.useCallback(
    (quiet) => {
      if (tabbed && actions.openSideChat?.(store.sessionId, quiet ? { quiet: true } : {}) === true) return;
      setSideFallback(true);
      setSideWanted(true);
    },
    [tabbed, actions, store]
  );
  const inlineSide = !tabbed || sideFallback;
  const info = snap.info;
  const turn = info?.view.state.turn === true;
  const { inputActions, draftPollMs } = props;
  const [held, setHeld] = React10.useState();
  const [dropped, setDropped] = React10.useState(0);
  const heldRef = React10.useRef(void 0);
  React10.useEffect(() => {
    if (!inputActions) return void 0;
    const take = () => void restoreReturnedDrafts(api, store.sessionId, inputActions, heldRef.current).then(
      (r) => {
        heldRef.current = r.held;
        setHeld(r.held);
        if (r.droppedAttachments > 0) setDropped((n2) => n2 + r.droppedAttachments);
        if (r.inserted !== void 0 && r.droppedAttachments === 0) setDropped(0);
      },
      () => void 0
    );
    if (!turn) {
      take();
      const late = setTimeout(take, 2e3);
      return () => clearTimeout(late);
    }
    const timer = setInterval(take, draftPollMs ?? 1500);
    return () => clearInterval(timer);
  }, [turn, api, store, inputActions, draftPollMs]);
  const prefillSeq = snap.prefillRequest?.seq ?? 0;
  const prefillSeen = React10.useRef(0);
  const [sidePrefill, setSidePrefill] = React10.useState();
  const [heldPrefill, setHeldPrefill] = React10.useState();
  React10.useEffect(() => {
    const done = takePrefill(store.getSnapshot().prefillRequest, prefillSeen.current, inputActions);
    if (!done) return;
    prefillSeen.current = done.seq;
    if (done.kind === "side") {
      if (tabbed && !store.claimSideOpen(done.seq)) return;
      if (tabbed && actions.openSideChat?.(store.sessionId) === true) return;
      if (tabbed) store.takeSidePrefill();
      setSideFallback(true);
      setSidePrefill({ text: done.text, seq: done.seq });
      setSideWanted(true);
    } else setHeldPrefill(done.kind === "held" ? done.text : void 0);
  }, [prefillSeq, inputActions, store, tabbed, actions]);
  const latestSideId = snap.status === "ready" ? latestSide(info?.view.side)?.id ?? null : void 0;
  const sideBaseline = React10.useRef(void 0);
  React10.useEffect(() => {
    if (!tabbed || latestSideId === void 0) return;
    if (sideBaseline.current === void 0) {
      sideBaseline.current = latestSideId;
      return;
    }
    if (latestSideId === null || latestSideId === sideBaseline.current) return;
    sideBaseline.current = latestSideId;
    openSide(true);
  }, [tabbed, latestSideId, openSide]);
  const barRef = React10.useRef(null);
  const preset = props.useProjection ? props.useProjection("agentPreset") : void 0;
  const presetOurs = actions.isOurPreset?.(preset) === true;
  React10.useEffect(() => store.notePreset(presetOurs), [store, presetOurs]);
  const ready = snap.status === "ready" && info !== void 0;
  const seatOff = ready || presetOurs && snap.status !== "error";
  React10.useEffect(() => {
    if (!seatOff || !actions.hideNativeSeat) return void 0;
    const hidden = actions.hideNativeSeat(barRef.current);
    return () => hidden.undo();
  }, [seatOff, ready, actions]);
  const draftNote = dropped > 0 ? `The stopped message had ${dropped === 1 ? "an attachment" : `${dropped} attachments`} that cannot go back into the composer; attach ${dropped === 1 ? "it" : "them"} again.` : void 0;
  const status = info ? snap.error ?? statusLine(info, { exitShown: exitBanner(info) !== void 0 }) ?? draftNote ?? snap.note : void 0;
  const notice = info?.view.live.notice;
  const statusError = status !== void 0 && (status === snap.error || notice?.level === "warning" && status.endsWith(notice.text));
  const phase = useFade(status, statusError, props.fadeTimers);
  if (snap.status !== "ready" || !info)
    return seatOff ? /* @__PURE__ */ React10.createElement("span", { "data-raw-agent": "controls-pending", ref: barRef, style: { display: "none" } }) : null;
  const choose = (c) => void store.choose(c);
  const model = modelSelect(info);
  const effort = effortSelect(info);
  const mode = modeSelect(info);
  const agent = agentSelect(info);
  const name2 = info.backend.displayName;
  const asks = info.view.asks ?? [];
  const inComposer = typeof props.asksInComposer === "function" ? props.asksInComposer() : props.asksInComposer === true;
  return /* @__PURE__ */ React10.createElement("span", { style: css.bar, "data-raw-agent": "controls", ref: barRef }, /* @__PURE__ */ React10.createElement("style", { "data-raw-agent": "chip-style" }, CHIP_CSS), asks.length > 0 && !inComposer && /* @__PURE__ */ React10.createElement("span", { style: css.ask, "data-raw-agent": "ask-inline" }, /* @__PURE__ */ React10.createElement(AskPanel, { store, actions })), /* @__PURE__ */ React10.createElement(
    Picker,
    {
      testId: "model",
      selectRef: modelRef,
      label: `${name2} model for this session`,
      model,
      chip: modelChip(info),
      disabled: snap.busy,
      onPick: (value) => {
        if (value === START_OPTION) void store.start();
        else if (value !== model.value) choose({ model: value });
      }
    }
  ), effort && /* @__PURE__ */ React10.createElement(
    Picker,
    {
      testId: "effort",
      label: `${name2} effort for this session`,
      model: effort,
      chip: effortChip(info),
      disabled: snap.busy,
      onPick: (value) => value !== effort.value && choose({ effort: value === SETTINGS ? null : value })
    }
  ), /* @__PURE__ */ React10.createElement(
    Picker,
    {
      testId: "mode",
      label: `${name2} permission mode for this session`,
      model: mode,
      chip: modeChip(info),
      disabled: snap.busy,
      onPick: (value) => value !== mode.value && choose({ mode: value })
    }
  ), agent && /* @__PURE__ */ React10.createElement(
    Picker,
    {
      testId: "agent",
      label: `${name2} main-thread agent for this new session`,
      model: agent,
      chip: {
        text: agent.options.find((o) => o.value === agent.value)?.label ?? agent.value,
        fromSettings: false,
        full: agent.options.find((o) => o.value === agent.value)?.label ?? agent.value
      },
      disabled: snap.busy || agent.locked,
      onPick: (value) => {
        if (value === START_OPTION) void store.start();
        else if (value !== agent.value) choose({ agent: value === SETTINGS ? null : value });
      }
    }
  ), api.mcp && /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      className: CHIP_CLASS,
      "data-raw-agent": "mcp-button",
      title: `${name2} MCP servers and commands`,
      onClick: () => setMcpPanel(true)
    },
    mcpButtonLabel(info.view.mcp)
  ), api.askSide && tabbed && /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      className: CHIP_CLASS,
      "data-raw-agent": "side-button",
      title: "Open the side chat in the right sidebar (not part of the conversation)",
      "aria-label": `Side chat with ${name2} (not part of the conversation)`,
      onClick: () => openSide()
    },
    "Side chat"
  ), !tabbed && (info.view.side?.entries.length ?? 0) > 0 && !sideShown && /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      className: CHIP_CLASS,
      "data-raw-agent": "side-button",
      title: "Show the side questions (not part of the conversation)",
      onClick: () => setSideWanted(true)
    },
    "Side questions"
  ), api.askSide && inlineSide && /* @__PURE__ */ React10.createElement(
    SidePanel,
    {
      store,
      api,
      actions,
      displayName: name2,
      open: sideWanted,
      onOpenChange: onSideOpen,
      ...sidePrefill ? { prefill: sidePrefill } : {}
    }
  ), api.rewind && /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      className: CHIP_CLASS,
      "data-raw-agent": "rewind-button",
      title: `Go back to an earlier message: restore the conversation (a new branch), the code, or both`,
      onClick: () => setRewindPanel(true)
    },
    "Rewind"
  ), /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      className: CHIP_CLASS,
      "data-raw-agent": "settings-button",
      title: `Open your ${name2} settings files (read-only)`,
      onClick: () => setPanel(true)
    },
    "Settings files"
  ), held !== void 0 && /* @__PURE__ */ React10.createElement("span", { style: css.status, "data-raw-agent": "held-draft" }, "Your stopped message could not go back into the composer yet: \u201C", held, "\u201D", " ", /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      onClick: () => void actions.copy(held).then((ok) => {
        if (!ok) return;
        heldRef.current = void 0;
        setHeld(void 0);
      })
    },
    "Copy it"
  )), heldPrefill !== void 0 && /* @__PURE__ */ React10.createElement("span", { style: css.status, "data-raw-agent": "held-prefill" }, "Text from another plugin could not go into the composer: \u201C", heldPrefill, "\u201D", " ", /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: css.button,
      onClick: () => void actions.copy(heldPrefill).then((ok) => {
        if (ok) setHeldPrefill(void 0);
      })
    },
    "Copy it"
  ), " ", /* @__PURE__ */ React10.createElement("button", { type: "button", style: css.button, onClick: () => setHeldPrefill(void 0) }, "Dismiss")), status && /* @__PURE__ */ React10.createElement(
    "span",
    {
      className: STATUS_CLASS,
      "data-raw-agent": "status",
      role: "status",
      "aria-live": "polite",
      "data-level": statusError ? "error" : "info",
      ...phase === "fading" ? { "data-fading": "" } : {},
      ...phase === "faded" ? { "data-faded": "" } : {}
    },
    status
  ), mcpPanel && actions.portal(
    /* @__PURE__ */ React10.createElement(
      McpPanel,
      {
        sessionId: store.sessionId,
        api,
        actions,
        displayName: name2,
        onStart: () => void store.start(),
        onServers: () => void store.refresh(),
        onClose: closeMcp
      }
    )
  ), rewindPanel && actions.portal(
    /* @__PURE__ */ React10.createElement(
      RewindPanel,
      {
        sessionId: store.sessionId,
        api,
        actions,
        store,
        ...props.stores ? { stores: props.stores } : {},
        onClose: closeRewind
      }
    )
  ), panel && actions.portal(
    /* @__PURE__ */ React10.createElement(
      SettingsPanel,
      {
        sessionId: store.sessionId,
        api,
        actions,
        displayName: name2,
        ...info.settings?.keys ? { keys: info.settings.keys } : {},
        ...props.plugin ? { plugin: props.plugin } : {},
        onClose: close
      }
    )
  ));
}

// packages/dsh-client/src/ui/side-chat-tab.tsx
var React11 = __toESM(require("react"), 1);
var noTabInfo = () => ({});
function sideChatElsewhereText(agentNames = []) {
  const names = agentNames.length > 0 ? agentNames.join(" or ") : "agent";
  return `Side chat works only in ${names} sessions. This session runs another agent.`;
}
function SideChatTab(props) {
  const useInfo = props.useTabInfo ?? noTabInfo;
  const info = useInfo();
  const { sessionId, stores, api } = props;
  const store = React11.useMemo(() => sessionId ? stores.get(sessionId) : void 0, [stores, sessionId]);
  if (!store) return /* @__PURE__ */ React11.createElement(Note, { text: "Open a session to use the side chat." });
  return /* @__PURE__ */ React11.createElement(SideChatSession, { ...props, store, info, api });
}
function Note(props) {
  return /* @__PURE__ */ React11.createElement("section", { "aria-label": "Side chat", "data-raw-agent": "side-chat-note", style: { padding: 12, fontSize: 13 } }, /* @__PURE__ */ React11.createElement("span", { style: css.hint }, props.text));
}
function SideChatSession(props) {
  const { store, api, info } = props;
  const snap = React11.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { busy, error, ask, cancel } = useSideAsk(store, api);
  const inputRef = React11.useRef(null);
  const [prefill, setPrefill] = React11.useState();
  const prefillSeq = snap.prefillRequest?.seq;
  const ready = snap.status === "ready" && snap.info !== void 0;
  React11.useEffect(() => {
    if (!ready) return;
    const p = store.takeSidePrefill();
    if (p) setPrefill(p);
  }, [store, prefillSeq, ready]);
  const revision = info.tab?.navigation?.revision;
  const visible = info.tab?.visible !== false;
  React11.useEffect(() => {
    if (ready && visible) inputRef.current?.focus?.();
  }, [revision, prefill?.seq, ready, visible]);
  const side = snap.info?.view.side;
  const now = useTick((side?.entries ?? []).some((e) => e.status === "asking"));
  if (snap.status === "absent") return /* @__PURE__ */ React11.createElement(Note, { text: sideChatElsewhereText(props.agentNames) });
  if (!ready) return /* @__PURE__ */ React11.createElement(Note, { text: snap.status === "error" ? `Side chat: ${snap.error ?? "no answer"}` : "Loading\u2026" });
  return /* @__PURE__ */ React11.createElement(
    SidePanelBody,
    {
      variant: "tab",
      side,
      displayName: snap.info.backend.displayName,
      ...props.command ? { command: props.command } : {},
      busy,
      ...error ? { error } : {},
      now,
      onAsk: ask,
      onCancel: cancel,
      onStart: () => void store.start(),
      inputRef,
      ...prefill ? { prefill } : {}
    }
  );
}

// packages/dsh-client/src/ui/usage-panel.tsx
var React12 = __toESM(require("react"), 1);

// packages/dsh-client/src/usage-model.ts
function formatCount(n2) {
  if (n2 === void 0 || !Number.isFinite(n2)) return "\u2014";
  const a = Math.abs(n2);
  const trim = (x) => String(Math.round(x * 10) / 10);
  if (a < 1e3) return String(Math.round(n2));
  if (a < 1e6) return `${a < 1e5 ? trim(n2 / 1e3) : Math.round(n2 / 1e3)}k`;
  return `${trim(n2 / 1e6)}M`;
}
function exactCount(n2) {
  if (n2 === void 0 || !Number.isFinite(n2)) return "\u2014";
  return Math.round(n2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function formatUsd(x) {
  if (x === void 0 || !Number.isFinite(x)) return "\u2014";
  if (x === 0) return "$0.00";
  if (Math.abs(x) < 0.1) return `$${x.toFixed(4).replace(/0{1,2}$/, "")}`;
  if (Math.abs(x) < 100) return `$${x.toFixed(2)}`;
  return `$${Math.round(x)}`;
}
function formatIn(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  if (ms < 6e4) return `in ${Math.max(1, Math.round(ms / 1e3))} s`;
  const min = Math.round(ms / 6e4);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 === 0 ? `in ${h} h` : `in ${h} h ${min % 60} min`;
  return `in ${Math.round(h / 24)} days`;
}
function formatClock(at) {
  try {
    return new Date(at).toLocaleString(void 0, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Date(at).toISOString();
  }
}
function resetText(resetsAt, now) {
  if (resetsAt === void 0 || !Number.isFinite(resetsAt)) return void 0;
  return `resets ${formatIn(resetsAt - now)} (${formatClock(resetsAt)})`;
}
function latestContext(...list) {
  let best;
  for (const c of list) if (c !== void 0 && (best === void 0 || c.at >= best.at)) best = c;
  return best;
}
var CONTEXT_WARN_PERCENT = 70;
var CONTEXT_HIGH_OF_COMPACT = 0.9;
function contextLevel(c) {
  if (c.autoCompactAt !== void 0 && c.autoCompactAt > 0) {
    if (c.used >= c.autoCompactAt * CONTEXT_HIGH_OF_COMPACT) return "high";
    if (c.used >= c.autoCompactAt * 0.75) return "warn";
    return "ok";
  }
  if (c.percent >= 90) return "high";
  return c.percent >= CONTEXT_WARN_PERCENT ? "warn" : "ok";
}
var sourceNote = (source, name2) => source === "report" ? `${name2}'s own context report.` : source === "compaction" ? `After the last compaction (${name2}'s figure). The breakdown refills at the next report.` : `From the last model call (input + cache read + cache write), as ${name2}'s status line counts it.`;
function percentText(p) {
  if (!Number.isFinite(p)) return "\u2014";
  return p < 10 ? `${Math.round(p * 10) / 10}%` : `${Math.round(p)}%`;
}
function contextPill(info, report, now = Date.now()) {
  const name2 = info.backend.displayName;
  const v4 = info.view;
  const s2 = v4.usage;
  const c = latestContext(s2?.context, report);
  const background = v4.state.backgroundTasks ?? 0;
  const running = v4.state.process !== "none";
  const extras = [];
  const lines = [];
  let model;
  if (s2?.compacting) {
    model = { text: "Compacting\u2026", extras, title: "", level: "busy", startable: false, background };
    lines.push(`${name2} is compacting the conversation.`);
  } else if (c === void 0) {
    const startable = !running && info.needsProcess.includes("context");
    model = { text: "Context \u2014", extras, title: "", level: "unknown", startable, background };
    lines.push(
      running ? `${name2} has not reported its context yet.` : `No ${name2} process runs, so the context cannot be read. ${startable ? `Start ${name2} to read it.` : ""}`.trim()
    );
  } else {
    model = {
      text: `Context ${percentText(c.percent)} \xB7 ${formatCount(c.used)}/${formatCount(c.window)}`,
      extras,
      title: "",
      percent: c.percent,
      level: contextLevel(c),
      startable: false,
      background
    };
    lines.push(`${exactCount(c.used)} of ${exactCount(c.window)} tokens in context (${percentText(c.percent)}).`);
    if (c.autoCompactAt !== void 0)
      lines.push(
        `Auto-compact at ${exactCount(c.autoCompactAt)} tokens (${percentText(c.autoCompactAt / c.window * 100)}).`
      );
    lines.push(sourceNote(c.source, name2));
    if (!running) lines.push(`Last known figure: no ${name2} process runs now.`);
  }
  if (s2?.blocked) extras.push("Limit reached");
  else if (s2?.limit?.percent !== void 0) extras.push(`${s2.limit.label} ${percentText(s2.limit.percent)}`);
  else if (s2?.costLabel?.primary === true && s2.costUsd !== void 0 && s2.costUsd > 0)
    extras.push(formatUsd(s2.costUsd));
  if (s2?.limit?.percent !== void 0) {
    const reset = resetText(s2.limit.resetsAt, now);
    lines.push(`Plan: ${s2.limit.label} window ${percentText(s2.limit.percent)} used${reset ? `, ${reset}` : ""}.`);
  }
  if (s2?.costUsd !== void 0 && s2.costLabel)
    lines.push(
      `Cost so far: ${formatUsd(s2.costUsd)} (${s2.costLabel.text}).${s2.costLabel.warning ? ` ${s2.costLabel.warning}` : ""}`
    );
  if (s2?.retry) {
    extras.push(
      `Retrying${s2.retry.maxRetries ? ` ${s2.retry.attempt}/${s2.retry.maxRetries}` : ` (${s2.retry.attempt})`}`
    );
    lines.push(`The model call is being retried: ${s2.retry.error}`);
  }
  if (background > 0) {
    extras.push(`${background} in background`);
    lines.push(
      `${background === 1 ? "A background task still runs" : `${background} background tasks still run`}; its tokens count when ${name2} reports them.`
    );
  }
  lines.push("Click for the usage panel.");
  model.title = lines.join("\n");
  return model;
}
var THEME_COLORS = {
  promptBorder: "#8a8a8a",
  inactive: "#9e9e9e",
  permission: "#8c94e8",
  suggestion: "#8c94e8",
  remember: "#8c94e8",
  warning: "#e0a526",
  success: "#3fa34d",
  error: "#d9534f",
  text: "#6b6b6b",
  red: "#d9534f",
  green: "#3fa34d",
  blue: "#4a8fe7",
  purple: "#9b59b6",
  orange: "#e67e22",
  pink: "#e86fa8",
  cyan: "#20a5b8",
  yellow: "#d4b106"
};
var PALETTE = ["#4a8fe7", "#9b59b6", "#3fa34d", "#e0a526", "#e67e22", "#20a5b8", "#e86fa8", "#d9534f"];
function categoryColor(color, index) {
  if (color !== void 0) {
    const base = color.replace(/_FOR_SUBAGENTS_ONLY$/, "");
    const hit = THEME_COLORS[base];
    if (hit !== void 0) return hit;
    if (/^#[0-9a-f]{3,8}$/i.test(base)) return base;
  }
  return PALETTE[index % PALETTE.length];
}
var kindOf = (k, id) => {
  if (k === "free" || k === "buffer" || k === "deferred" || k === "used") return k;
  if (id === "free_space") return "free";
  if (id === "autocompact_buffer") return "buffer";
  return "used";
};
function contextBreakdown(c, name2) {
  const out = {
    head: `${formatCount(c.used)} / ${formatCount(c.window)} tokens (${percentText(c.percent)})`,
    source: sourceNote(c.source, name2),
    rows: [],
    deferred: []
  };
  if (c.model !== void 0) out.model = c.model;
  if (c.autoCompactEnabled === false) out.autoCompact = "Auto-compact is off";
  else if (c.autoCompactAt !== void 0)
    out.autoCompact = `Auto-compact at ${formatCount(c.autoCompactAt)} (${percentText(c.autoCompactAt / c.window * 100)})`;
  const cats = c.categories ?? [];
  if (cats.length === 0) {
    out.note = c.source === "call" ? `${name2} reported only a total for the last call. The breakdown shows after its next context report.` : `${name2} reported no categories.`;
    return out;
  }
  cats.forEach((cat, i) => {
    const kind = kindOf(cat.kind, cat.id);
    const row = {
      key: cat.id ?? `${i}:${cat.name}`,
      name: cat.name,
      tokens: cat.tokens,
      percent: c.window > 0 ? cat.tokens / c.window * 100 : 0,
      kind,
      color: kind === "free" ? "transparent" : categoryColor(cat.color, i)
    };
    (kind === "deferred" ? out.deferred : out.rows).push(row);
  });
  return out;
}
function tokenLines(t) {
  const lines = [
    { label: "Input", value: exactCount(t.input) },
    { label: "Cache read", value: exactCount(t.cacheRead) },
    { label: "Cache write", value: exactCount(t.cacheWrite) },
    { label: "Output", value: exactCount(t.output) }
  ];
  if (t.reasoning !== void 0) lines.push({ label: "of which thinking", value: exactCount(t.reasoning) });
  const hit = cacheHitRatio(t);
  if (hit !== void 0) lines.push({ label: "Cache hit", value: percentText(hit * 100) });
  return lines;
}
function costText(costUsd, label2) {
  if (costUsd === void 0) return "Not reported";
  return label2 ? `${formatUsd(costUsd)} \xB7 ${label2.text}` : formatUsd(costUsd);
}
var BASIS_TEXT = { list: "list price", managed: "managed price", unknown: "unknown price" };
function modelRows(models) {
  return models.map((m) => {
    const details = [];
    details.push(
      `in ${exactCount(m.tokens.input)} \xB7 cache read ${exactCount(m.tokens.cacheRead)} \xB7 cache write ${exactCount(m.tokens.cacheWrite)} \xB7 out ${exactCount(m.tokens.output)}`
    );
    if (m.contextWindow !== void 0) details.push(`context window ${formatCount(m.contextWindow)}`);
    if (m.maxOutputTokens !== void 0) details.push(`max output ${formatCount(m.maxOutputTokens)}`);
    if (m.webSearches !== void 0 && m.webSearches > 0) details.push(`${m.webSearches} web searches`);
    if (m.costBasis !== void 0) details.push(BASIS_TEXT[m.costBasis]);
    if (m.provider !== void 0) details.push(`served by ${m.provider}`);
    return {
      model: m.model,
      tokens: `${formatCount(totalTokens(m.tokens))} tokens`,
      cost: formatUsd(m.costUsd),
      details
    };
  });
}
function turnRows(rows, label2) {
  return [...rows].reverse().map((r, i) => {
    const u = r.usage;
    const facts = [`${u.calls} main-thread call${u.calls === 1 ? "" : "s"}`];
    facts.push(u.durationMs !== void 0 ? `took ${formatDuration(u.durationMs) ?? "\u2014"}` : "duration not reported");
    if (u.apiDurationMs > 0) facts.push(`model time ${formatDuration(u.apiDurationMs) ?? "\u2014"}`);
    facts.push(u.ttftMs !== void 0 ? `first token after ${formatMs(u.ttftMs)}` : "first-token time not reported");
    const otherTotal = totalTokens(u.other);
    const row = {
      key: `${r.at}:${i}`,
      label: r.hostTurn !== void 0 ? `Turn ${r.hostTurn}` : "Background",
      total: `${exactCount(totalTokens(u.total))} tokens`,
      main: tokenLines(u.main),
      cost: costText(u.costUsd, label2),
      facts,
      models: u.models.map((m) => m.model).join(", ") || "not reported"
    };
    if (otherTotal > 0)
      row.other = `${exactCount(otherTotal)} tokens (in ${exactCount(u.other.input)} \xB7 cache read ${exactCount(u.other.cacheRead)} \xB7 cache write ${exactCount(u.other.cacheWrite)} \xB7 out ${exactCount(u.other.output)})`;
    return row;
  });
}
var formatMs = (ms) => ms < 1e3 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
function agentUsageRows(children, runs) {
  const out = [];
  for (const c of children) {
    if (c.role === "workflow-agent") continue;
    const facts = [c.status];
    if (c.toolUses !== void 0) facts.push(`${c.toolUses} tool use${c.toolUses === 1 ? "" : "s"}`);
    const d = formatDuration(c.durationMs);
    if (d) facts.push(d);
    out.push({
      key: `c:${c.id}`,
      kind: c.role === "teammate" ? "teammate" : "subagent",
      label: c.name ?? c.label,
      tokens: c.tokens !== void 0 ? `${formatCount(c.tokens)} tokens` : "tokens not reported yet",
      facts
    });
  }
  for (const r of runs) {
    const t = workflowTokens(r);
    const facts = [r.status, `${r.agents.length} agent${r.agents.length === 1 ? "" : "s"}`];
    if (r.usage?.toolUses !== void 0) facts.push(`${r.usage.toolUses} tool uses`);
    out.push({
      key: `w:${r.taskId}`,
      kind: "workflow",
      label: r.label ?? r.name,
      tokens: t !== void 0 ? `${formatCount(t)} tokens` : "tokens not reported yet",
      facts
    });
    for (const a of r.agents)
      out.push({
        key: `w:${r.taskId}:${a.index}`,
        kind: "workflow-agent",
        label: a.label,
        tokens: a.tokens !== void 0 ? `${formatCount(a.tokens)} tokens` : "not reported yet",
        facts: [a.state, ...a.model ? [a.model] : []]
      });
  }
  return out;
}
var STATUS_TEXT2 = { allowed: void 0, allowed_warning: "near the limit", rejected: "limit reached" };
function limitsModel(u, running, name2, now = Date.now()) {
  const l = u?.limits;
  if (l === void 0 || l.available === void 0)
    return {
      rows: [],
      note: running ? `${name2} has not said yet whether this account has plan limits.` : `Not known yet. Start ${name2} to read the account's plan limits.`
    };
  if (l.available === false) {
    const who = u?.auth?.label;
    return { rows: [], note: l.note ?? `No plan limits for this account${who ? ` (${who})` : ""}.` };
  }
  const out = { rows: [] };
  for (const w of l.limits) {
    const row = {
      id: w.id,
      label: w.label,
      value: w.percent !== void 0 ? `${percentText(w.percent)} used` : "not reported"
    };
    if (w.percent !== void 0) row.bar = Math.max(0, Math.min(100, w.percent));
    const reset = resetText(w.resetsAt, now);
    if (reset) row.reset = reset;
    const st = w.status ? STATUS_TEXT2[w.status] : void 0;
    if (st) row.status = st;
    out.rows.push(row);
  }
  if (out.rows.length === 0)
    out.note = l.note ?? `${name2} has not reported a plan window yet (it does after a request).`;
  if (l.blocked) {
    const reset = resetText(l.blocked.resetsAt, now);
    out.blocked = `Requests are refused until the limit resets${reset ? ` (${reset})` : ""}.`;
  }
  if (l.overage) {
    const o = l.overage;
    const parts = [
      o.inUse ? "in use" : o.status === "rejected" ? "not available" : o.status ? "available" : "reported"
    ];
    const reset = resetText(o.resetsAt, now);
    if (reset) parts.push(reset);
    if (o.disabledReason) parts.push(o.disabledReason);
    out.overage = `Extra usage: ${parts.join(", ")}.`;
  }
  return out;
}
var AUTH_KIND_TEXT = {
  subscription: "Subscription plan",
  "api-key": "API key (pay as you go)",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  cloud: "Cloud provider",
  gateway: "Gateway",
  unknown: "Not reported"
};
function accountModel(u, name2) {
  const a = u?.auth;
  const lines = [];
  if (!a) lines.push({ label: "Account", value: `${name2} has not reported how this session is billed yet.` });
  else {
    lines.push({ label: "Account", value: a.label });
    lines.push({ label: "Type", value: AUTH_KIND_TEXT[a.kind] ?? a.kind });
    if (a.subscriptionType) lines.push({ label: "Plan", value: a.subscriptionType });
    if (a.apiKeySource) lines.push({ label: "Key from", value: a.apiKeySource });
    if (a.provider) lines.push({ label: "Provider", value: a.provider });
    if (a.credentialExpiresAt !== void 0)
      lines.push({ label: "Login valid until", value: formatClock(a.credentialExpiresAt) });
  }
  const costNote = [];
  const l = u?.costLabel;
  if (l) {
    costNote.push(
      l.primary ? `Cost is ${name2}'s ${l.text}.` : `Cost is ${l.text}: what the same use would cost with an API key. The plan limits are what counts here.`
    );
    if (l.note) costNote.push(l.note);
    if (l.warning) costNote.push(l.warning);
  } else costNote.push("How the cost is priced is not known yet.");
  return { lines, costNote };
}
function usagePanelModel(info, answer, report, now = Date.now()) {
  const name2 = info.backend.displayName;
  const v4 = info.view;
  const running = answer?.running ?? v4.state.process !== "none";
  const u = answer?.usage;
  const m = {
    name: name2,
    running,
    startable: v4.state.process === "none" && info.needsProcess.includes("usage"),
    models: u?.totals ? modelRows(u.totals.models) : [],
    turns: turnRows(u?.turns ?? [], u?.costLabel),
    agents: agentUsageRows(v4.children ?? [], v4.workflows ?? []),
    limits: limitsModel(u, running, name2, now),
    account: accountModel(u, name2),
    events: []
  };
  if (u?.totals) {
    const t = u.totals;
    m.totals = {
      tokens: tokenLines(t.tokens),
      total: `${exactCount(totalTokens(t.tokens))} tokens`,
      cost: costText(t.costUsd, u.costLabel)
    };
    if (t.apiDurationMs > 0) m.totals.apiTime = formatDuration(t.apiDurationMs) ?? "\u2014";
  }
  const ctx = latestContext(u?.context, report);
  if (ctx) m.context = contextBreakdown(ctx, name2);
  else
    m.contextNote = running ? `${name2} has not reported its context yet.` : `No ${name2} process runs. Start it to read the context.`;
  if (u?.compacting) m.events.push("Compacting now\u2026");
  for (const c of [...u?.compactions ?? []].reverse()) {
    if (c.phase !== "end") continue;
    const how = c.trigger === "auto" ? "Auto-compacted" : "Compacted";
    m.events.push(
      c.error ? `${how}: failed (${c.error})` : `${how}${c.preTokens !== void 0 ? ` from ${formatCount(c.preTokens)}` : ""}${c.postTokens !== void 0 ? ` to ${formatCount(c.postTokens)}` : ""} tokens \xB7 ${formatClock(c.at)}`
    );
  }
  for (const r of [...u?.resets ?? []].reverse())
    m.events.push(
      `Conversation cleared${r.trigger ? ` (${r.trigger})` : ""} \xB7 totals restart at 0 \xB7 ${formatClock(r.at)}`
    );
  for (const r of u?.retries ?? [])
    m.events.push(
      `Retry ${r.attempt}${r.maxRetries ? `/${r.maxRetries}` : ""}: ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`
    );
  const bg = v4.state.backgroundTasks ?? 0;
  if (bg > 0)
    m.background = `${bg === 1 ? "1 background task runs" : `${bg} background tasks run`}. Its tokens count when ${name2} reports them (when it ends, or at the next turn).`;
  if (answer?.error)
    m.error = `${name2}'s usage report could not be read: ${answer.error}. The figures are the last known ones.`;
  return m;
}

// packages/dsh-client/src/ui/usage-panel.tsx
var v2 = (name2, alias, fallback) => `var(--raw-agent-${name2}, var(--dsw-alias-${alias}, ${fallback}))`;
var muted5 = v2("muted", "label-secondary", "GrayText");
var border5 = v2("border", "border-l2", "rgba(128,128,128,0.35)");
var LEVEL_COLOR2 = {
  unknown: border5,
  ok: border5,
  warn: v2("context-warn", "state-warn-primary", "#e0a526"),
  high: v2("context-high", "state-error-primary", "#d9534f"),
  busy: v2("context-busy", "state-business-primary", "#4a8fe7")
};
var styles5 = {
  pill: {
    ...css.button,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontVariantNumeric: "tabular-nums",
    borderRadius: 999,
    padding: "1px 8px"
  },
  ring: { flex: "none" },
  extra: { color: muted5 },
  popover: {
    position: "fixed",
    bottom: 96,
    right: 16,
    zIndex: 1e3,
    width: "min(620px, 94vw)",
    maxHeight: "76vh",
    overflow: "auto",
    boxShadow: "0 6px 24px rgba(0,0,0,0.25)"
  },
  tabs: { display: "flex", gap: 4, flexWrap: "wrap" },
  tab: { fontWeight: 600 },
  section: { display: "flex", flexDirection: "column", gap: 6 },
  heading: { fontWeight: 600, fontSize: 12 },
  dl: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", margin: 0, fontSize: 12 },
  dt: { color: muted5 },
  dd: { margin: 0, fontVariantNumeric: "tabular-nums" },
  bar: {
    display: "flex",
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    border: `1px solid ${border5}`
  },
  swatch: { display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 6, flex: "none" },
  catRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
  catName: { flex: "1 1 auto", minWidth: 0 },
  num: { fontVariantNumeric: "tabular-nums", color: muted5 },
  card: { borderTop: `1px solid ${border5}`, paddingTop: 6, display: "flex", flexDirection: "column", gap: 2 },
  limitBar: { height: 6, borderRadius: 3, background: border5, overflow: "hidden" },
  note: { ...css.hint, margin: 0 }
};
function Ring(props) {
  const r = 5.5;
  const len = 2 * Math.PI * r;
  const p = props.percent === void 0 ? 0 : Math.max(0, Math.min(100, props.percent));
  return /* @__PURE__ */ React12.createElement("svg", { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": true, style: styles5.ring }, /* @__PURE__ */ React12.createElement("circle", { cx: "7", cy: "7", r, fill: "none", stroke: border5, strokeWidth: "2" }), props.percent !== void 0 && /* @__PURE__ */ React12.createElement(
    "circle",
    {
      cx: "7",
      cy: "7",
      r,
      fill: "none",
      stroke: props.level === "ok" ? "currentColor" : LEVEL_COLOR2[props.level],
      strokeWidth: "2",
      strokeDasharray: `${len * p / 100} ${len}`,
      transform: "rotate(-90 7 7)"
    }
  ));
}
function ContextPillView(props) {
  const { model } = props;
  return /* @__PURE__ */ React12.createElement(
    "button",
    {
      type: "button",
      style: { ...styles5.pill, borderColor: LEVEL_COLOR2[model.level] },
      "data-raw-agent": "context-pill",
      "data-level": model.level,
      "aria-haspopup": "dialog",
      "aria-expanded": props.open === true,
      "aria-label": model.text,
      title: model.title,
      onClick: props.onClick
    },
    /* @__PURE__ */ React12.createElement(Ring, { level: model.level, ...model.percent !== void 0 ? { percent: model.percent } : {} }),
    /* @__PURE__ */ React12.createElement("span", null, model.text),
    model.extras.map((e) => /* @__PURE__ */ React12.createElement("span", { key: e, style: styles5.extra }, "\xB7 ", e))
  );
}
function ContextPill(props) {
  const { store, reader, actions } = props;
  const snap = React12.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const read2 = React12.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const [open, setOpen] = React12.useState(false);
  React12.useEffect(() => {
    if (!open) return void 0;
    reader.setOpen(true);
    return () => reader.setOpen(false);
  }, [open, reader]);
  const info = snap.info;
  if (snap.status !== "ready" || !info) return null;
  const model = contextPill(info, read2.context?.context);
  return /* @__PURE__ */ React12.createElement(React12.Fragment, null, /* @__PURE__ */ React12.createElement(ContextPillView, { model, open, onClick: () => setOpen(!open) }), open && actions.portal(
    /* @__PURE__ */ React12.createElement(
      UsagePanel,
      {
        model: usagePanelModel(info, read2.usage, read2.context?.context),
        reading: read2.reading,
        ...read2.error !== void 0 ? { error: read2.error } : {},
        busy: snap.busy,
        onStart: () => void store.start(),
        onRefresh: () => void reader.read({ usage: true, context: "full" }),
        onClose: () => setOpen(false)
      }
    )
  ));
}
function Lines(props) {
  return /* @__PURE__ */ React12.createElement("dl", { style: styles5.dl }, props.lines.map((l) => /* @__PURE__ */ React12.createElement(React12.Fragment, { key: l.label }, /* @__PURE__ */ React12.createElement("dt", { style: styles5.dt }, l.label), /* @__PURE__ */ React12.createElement("dd", { style: styles5.dd }, l.value))));
}
function ContextSection(props) {
  const b = props.breakdown;
  const color = (key, c) => `var(--raw-agent-context-${key.replace(/[^\w-]/g, "_")}, ${c})`;
  return /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-context" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.heading }, b.head, b.model ? ` \xB7 ${b.model}` : ""), b.rows.length > 0 && /* @__PURE__ */ React12.createElement("div", { style: styles5.bar, "aria-hidden": true }, b.rows.filter((r) => r.kind !== "free" && r.percent > 0).map((r) => /* @__PURE__ */ React12.createElement(
    "span",
    {
      key: r.key,
      title: `${r.name}: ${r.tokens}`,
      style: {
        width: `${r.percent}%`,
        background: color(r.key, r.color),
        opacity: r.kind === "buffer" ? 0.45 : 1
      }
    }
  ))), b.rows.map((r) => /* @__PURE__ */ React12.createElement("div", { key: r.key, style: styles5.catRow, "data-raw-agent": "usage-context-row", "data-kind": r.kind }, /* @__PURE__ */ React12.createElement(
    "span",
    {
      style: {
        ...styles5.swatch,
        background: color(r.key, r.color),
        border: r.kind === "free" ? `1px solid ${border5}` : "none",
        opacity: r.kind === "buffer" ? 0.45 : 1
      }
    }
  ), /* @__PURE__ */ React12.createElement("span", { style: styles5.catName }, r.name), /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, r.tokens.toLocaleString("en-US"), " (", r.percent < 10 ? r.percent.toFixed(1) : Math.round(r.percent), "%)"))), b.deferred.length > 0 && /* @__PURE__ */ React12.createElement(React12.Fragment, null, /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "Deferred (listed, loaded only when used; not in the context):"), b.deferred.map((r) => /* @__PURE__ */ React12.createElement("div", { key: r.key, style: styles5.catRow, "data-raw-agent": "usage-context-row", "data-kind": "deferred" }, /* @__PURE__ */ React12.createElement("span", { style: { ...styles5.swatch, background: "transparent", border: `1px dashed ${border5}` } }), /* @__PURE__ */ React12.createElement("span", { style: styles5.catName }, r.name), /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, r.tokens.toLocaleString("en-US"))))), b.autoCompact && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, b.autoCompact), b.note && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, b.note), /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, b.source));
}
function UsagePanel(props) {
  const m = props.model;
  const [tab, setTab] = React12.useState(props.initialTab ?? "context");
  const tabs = [
    ["context", "Context"],
    ["session", "Session"],
    ["turns", `Turns (${m.turns.length})`],
    ["agents", `Agents (${m.agents.filter((a) => a.kind !== "workflow-agent").length})`],
    ["limits", "Plan & account"]
  ];
  return /* @__PURE__ */ React12.createElement("div", { style: { ...css.card, ...styles5.popover }, "data-raw-agent": "usage-panel", role: "dialog", "aria-label": "Usage" }, /* @__PURE__ */ React12.createElement("div", { style: css.header }, /* @__PURE__ */ React12.createElement("div", { style: styles5.tabs, role: "tablist" }, tabs.map(([t, label2]) => /* @__PURE__ */ React12.createElement(
    "button",
    {
      key: t,
      type: "button",
      role: "tab",
      "aria-selected": tab === t,
      style: tab === t ? { ...css.button, ...styles5.tab } : css.button,
      "data-raw-agent": `usage-tab-${t}`,
      onClick: () => setTab(t)
    },
    label2
  ))), /* @__PURE__ */ React12.createElement("span", { style: css.row }, props.onRefresh && m.running && /* @__PURE__ */ React12.createElement("button", { type: "button", style: css.button, disabled: props.reading, onClick: props.onRefresh }, props.reading ? "Reading\u2026" : "Refresh"), props.onClose && /* @__PURE__ */ React12.createElement("button", { type: "button", style: css.button, onClick: props.onClose, "aria-label": "Close" }, "Close"))), m.startable && /* @__PURE__ */ React12.createElement("div", { style: css.row, "data-raw-agent": "usage-start" }, /* @__PURE__ */ React12.createElement("span", { style: styles5.note }, "No ", m.name, " process runs. The figures below are the last known ones."), props.onStart && /* @__PURE__ */ React12.createElement("button", { type: "button", style: css.primary, disabled: props.busy, onClick: props.onStart }, "Start ", m.name)), m.error && /* @__PURE__ */ React12.createElement("div", { style: css.error }, m.error), props.error && /* @__PURE__ */ React12.createElement("div", { style: css.error }, props.error), m.background && /* @__PURE__ */ React12.createElement("div", { style: styles5.note, "data-raw-agent": "usage-background" }, m.background), tab === "context" && (m.context ? /* @__PURE__ */ React12.createElement(ContextSection, { breakdown: m.context }) : /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, m.contextNote)), tab === "context" && m.events.length > 0 && /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-events" }, m.events.map((e, i) => /* @__PURE__ */ React12.createElement("div", { key: i, style: styles5.note }, e))), tab === "session" && /* @__PURE__ */ React12.createElement(SessionSection, { model: m }), tab === "turns" && /* @__PURE__ */ React12.createElement(TurnsSection, { model: m }), tab === "agents" && /* @__PURE__ */ React12.createElement(AgentsSection, { model: m }), tab === "limits" && /* @__PURE__ */ React12.createElement(LimitsSection, { model: m }));
}
function SessionSection({ model: m }) {
  if (!m.totals) return /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, m.name, " has not reported usage for this conversation yet.");
  return /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-session" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.heading }, "This conversation: ", m.totals.total), /* @__PURE__ */ React12.createElement(
    Lines,
    {
      lines: [
        ...m.totals.tokens,
        { label: "Cost", value: m.totals.cost },
        ...m.totals.apiTime ? [{ label: "Model time", value: m.totals.apiTime }] : []
      ]
    }
  ), m.account.costNote.map((n2) => /* @__PURE__ */ React12.createElement("div", { key: n2, style: styles5.note }, n2)), /* @__PURE__ */ React12.createElement("div", { style: styles5.heading }, "By model"), m.models.length === 0 ? /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "No model use reported yet.") : m.models.map((r) => /* @__PURE__ */ React12.createElement("div", { key: r.model, style: styles5.card, "data-raw-agent": "usage-model" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.catRow }, /* @__PURE__ */ React12.createElement("span", { style: styles5.catName }, r.model), /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, r.tokens, " \xB7 ", r.cost)), r.details.map((d) => /* @__PURE__ */ React12.createElement("div", { key: d, style: styles5.note }, d)))), /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "Totals cover this conversation, including subagents, workflow agents and compaction. A cleared conversation starts again at 0."));
}
function TurnsSection({ model: m }) {
  if (m.turns.length === 0) return /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "No turn finished in this process yet.");
  return /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-turns" }, m.turns.map((t) => /* @__PURE__ */ React12.createElement("div", { key: t.key, style: styles5.card, "data-raw-agent": "usage-turn" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.catRow }, /* @__PURE__ */ React12.createElement("span", { style: { ...styles5.catName, fontWeight: 600 } }, t.label), /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, t.total, " \xB7 ", t.cost)), /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "Main thread:"), /* @__PURE__ */ React12.createElement(Lines, { lines: t.main }), t.other && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "Subagents, workflow agents and compaction: ", t.other), /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, t.facts.join(" \xB7 "), " \xB7 ", t.models))));
}
function AgentsSection({ model: m }) {
  if (m.agents.length === 0) return /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "No subagents or workflows in this process yet.");
  return /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-agents" }, m.agents.map((a) => /* @__PURE__ */ React12.createElement(
    "div",
    {
      key: a.key,
      style: { ...styles5.catRow, paddingLeft: a.kind === "workflow-agent" ? 16 : 0 },
      "data-raw-agent": "usage-agent",
      "data-kind": a.kind
    },
    /* @__PURE__ */ React12.createElement("span", { style: styles5.catName }, a.kind === "workflow" ? "Workflow \xB7 " : a.kind === "teammate" ? "Teammate \xB7 " : "", a.label),
    /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, a.tokens, " \xB7 ", a.facts.join(" \xB7 "))
  )), /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, "These are ", m.name, `'s own counts: a child's figure is its last call's context plus output, not the sum of its calls. What a turn spent on children is in that turn's "Subagents, workflow agents and compaction" line.`));
}
function LimitsSection({ model: m }) {
  const l = m.limits;
  return /* @__PURE__ */ React12.createElement("div", { style: styles5.section, "data-raw-agent": "usage-limits" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.heading }, "Plan limits"), l.blocked && /* @__PURE__ */ React12.createElement("div", { style: css.error }, l.blocked), l.note && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, l.note), l.rows.map((r) => /* @__PURE__ */ React12.createElement("div", { key: r.id, style: styles5.card, "data-raw-agent": "usage-limit" }, /* @__PURE__ */ React12.createElement("div", { style: styles5.catRow }, /* @__PURE__ */ React12.createElement("span", { style: styles5.catName }, r.label), /* @__PURE__ */ React12.createElement("span", { style: styles5.num }, r.value, r.status ? ` \xB7 ${r.status}` : "")), r.bar !== void 0 && /* @__PURE__ */ React12.createElement("div", { style: styles5.limitBar }, /* @__PURE__ */ React12.createElement(
    "div",
    {
      style: {
        width: `${r.bar}%`,
        height: "100%",
        background: r.bar >= 90 ? LEVEL_COLOR2.high : r.bar >= 70 ? LEVEL_COLOR2.warn : "currentColor"
      }
    }
  )), r.reset && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, r.reset))), l.overage && /* @__PURE__ */ React12.createElement("div", { style: styles5.note }, l.overage), /* @__PURE__ */ React12.createElement("div", { style: styles5.heading }, "Account"), /* @__PURE__ */ React12.createElement(Lines, { lines: m.account.lines }));
}

// packages/dsh-client/src/ui/wake-card.tsx
var React13 = __toESM(require("react"), 1);
var muted6 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var border6 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
function WakeTriggerCard(props) {
  const t = props.trigger;
  const [open, setOpen] = React13.useState(false);
  const date = new Date(t.time);
  const time = Number.isFinite(date.getTime()) ? date.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" }) : "";
  const items = t.items;
  return /* @__PURE__ */ React13.createElement(
    "section",
    {
      "data-raw-agent": "wake-trigger",
      style: {
        border: `1px dashed ${border6}`,
        borderRadius: 10,
        padding: "6px 10px",
        margin: "6px 0",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4
      }
    },
    /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } }, /* @__PURE__ */ React13.createElement("span", { style: { fontWeight: 600 } }, wakeHeading(t)), items.length === 1 && /* @__PURE__ */ React13.createElement("span", { style: { color: muted6 } }, "after: ", items[0]), items.length > 1 && /* @__PURE__ */ React13.createElement("button", { type: "button", style: css.button, "aria-expanded": open, onClick: () => setOpen(!open) }, open ? "Hide" : `After ${items.length} background tasks ended`), time !== "" && /* @__PURE__ */ React13.createElement("time", { dateTime: date.toISOString(), style: { color: muted6, marginLeft: "auto" } }, time)),
    items.length === 0 && t.text !== wakeHeading(t) && /* @__PURE__ */ React13.createElement("span", { style: { color: muted6 } }, t.text),
    open && items.length > 1 && /* @__PURE__ */ React13.createElement("ul", { style: { margin: 0, paddingLeft: 18, color: muted6 } }, items.map((i, n2) => /* @__PURE__ */ React13.createElement("li", { key: n2 }, i))),
    /* @__PURE__ */ React13.createElement("span", { style: { color: muted6, fontSize: 11 } }, "Nobody typed a message: the agent started this turn by itself. This note is not sent to it.")
  );
}

// packages/dsh-client/src/client-service.ts
var PREFILL_MAX = 1e5;
function createRawAgentClientService(stores, plugin) {
  const backends = [];
  const noteBackend = (b) => {
    if (!backends.some((x) => x.kind === b.kind)) backends.push({ kind: b.kind, displayName: b.displayName });
  };
  const service = {
    apiVersion: RAW_AGENT_API_VERSION,
    backends,
    async sessionInfo(sessionId) {
      const info = await plugin.sessionInfo(sessionId);
      if (info) noteBackend(info.backend);
      return info;
    },
    interrupt: (sessionId) => plugin.interrupt(sessionId),
    send: (sessionId, text3, grant) => plugin.send(sessionId, text3, grant, "send"),
    steer: (sessionId, text3, grant) => plugin.send(sessionId, text3, grant, "steer"),
    askSideQuestion: (sessionId, question, grant) => plugin.askSideQuestion(sessionId, question, grant),
    onEvent(sessionId, listener) {
      if (typeof sessionId !== "string" || sessionId === "") return () => {
      };
      const store = stores.get(sessionId);
      let tracker;
      let seen = false;
      let stopped = false;
      const emit = (events) => {
        for (const e of events) {
          if (stopped) return;
          try {
            listener(e);
          } catch (error) {
            console.warn("[raw-agent] a plugin event listener failed", error);
          }
        }
      };
      const look = () => {
        const snap = store.getSnapshot();
        if (snap.status === "ready" && snap.info) {
          const b = snap.info.backend;
          noteBackend(b);
          tracker ??= new PublicEventTracker(sessionId, { kind: b.kind, displayName: b.displayName });
          seen = true;
          emit(tracker.update(snap.info.view));
        } else if (snap.status === "absent" && seen && tracker) emit(tracker.end());
      };
      const off = store.subscribe(look);
      look();
      return () => {
        stopped = true;
        off();
      };
    },
    async prefill(sessionId, text3, target = "composer") {
      if (typeof text3 !== "string" || text3 === "") throw new RawAgentServiceError("empty", "the text is empty");
      if (text3.length > PREFILL_MAX)
        throw new RawAgentServiceError("too-long", `the text is longer than ${PREFILL_MAX} characters`);
      const where = target === "side-question" ? "side-question" : "composer";
      const store = stores.get(sessionId);
      if (store.getSnapshot().status !== "ready") await store.refresh();
      const snap = store.getSnapshot();
      if (snap.status !== "ready" || !snap.info) return false;
      noteBackend(snap.info.backend);
      store.requestPrefill(text3, where);
      return true;
    }
  };
  return Object.freeze(service);
}

// packages/dsh-client/src/plugin-routes.ts
var BASE2 = "api/raw-agent";
var CODES = [
  "not-our-session",
  "no-grant",
  "bad-grant",
  "not-running",
  "empty",
  "too-long",
  "busy",
  "unsupported",
  "failed"
];
function codeOf(status, code) {
  if (typeof code === "string" && CODES.includes(code)) return code;
  return status === 404 ? "not-our-session" : "failed";
}
var isGrant = (g) => typeof g === "object" && g !== null && typeof g.id === "string" && typeof g.label === "string";
var grantList = (v4) => Array.isArray(v4) ? v4.filter(isGrant) : [];
function createPluginApi(fetchFn) {
  const call = async (path, body) => {
    const r = await fetchFn(`${BASE2}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const out = await r.json().catch(() => void 0);
    if (!r.ok) {
      const message = typeof out?.error === "string" ? out.error : `request failed (${r.status})`;
      throw new RawAgentServiceError(codeOf(r.status, out?.code), message);
    }
    return out ?? {};
  };
  return {
    async sessionInfo(session) {
      try {
        return await call("plugin/session-info", { session });
      } catch (e) {
        if (e instanceof RawAgentServiceError && e.code === "not-our-session") return void 0;
        throw e;
      }
    },
    async interrupt(session) {
      await call("plugin/interrupt", { session });
    },
    async send(session, text3, grant, mode) {
      const r = await call("plugin/send", { session, text: text3, grant, mode });
      return { messageId: typeof r.messageId === "string" ? r.messageId : "" };
    },
    async askSideQuestion(session, question, grant) {
      const r = await call("plugin/side-question", { session, question, grant });
      return typeof r.answer === "string" ? r.answer : null;
    },
    async grants() {
      return grantList((await call("grants", {})).grants);
    },
    async createGrant(label2) {
      const r = await call("grants/create", { label: label2 });
      if (!isGrant(r.grant) || typeof r.token !== "string")
        throw new RawAgentServiceError("failed", "the grant answer could not be read");
      return { grant: r.grant, token: r.token, grants: grantList(r.grants) };
    },
    async revokeGrant(id) {
      const r = await call("grants/revoke", { id });
      return { saved: r.saved === true, grants: grantList(r.grants) };
    }
  };
}

// packages/dsh-client/src/ui/access-note.tsx
var React14 = __toESM(require("react"), 1);
var tok2 = (alias, fallback) => `var(--dsw-alias-${alias}, ${fallback})`;
function accessNoteText(names) {
  const who = names.length > 0 ? names.join(", ") : "Agent";
  return {
    title: `${who} sessions do not use this access setting`,
    detail: `DSH's file access and approval level applies to DSH's own agent. In ${who} sessions the agent runs its own tools under its own permission mode: use the mode chip in the composer or /permission there. For full access pick bypassPermissions (needs the plugin option allowDangerouslySkipPermissions) or Auto.`
  };
}
function AccessNote(props) {
  const t = accessNoteText(props.agentNames ?? []);
  return /* @__PURE__ */ React14.createElement(
    "div",
    {
      "data-raw-agent": "access-note",
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "12px 0",
        borderBottom: `.5px solid ${tok2("border-l2", "rgba(128,128,128,0.25)")}`
      }
    },
    /* @__PURE__ */ React14.createElement("span", { style: { color: tok2("label-secondary", "CanvasText"), fontSize: 13, lineHeight: "20px" } }, t.title),
    /* @__PURE__ */ React14.createElement("span", { style: { color: tok2("label-tertiary", "GrayText"), fontSize: 12, lineHeight: "18px" } }, t.detail)
  );
}

// packages/dsh-client/src/ui/plugin-extras.tsx
var React15 = __toESM(require("react"), 1);
function PluginExtras(props) {
  const { store } = props;
  const snap = React15.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  if (snap.status !== "ready" || !info || typeof props.renderSlot !== "function") return null;
  const owner = {
    sessionId: store.sessionId,
    backend: { kind: info.backend.kind, displayName: info.backend.displayName }
  };
  return /* @__PURE__ */ React15.createElement("span", { "data-raw-agent": "plugin-extras", style: { display: "inline-flex", alignItems: "center", gap: 4 } }, props.renderSlot(props.slotKey, owner));
}

// packages/dsh-client/src/ui/local-command.tsx
var React16 = __toESM(require("react"), 1);
var muted7 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var border7 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
var styles6 = {
  divider: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: muted7,
    margin: "8px 0"
  },
  line: { flex: "1 1 auto", borderTop: `1px solid ${border7}` },
  box: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    border: `1px solid ${border7}`,
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
    margin: "4px 0"
  },
  table: { borderCollapse: "collapse", fontSize: 12 },
  cell: { padding: "1px 8px 1px 0", textAlign: "left", verticalAlign: "top" },
  numCell: { padding: "1px 0 1px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: muted7 },
  pre: {
    margin: "4px 0",
    padding: 8,
    border: `1px solid ${border7}`,
    borderRadius: 8,
    fontFamily: "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: 12,
    whiteSpace: "pre",
    overflowX: "auto"
  }
};
function LocalCommandText(props) {
  if (props.text === "") return null;
  if (localTextFormat(props.text) === "plain")
    return /* @__PURE__ */ React16.createElement("pre", { style: styles6.pre, "data-raw-agent": "local-text" }, props.text);
  return /* @__PURE__ */ React16.createElement("div", { "data-raw-agent": "local-text" }, /* @__PURE__ */ React16.createElement(Markdown, { text: props.text, testId: "local-markdown" }));
}
function Divider(props) {
  return /* @__PURE__ */ React16.createElement("div", { style: styles6.divider, role: "separator", "data-raw-agent": props.testId }, /* @__PURE__ */ React16.createElement("span", { style: styles6.line }), /* @__PURE__ */ React16.createElement("span", null, props.text), /* @__PURE__ */ React16.createElement("span", { style: styles6.line }));
}
function DetailTable(props) {
  if (props.rows.length === 0) return null;
  const rows = [...props.rows].sort((a, b) => b.tokens - a.tokens);
  return /* @__PURE__ */ React16.createElement("details", { "data-raw-agent": "local-context-detail" }, /* @__PURE__ */ React16.createElement("summary", null, props.title, " (", rows.length, ")"), /* @__PURE__ */ React16.createElement("table", { style: styles6.table }, /* @__PURE__ */ React16.createElement("tbody", null, rows.map((r, i) => /* @__PURE__ */ React16.createElement("tr", { key: i }, /* @__PURE__ */ React16.createElement("td", { style: styles6.cell }, r.name), /* @__PURE__ */ React16.createElement("td", { style: { ...styles6.cell, color: muted7 } }, r.extra ?? ""), /* @__PURE__ */ React16.createElement("td", { style: styles6.numCell }, formatCount(r.tokens)))))));
}
var arr = (v4) => Array.isArray(v4) ? v4.filter((x) => typeof x === "object" && x !== null) : [];
var s = (v4) => typeof v4 === "string" ? v4 : "";
var n = (v4) => typeof v4 === "number" && Number.isFinite(v4) ? v4 : 0;
function LocalContextView(props) {
  const c = props.output.context;
  const view = parseContextView({ ...c, source: "report", at: 0 });
  const d = c.details ?? {};
  return /* @__PURE__ */ React16.createElement("div", { style: styles6.box, "data-raw-agent": "local-context" }, view ? /* @__PURE__ */ React16.createElement(ContextSection, { breakdown: contextBreakdown(view, props.displayName) }) : /* @__PURE__ */ React16.createElement("span", { style: css.hint }, "The report has no figures."), /* @__PURE__ */ React16.createElement(
    DetailTable,
    {
      title: "MCP tools",
      rows: arr(d.mcpTools).map((r) => ({ name: s(r.name), extra: s(r.server), tokens: n(r.tokens) }))
    }
  ), /* @__PURE__ */ React16.createElement(
    DetailTable,
    {
      title: "Memory files",
      rows: arr(d.memoryFiles).map((r) => ({ name: s(r.path), extra: s(r.type), tokens: n(r.tokens) }))
    }
  ), /* @__PURE__ */ React16.createElement(
    DetailTable,
    {
      title: "Agents",
      rows: arr(d.agents).map((r) => ({ name: s(r.name), extra: s(r.source), tokens: n(r.tokens) }))
    }
  ), /* @__PURE__ */ React16.createElement(
    DetailTable,
    {
      title: "Skills",
      rows: arr(d.skills).map((r) => ({
        name: s(r.name),
        extra: [s(r.source), s(r.plugin)].filter((x) => x !== "").join(" \xB7 "),
        tokens: n(r.tokens)
      }))
    }
  ));
}
function ContextOutput(props) {
  const { data, api, sessionId } = props;
  const [state, setState] = React16.useState({});
  React16.useEffect(() => {
    if (!data.outputId || !api.localOutput) return void 0;
    let live = true;
    api.localOutput(sessionId, data.outputId).then(
      (output) => live && setState(output ? { output } : { gone: true }),
      (e) => live && setState({ error: String(e?.message ?? e) })
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, data.outputId]);
  if (!data.outputId) return null;
  if (state.output) return /* @__PURE__ */ React16.createElement(LocalContextView, { output: state.output, displayName: props.displayName });
  if (state.gone)
    return /* @__PURE__ */ React16.createElement("span", { style: css.hint, "data-raw-agent": "local-context-gone" }, "The table of this report is no longer kept (DSH restarted); its full text is below.");
  if (state.error) return /* @__PURE__ */ React16.createElement("span", { style: css.error }, state.error);
  return null;
}
function UsageOutput(props) {
  const snap = React16.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const u = snap.info?.view.usage;
  if (!u || u.tokens === void 0 && u.costUsd === void 0) return null;
  const parts = [];
  if (u.tokens !== void 0) parts.push(`${formatCount(u.tokens)} tokens`);
  if (u.costUsd !== void 0) parts.push(costText(u.costUsd, u.costLabel));
  if (u.limit?.percent !== void 0) parts.push(`${u.limit.label}: ${Math.round(u.limit.percent)}% used`);
  return /* @__PURE__ */ React16.createElement("div", { style: { ...css.hint, margin: "2px 0" }, "data-raw-agent": "local-usage" }, "This conversation so far: ", parts.join(" \xB7 "), ". The context pill below the composer opens the full usage panel.");
}
function LocalCommandView(props) {
  const snap = React16.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const displayName = snap.info?.backend.displayName ?? "The agent";
  const text3 = /* @__PURE__ */ React16.createElement(LocalCommandText, { text: props.data.text ?? "" });
  switch (localRender(props.data)) {
    case "cleared":
    case "compacted":
      return text3;
    case "context":
      return /* @__PURE__ */ React16.createElement(React16.Fragment, null, /* @__PURE__ */ React16.createElement(ContextOutput, { data: props.data, sessionId: props.sessionId, api: props.api, displayName }), props.data.text && props.data.outputId ? /* @__PURE__ */ React16.createElement("details", { "data-raw-agent": "local-context-text" }, /* @__PURE__ */ React16.createElement("summary", { style: css.hint }, displayName, "'s full /context text"), text3) : text3);
    case "usage":
      return /* @__PURE__ */ React16.createElement(React16.Fragment, null, text3, /* @__PURE__ */ React16.createElement(UsageOutput, { store: props.store }));
    default:
      return text3;
  }
}

// packages/dsh-client/src/ui/command-marker.tsx
var React17 = __toESM(require("react"), 1);
function CommandMarkerView(props) {
  const { marker, store, reader } = props;
  const snap = React17.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const noReader = React17.useCallback(() => () => {
  }, []);
  const none = React17.useCallback(() => void 0, []);
  const read2 = React17.useSyncExternalStore(
    reader?.subscribe ?? noReader,
    reader?.getSnapshot ?? none,
    reader?.getSnapshot ?? none
  );
  const ours = snap.status === "ready" && snap.info !== void 0;
  const compacting = snap.info?.view.usage?.compacting === true;
  const isCompact = marker.kind === "compacted";
  React17.useEffect(() => {
    if (!ours || !isCompact || !reader) return;
    void reader.read({ usage: true });
  }, [ours, isCompact, reader, compacting]);
  if (!ours || !snap.info) return null;
  const name2 = snap.info.backend.displayName;
  if (marker.kind === "cleared") return /* @__PURE__ */ React17.createElement(Divider, { text: clearedText(name2), testId: "marker-cleared" });
  if (reader && read2?.usage === void 0 && !read2?.error) return null;
  const outcome = compactOutcome(marker.time, read2?.usage?.usage, compacting);
  return /* @__PURE__ */ React17.createElement(Divider, { text: compactMarkerText(outcome, name2, formatCount), testId: `marker-compact-${outcome.state}` });
}

// packages/dsh-client/src/ui/lifecycle-banner.tsx
var React18 = __toESM(require("react"), 1);
var border8 = "var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))";
var danger = "var(--raw-agent-danger, var(--dsw-alias-state-error-primary, #c0392b))";
var warn2 = "var(--raw-agent-warning, var(--dsw-alias-state-warn-primary, orange))";
var box = (color) => ({
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: `1px solid ${border8}`,
  borderLeft: `3px solid ${color}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  margin: "4px 0",
  maxWidth: "100%",
  background: "var(--raw-agent-surface, var(--dsw-alias-bg-base, transparent))"
});
var inset = "var(--dsh-composer-dock-inset, 0px)";
var clearance = "var(--dsh-composer-side-clearance, 0px)";
var stackStyle = {
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  minWidth: 0,
  width: `calc(100% - ${clearance} - ${clearance} - ${inset} - ${inset} - ${inset} - ${inset})`,
  maxWidth: `calc(var(--dsh-composer-card-max-width, 100%) - ${inset} - ${inset} - ${inset} - ${inset})`,
  margin: "0 auto"
};
var detailStyle = {
  margin: 0,
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 160,
  overflowY: "auto",
  fontFamily: "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)"
};
function LifecycleBanner(props) {
  const { store } = props;
  const snap = React18.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [dismissed, setDismissed] = React18.useState(() => /* @__PURE__ */ new Set());
  const dismiss = (id) => setDismissed((d) => /* @__PURE__ */ new Set([...d, id]));
  const info = snap.status === "ready" ? snap.info : void 0;
  if (!info) return null;
  const exit = exitBanner(info);
  const notes = lifecycleNotes(info).filter((n2) => !dismissed.has(n2.id));
  const showExit = exit !== void 0 && !dismissed.has(exit.key);
  if (!showExit && notes.length === 0) return null;
  return /* @__PURE__ */ React18.createElement("div", { "data-raw-agent": "lifecycle", style: stackStyle }, showExit && exit && /* @__PURE__ */ React18.createElement("div", { style: box(exit.level === "error" ? danger : warn2), role: "alert", "data-raw-agent": "exit-banner" }, /* @__PURE__ */ React18.createElement("strong", null, exit.title), exit.reply && /* @__PURE__ */ React18.createElement("span", null, exit.reply), exit.detail && /* @__PURE__ */ React18.createElement("details", null, /* @__PURE__ */ React18.createElement("summary", { style: css.hint }, "What it reported"), /* @__PURE__ */ React18.createElement("pre", { style: detailStyle, "data-raw-agent": "exit-detail" }, exit.detail)), /* @__PURE__ */ React18.createElement("span", { style: css.row }, /* @__PURE__ */ React18.createElement(
    "button",
    {
      type: "button",
      style: css.primary,
      disabled: snap.busy,
      "data-raw-agent": "exit-restart",
      onClick: () => void store.start()
    },
    exit.restartLabel
  ), /* @__PURE__ */ React18.createElement("button", { type: "button", style: css.button, "data-raw-agent": "exit-dismiss", onClick: () => dismiss(exit.key) }, "Dismiss"))), notes.map((n2) => /* @__PURE__ */ React18.createElement(
    "div",
    {
      key: n2.id,
      style: { ...box(n2.level === "warning" ? warn2 : border8), flexDirection: "row", alignItems: "center" },
      "data-raw-agent": "lifecycle-note",
      role: "status"
    },
    /* @__PURE__ */ React18.createElement("span", { style: { flex: "1 1 auto" } }, n2.text),
    /* @__PURE__ */ React18.createElement("button", { type: "button", style: css.button, "aria-label": "Dismiss", onClick: () => dismiss(n2.id) }, "\xD7")
  )));
}

// packages/dsh-client/src/port/command-source.ts
var COMMAND_SOURCE_NAME = "Agent commands";
function agentCommandSource(stores, api) {
  const cache = /* @__PURE__ */ new Map();
  const hot = /* @__PURE__ */ new Map();
  const keep = (sessionId, p) => p.then((a) => {
    if (a) hot.set(sessionId, a);
    else hot.delete(sessionId);
    return a;
  });
  const answerOf = (sessionId) => {
    const snap = stores.peek(sessionId)?.getSnapshot();
    if (snap?.status !== "ready" || !snap.info || !api.commands) return void 0;
    const version = snap.info.view.menu?.version ?? -1;
    const hit = cache.get(sessionId);
    if (hit && hit.version === version) return hit.answer;
    const answer = keep(
      sessionId,
      api.commands(sessionId).catch(() => void 0)
    );
    cache.set(sessionId, { version, answer });
    return answer;
  };
  const answerNow = async (sessionId) => {
    const cached = answerOf(sessionId);
    if (cached) return cached;
    const snap = stores.peek(sessionId)?.getSnapshot();
    if (snap?.status === "absent" || !api.commands) return void 0;
    return keep(
      sessionId,
      api.commands(sessionId).catch(() => void 0)
    );
  };
  const sideClaim = (sessionId, name2, displayName) => ({
    name: name2,
    token: `/${name2} `,
    hint: "<question>",
    attachments: false,
    async submit(args) {
      if (!api.askSide) return { kind: "error", text: "Side questions are not available here." };
      const r = await api.askSide(sessionId, args);
      void stores.peek(sessionId)?.refresh();
      if (!r.ok) return { kind: "error", text: r.error ?? "The side question was refused." };
      if (r.entry?.status === "waiting")
        return { kind: "success", text: `The question waits in the side panel. Start ${displayName} to ask it.` };
      return { kind: "success" };
    }
  });
  const mcpClaim = (sessionId, name2) => ({
    name: name2,
    token: `/${name2} `,
    attachments: false,
    submit() {
      stores.get(sessionId).requestPanel("mcp");
      return Promise.resolve({ kind: "success" });
    }
  });
  const rewindClaim = (sessionId, name2) => ({
    name: name2,
    token: `/${name2} `,
    attachments: false,
    submit() {
      stores.get(sessionId).requestPanel("rewind");
      return Promise.resolve({ kind: "success" });
    }
  });
  const displayNameOf = (a) => a.displayName ?? "the agent";
  return {
    trigger: "/",
    name: COMMAND_SOURCE_NAME,
    order: 50,
    async candidates(session, req) {
      if (req.position !== "leading") return [];
      const answer = answerOf(session.sessionId);
      return answer ? sourceCandidates(await answer, req.query) : [];
    },
    onPick(pick) {
      const id = pick.session.sessionId;
      const action = pick.candidate.value;
      if (action === "start") {
        void stores.get(id).start();
        return { text: "" };
      }
      if (action === "taken") return "handled";
      if (action === "side") {
        const a = hot.get(id);
        return { claim: sideClaim(id, pick.candidate.name, a ? displayNameOf(a) : "the agent") };
      }
      return { text: sourcePickText(pick.candidate.name) };
    },
    matchSpace(session, token) {
      const a = hot.get(session.sessionId);
      if (!a?.sideQuestionCommand || token !== `/${a.sideQuestionCommand}`) return void 0;
      return { claim: sideClaim(session.sessionId, a.sideQuestionCommand, displayNameOf(a)) };
    },
    async matchEnter(session, line, _signal, envelope) {
      const cmd = leadingCommand(line);
      if (!cmd) return void 0;
      const a = await answerNow(session.sessionId);
      if (!a) return void 0;
      if (cmd.name === a.sideQuestionCommand) {
        if ((envelope?.attachments ?? 0) > 0)
          throw new Error(`/${cmd.name} takes a question only; remove the attachments first.`);
        return { claim: sideClaim(session.sessionId, cmd.name, displayNameOf(a)) };
      }
      if (cmd.name === a.mcpCommand && cmd.rest === "" && (envelope?.attachments ?? 0) === 0)
        return { claim: mcpClaim(session.sessionId, cmd.name) };
      if (isRewindName(a, cmd.name) && cmd.rest === "" && (envelope?.attachments ?? 0) === 0)
        return { claim: rewindClaim(session.sessionId, cmd.name) };
      return void 0;
    },
    async matchClaim(session, token) {
      const a = await answerNow(session.sessionId);
      if (!a?.sideQuestionCommand || token !== `/${a.sideQuestionCommand}`) return void 0;
      return sideClaim(session.sessionId, a.sideQuestionCommand, displayNameOf(a));
    },
    warm(session) {
      void answerOf(session.sessionId);
    }
  };
}
function isRewindName(answer, name2) {
  const cmd = answer.rewindCommand;
  if (cmd === void 0) return false;
  if (name2 === cmd) return true;
  const row = answer.rows.find((r) => r.name === cmd);
  return (row?.aliases ?? []).includes(name2);
}

// packages/dsh-client/src/port/tool-views.tsx
var React19 = __toESM(require("react"), 1);
var TOOL_VIEW_SLOT = "tool.call.toolview";
var DSH_TOOL_VIEW_KEYS = Object.freeze([
  "apply_patch",
  "ask_user_question",
  "bash",
  "cordis_define",
  "cordis_inspect_list",
  "cordis_inspect_query",
  "cordis_inspect_self",
  "cordis_run",
  "cordis_stop",
  "cordis_undefine",
  "create_goal",
  "edit",
  "get_goal",
  "glob",
  "grep",
  "interrupt_agent",
  "job_kill",
  "job_list",
  "job_output",
  "list_agents",
  "list_subagent_models",
  "lsp",
  "present",
  "propose_action",
  "ralph",
  "read",
  "read_image",
  "schedule_create",
  "schedule_delete",
  "schedule_edit",
  "schedule_list",
  "schedule_update",
  "schedule_view",
  "send_message",
  "session_event_read",
  "session_event_search",
  "session_event_trace",
  "session_search",
  "session_trace",
  "skill",
  "spawn_teammate",
  "subagent",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
  "terminal_close",
  "terminal_list",
  "terminal_open",
  "terminal_read",
  "terminal_signal",
  "todo_write",
  "update_goal",
  "wait_agent",
  "web_fetch",
  "web_search",
  "workflow",
  "write"
]);
function toolViewNames(pack) {
  const dsh = new Set(DSH_TOOL_VIEW_KEYS);
  return Object.keys(pack.views).filter((n2) => n2 !== "" && !n2.startsWith("mcp__") && !dsh.has(n2));
}
var isRecord = (v4) => typeof v4 === "object" && v4 !== null && !Array.isArray(v4);
function parseArgs(raw) {
  if (typeof raw !== "string" || raw === "") return void 0;
  try {
    const v4 = JSON.parse(raw);
    return isRecord(v4) ? v4 : {};
  } catch {
    return void 0;
  }
}
function readArgs(args) {
  const out = {};
  if (!args || typeof args.keys !== "function") return out;
  try {
    for (const k of args.keys()) {
      const v4 = typeof args.value === "function" ? args.value(k) : void 0;
      if (v4 !== void 0) out[k] = v4;
      else if (typeof args.text === "function") {
        const t = args.text(k);
        if (t !== void 0) out[k] = t;
      }
    }
  } catch {
  }
  return out;
}
function toolViewPropsOf(owner) {
  const b = owner.block ?? {};
  const input = owner.phase === "start" ? parseArgs(b.argsRaw) ?? readArgs(b.args) : owner.phase === "result" ? parseArgs(b.call?.argsRaw) ?? readArgs(b.args) : readArgs(b.args);
  const p = {
    callId: owner.callId,
    toolName: owner.toolName,
    phase: owner.phase === "preparing" ? "preparing" : owner.phase === "start" ? "running" : "done",
    input
  };
  if (owner.phase === "result") {
    const content = Array.isArray(b.content) ? b.content : [];
    const result = {
      text: content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n"),
      isError: b.isError === true,
      images: content.filter((c) => c?.type === "image").length
    };
    if (typeof b.callTime === "number" && typeof b.time === "number" && b.time >= b.callTime)
      result.durationMs = b.time - b.callTime;
    p.result = result;
  }
  if (typeof owner.cwd === "string") p.cwd = owner.cwd;
  if (typeof owner.home === "string") p.home = owner.home;
  if (typeof owner.openFile === "function") {
    const open = owner.openFile;
    p.openFile = (path, line) => open(path, line !== void 0 ? { line } : void 0);
  }
  return p;
}
var noop = () => () => {
};
var undef = () => void 0;
function useSessionKind(sessionId, stores, links) {
  const store = sessionId ? stores.get(sessionId) : void 0;
  const snap = React19.useSyncExternalStore(
    store?.subscribe ?? noop,
    store?.getSnapshot ?? undef,
    store?.getSnapshot ?? undef
  );
  const absent = snap?.status === "absent";
  const link = absent && sessionId && links ? links.get(sessionId) : void 0;
  const linkSnap = React19.useSyncExternalStore(
    link?.subscribe ?? noop,
    link?.getSnapshot ?? undef,
    link?.getSnapshot ?? undef
  );
  const parentId = linkSnap?.status === "found" ? linkSnap.link?.parentSession : void 0;
  const parent = parentId ? stores.get(parentId) : void 0;
  const parentSnap = React19.useSyncExternalStore(
    parent?.subscribe ?? noop,
    parent?.getSnapshot ?? undef,
    parent?.getSnapshot ?? undef
  );
  if (!store) return null;
  if (snap?.status === "ready" && snap.info) return snap.info.backend.kind;
  if (!absent) return void 0;
  if (!links || linkSnap?.status === "none") return null;
  if (linkSnap?.status !== "found") return void 0;
  if (parentSnap?.status === "ready" && parentSnap.info) return parentSnap.info.backend.kind;
  return parentSnap?.status === "absent" ? null : void 0;
}
var muted8 = "var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))";
var plain = {
  head: {
    display: "flex",
    gap: 6,
    alignItems: "baseline",
    cursor: "pointer",
    background: "transparent",
    border: "none",
    padding: 0,
    font: "inherit",
    color: "inherit",
    textAlign: "left",
    width: "100%",
    minWidth: 0
  },
  summary: { color: muted8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  pre: {
    fontFamily: "var(--raw-agent-mono, ui-monospace, monospace)",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: "4px 0 0 12px",
    maxHeight: 320,
    overflow: "auto"
  }
};
function plainSummary(input) {
  for (const k of ["description", "command", "file_path", "path", "pattern", "url", "query", "skill"]) {
    const v4 = input[k];
    if (typeof v4 === "string" && v4.trim() !== "") return v4.split("\n")[0].slice(0, 160);
  }
  return "";
}
function PlainToolRow(props) {
  const { call } = props;
  const [open, setOpen] = React19.useState(false);
  const state = call.phase !== "done" ? "running\u2026" : call.result?.isError ? "failed" : "";
  let input;
  try {
    input = JSON.stringify(call.input, null, 2);
  } catch {
    input = String(call.input);
  }
  return /* @__PURE__ */ React19.createElement("div", { "data-raw-agent": "tool-plain", "data-tool": call.toolName }, /* @__PURE__ */ React19.createElement("button", { type: "button", style: plain.head, onClick: () => setOpen(!open), "aria-expanded": open }, /* @__PURE__ */ React19.createElement("span", null, "Tool call \xB7 ", call.toolName), /* @__PURE__ */ React19.createElement("span", { style: plain.summary }, plainSummary(call.input)), state && /* @__PURE__ */ React19.createElement("span", { style: { fontSize: 11, color: muted8 } }, state)), open && /* @__PURE__ */ React19.createElement("pre", { style: plain.pre }, input), open && call.result && /* @__PURE__ */ React19.createElement("pre", { style: plain.pre }, call.result.text));
}
var ViewBoundary = class extends React19.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? /* @__PURE__ */ React19.createElement(PlainToolRow, { call: this.props.call }) : this.props.children;
  }
};
function ScopedToolView(props) {
  const kind = useSessionKind(props.sessionId, props.stores, props.links);
  const call = toolViewPropsOf(props);
  if (kind !== props.kind) return /* @__PURE__ */ React19.createElement(PlainToolRow, { call });
  const View = props.view;
  return /* @__PURE__ */ React19.createElement(ViewBoundary, { call }, /* @__PURE__ */ React19.createElement(View, { ...call }));
}
function registerToolViews(slots, packs, stores, links) {
  const done = [];
  const entries = [];
  for (const pack of packs)
    for (const name2 of toolViewNames(pack)) {
      if (done.includes(name2)) continue;
      done.push(name2);
      entries.push({ name: name2, kind: pack.kind, view: pack.views[name2] });
    }
  if (entries.length === 0) return done;
  slots.inject(TOOL_VIEW_SLOT, function* () {
    for (const e of entries)
      yield slots.register(
        {
          name: TOOL_VIEW_SLOT,
          key: e.name,
          // A strict session slot passes the session id to `inject` (P/dsh-client-ui-renderer, runInject).
          inject: (sessionId) => ({ sessionId, stores, links, kind: e.kind, view: e.view })
        },
        ScopedToolView
      );
  });
  return done;
}

// packages/dsh-client/src/port/index.tsx
var TESTED_DSH_VERSIONS = Object.freeze(["0.2.2-rc.1"]);
var CONTROLS_SLOT = "conversation.input.left";
var CONTROLS_ENTRY_ID = "raw-agent-session-controls";
var NATIVE_PERMISSION_SLOT = "conversation.input.permission";
var NATIVE_MODEL_SLOT = "conversation.input.model";
var HIDDEN_NATIVE_SLOTS = Object.freeze([NATIVE_PERMISSION_SLOT, NATIVE_MODEL_SLOT]);
var SEAT_HIDDEN_ATTR = "data-raw-agent-hides-seat";
var SEAT_STYLE_ID = "raw-agent-hide-native-seat";
var SEAT_HIDING_RULE = `${HIDDEN_NATIVE_SLOTS.map((s2) => `[${SEAT_HIDDEN_ATTR}] [data-slot="${s2}"]`).join(",")}{display:none !important}`;
var SEAT_SEARCH_DEPTH = 8;
function hideNativeSeat(el, doc = globalThis.document) {
  const none = { found: false, undo: () => {
  } };
  const start = el;
  if (!start || typeof start !== "object" || !("parentElement" in start)) return none;
  const hosts = [];
  for (const slot of HIDDEN_NATIVE_SLOTS) {
    const selector = `[data-slot="${slot}"]`;
    let at = start.parentElement;
    for (let i = 0; at && i < SEAT_SEARCH_DEPTH; i++, at = at.parentElement) {
      if (!at.querySelector(selector)) continue;
      if (!hosts.includes(at)) hosts.push(at);
      break;
    }
  }
  if (hosts.length === 0) return none;
  if (doc) {
    const old = doc.getElementById(SEAT_STYLE_ID);
    if (old) {
      if (old.textContent !== SEAT_HIDING_RULE) old.textContent = SEAT_HIDING_RULE;
    } else {
      const style = doc.createElement("style");
      style.id = SEAT_STYLE_ID;
      style.textContent = SEAT_HIDING_RULE;
      doc.head?.appendChild(style);
    }
  }
  for (const host of hosts) host.setAttribute(SEAT_HIDDEN_ATTR, "");
  return { found: true, undo: () => hosts.forEach((host) => host.removeAttribute(SEAT_HIDDEN_ATTR)) };
}
var TERMINAL_TAB_KIND = "terminal";
var TOOL_CALL_ATTR = "data-chat-call-id";
var TOOL_WAITING_ATTR = "data-raw-agent-waiting";
var TOOL_STYLE_ID = "raw-agent-tool-waiting";
var cssString = (v4) => `"${v4.replace(/["\\]/g, (c) => `\\${c}`)}"`;
function findToolCard(callId, doc = globalThis.document) {
  const el = doc?.querySelector(`[${TOOL_CALL_ATTR}=${cssString(callId)}]`);
  return el && typeof el.setAttribute === "function" ? el : void 0;
}
function markToolCard(callId, label2, doc = globalThis.document) {
  const el = findToolCard(callId, doc);
  if (!el) return { found: false, undo: () => {
  } };
  if (doc && !doc.getElementById(TOOL_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = TOOL_STYLE_ID;
    style.textContent = `[${TOOL_WAITING_ATTR}]{outline:2px solid var(--raw-agent-ask-border, var(--dsw-alias-state-warn-primary, orange));outline-offset:2px;border-radius:8px}`;
    doc.head?.appendChild(style);
  }
  el.setAttribute(TOOL_WAITING_ATTR, label2);
  return { found: true, undo: () => el.removeAttribute(TOOL_WAITING_ATTR) };
}
var ASK_INTERACTION_KIND = "raw-agent-ask";
var ASK_INTERACTION_PRECEDENCE = 1;
var ASK_COMPOSER_PRIORITY = -20;
function publishAsks(stores, publish) {
  const live = /* @__PURE__ */ new Map();
  const childLive = /* @__PURE__ */ new Map();
  const offs = [];
  const childKeys = /* @__PURE__ */ new Map();
  const syncChildren = (store) => {
    const snap = store.getSnapshot();
    if (snap.status === "error" || snap.status === "loading") return;
    const view = snap.status === "ready" ? snap.info?.view : void 0;
    const wanted = /* @__PURE__ */ new Map();
    const asks = [...view?.asks ?? []].sort((a, b) => a.at - b.at);
    for (const a of asks) {
      if (a.agent !== "child" || a.agentId === void 0) continue;
      const host = view?.children?.find((c) => c.id === a.agentId)?.hostSessionId;
      if (host === void 0 || wanted.has(host)) continue;
      wanted.set(host, { key: `${a.id}${a.state === "waiting" ? ":waiting" : ""}@child`, askId: a.id });
    }
    const mine = childKeys.get(store.sessionId) ?? /* @__PURE__ */ new Set();
    for (const host of [...mine]) {
      const cur = childLive.get(host);
      if (wanted.get(host)?.key === cur?.key) continue;
      cur?.remove();
      childLive.delete(host);
      mine.delete(host);
    }
    for (const [host, w] of wanted) {
      if (childLive.has(host)) continue;
      try {
        const remove = publish(
          { key: w.key, kind: ASK_INTERACTION_KIND, sessionId: host, askId: w.askId, storeSessionId: store.sessionId },
          async () => {
          }
        );
        childLive.set(host, { key: w.key, remove });
        mine.add(host);
      } catch {
      }
    }
    childKeys.set(store.sessionId, mine);
  };
  const sync = (store) => {
    syncChildren(store);
    const snap = store.getSnapshot();
    const id = store.sessionId;
    if (snap.status === "error" || snap.status === "loading") return;
    const asks = [...snap.info?.view.asks ?? []].sort((a, b) => a.at - b.at);
    const first = snap.status === "ready" ? asks[0] : void 0;
    const key = first ? `${first.id}${first.state === "waiting" ? ":waiting" : ""}` : void 0;
    const cur = live.get(id);
    if (cur?.key === key) return;
    cur?.remove();
    live.delete(id);
    if (!first || key === void 0) return;
    try {
      const remove = publish({ key, kind: ASK_INTERACTION_KIND, sessionId: id, askId: first.id }, async () => {
      });
      live.set(id, { key, remove });
    } catch {
    }
  };
  offs.push(
    stores.each((store) => {
      offs.push(store.observe(() => sync(store)));
      sync(store);
    })
  );
  return () => {
    for (const off of offs.splice(0)) off();
    for (const p of [...live.values(), ...childLive.values()]) p.remove();
    live.clear();
    childLive.clear();
  };
}
function selectAsk(owner) {
  const p = owner.pendingInteraction;
  return p?.kind === ASK_INTERACTION_KIND && (owner.sessionId === void 0 || p.sessionId === owner.sessionId) ? p : null;
}
function AskComposer(props) {
  return /* @__PURE__ */ React20.createElement("div", { "data-raw-agent": "ask-composer", style: { padding: "4px 0" } }, /* @__PURE__ */ React20.createElement(
    AskPanel,
    {
      store: props.stores.get(props.matched.storeSessionId ?? props.matched.sessionId),
      actions: props.actions,
      askId: props.matched.askId,
      ...props.matched.storeSessionId !== void 0 ? { only: (a) => a.id === props.matched.askId } : {}
    }
  ));
}
var PRESET_DECORATION = "permission";
function modePopup(stores) {
  const infoOf = async (sessionId) => {
    const store = stores.get(sessionId);
    if (store.getSnapshot().info === void 0) await store.refresh();
    return store.getSnapshot().info;
  };
  return {
    kind: "popupSelect",
    searchLabels: () => ({
      placeholder: "Search permission modes",
      empty: "The agent has not listed its permission modes yet.",
      noResults: "No permission mode matches."
    }),
    async options(session) {
      const info = typeof session?.sessionId === "string" ? await infoOf(session.sessionId) : void 0;
      if (!info) throw new Error("the agent is not attached to this session yet; try again in a moment");
      return modePopupOptions(info);
    },
    async onSelect(option, session) {
      if (typeof session?.sessionId !== "string") return;
      const store = stores.get(session.sessionId);
      const info = store.getSnapshot().info;
      const row = info ? modePopupOptions(info).find((o) => o.id === option.id) : void 0;
      if (row?.blocked !== void 0) {
        store.showNote(`${row.label}: ${row.blocked} Nothing changed.`);
        return;
      }
      if (row?.active) return;
      await store.choose({ mode: option.id });
    }
  };
}
function guardPresetDecoration(commandUi, isOurs, ours) {
  const map = commandUi?.live?.decorations;
  if (!(map instanceof Map)) return void 0;
  const base = map.get;
  const isOur = (session) => typeof session?.sessionId === "string" && isOurs(session.sessionId);
  const get = function(key) {
    const found = base.call(this, key);
    if (key !== PRESET_DECORATION || typeof found?.available !== "function") return found;
    let asked;
    return {
      ...found,
      available: (session) => {
        asked = session;
        if (isOur(session)) return ours !== void 0;
        return found.available(session);
      },
      get ui() {
        return ours !== void 0 && isOur(asked) ? ours : found.ui;
      }
    };
  };
  Object.defineProperty(map, "get", { value: get, configurable: true, writable: true });
  return () => {
    if (map.get === get) delete map.get;
  };
}
var MODEL_CONTRIBUTION = "model";
function guardModelContribution(commandUi, isOurs, open) {
  const map = commandUi?.live?.contributions;
  if (!(map instanceof Map)) return void 0;
  const base = map.get;
  const ours = (session) => typeof session?.sessionId === "string" && isOurs(session.sessionId);
  const action = {
    kind: "action",
    run: (session) => {
      if (ours(session)) open(session.sessionId);
    }
  };
  const get = function(key) {
    const found = base.call(this, key);
    if (key !== MODEL_CONTRIBUTION || typeof found?.available !== "function") return found;
    let asked;
    return {
      ...found,
      available: (session) => {
        asked = session;
        return ours(session) || found.available(session);
      },
      get ui() {
        return ours(asked) ? action : found.ui;
      }
    };
  };
  Object.defineProperty(map, "get", { value: get, configurable: true, writable: true });
  return () => {
    if (map.get === get) delete map.get;
  };
}
function isOurSession(stores, sessionId) {
  const store = stores.peek(sessionId);
  const snap = store?.getSnapshot();
  return snap?.info !== void 0 && snap.status !== "absent" || store?.presetOurs === true;
}
var OUR_PRESET_PREFIX = "raw-agent-";
var isOurPreset = (preset) => typeof preset === "string" && preset.startsWith(OUR_PRESET_PREFIX);
var MODE_SHORTCUT_ID = "raw-agent.permission-mode.next";
function modeKeyHandler(stores) {
  return (input) => {
    if (input.type !== "keydown") return;
    const { gesture: g, context } = input;
    if (g.code !== "Tab" || !g.shift || g.control || g.alt || g.meta) return;
    if (g.repeat || g.composing || g.defaultPrevented) return;
    if (context.modal !== null || context.region === "terminal" || !context.target) return;
    const occurrence = context.target.closest("[data-conversation-session]");
    if (!occurrence || !context.target.closest('[data-conversation-region="composer"]')) return;
    const sessionId = occurrence.dataset?.conversationSession ?? occurrence.getAttribute?.("data-conversation-session");
    if (!sessionId) return;
    const store = stores.peek(sessionId);
    if (store?.cycleMode()) input.consume();
  };
}
var SIDE_CHAT_TAB_ID = "dsh-raw-agent/side-chat";
var SIDE_CHAT_TAB_KIND = "raw-agent-side-chat";
var SIDE_CHAT_TAB_SLOT = "sidebar.right.pane.tab";
var SIDE_CHAT_TITLE = "Side chat";
function sideChatTabDefinition() {
  return {
    id: SIDE_CHAT_TAB_ID,
    kind: SIDE_CHAT_TAB_KIND,
    priority: "extension",
    keepMounted: true,
    title: () => SIDE_CHAT_TITLE
  };
}
function setSideChat(state, on) {
  if (state.on === on) return;
  state.on = on;
  for (const fn of [...state.listeners ?? []]) fn();
}
function openSideChatTab(sidebar, state, sessionId, options = {}) {
  if (!state.on || typeof sidebar?.openTabIn !== "function") return false;
  try {
    if (options.quiet && sidebar.mounted?.getSnapshot?.() === sessionId && sidebar.isExpanded?.() === true) {
      if (sidebar.active?.()?.kind === SIDE_CHAT_TAB_KIND) return true;
    }
    sidebar.openTabIn(sessionId, SIDE_CHAT_TAB_KIND);
    return true;
  } catch (error) {
    console.warn("[raw-agent] could not open the side chat tab", error);
    return false;
  }
}
var CHILD_CHAT_ADDRESS = "dsh-resource://subagentchat/session/";
var CHILD_CHAT_TAB_KIND = "subagentchat";
function childChatAddress(address) {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode });
  return `${CHILD_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query.toString()}`;
}
var CONTEXT_PILL_SLOT = "conversation.composer.dock";
var CONTEXT_PILL_ENTRY_ID = "raw-agent-context";
var CONTEXT_PILL_ORDER = 2;
var LIFECYCLE_SLOT = "conversation.input.dock";
var LIFECYCLE_ENTRY_ID = "raw-agent-lifecycle";
var LIFECYCLE_ORDER = 30;
var AGENTS_SLOT = "conversation.session.header.actions";
var AGENTS_ENTRY_ID = "raw-agent-agents";
var WAKE_NODE_KIND = "raw-agent-wake";
var WAKE_DEFINITION_KIND = "raw-agent-wake-trigger";
function wakeDefinition() {
  return {
    kind: WAKE_DEFINITION_KIND,
    target: "chat",
    match: (event) => {
      if (event.type !== "developer/message") return null;
      const t = wakeTriggerOf(event);
      if (!t) return null;
      const id = event.data?.message?.id;
      return { id: typeof id === "string" && id !== "" ? id : `seq-${event.seq}`, role: "start", exclusive: true };
    },
    start: (_context, match) => wakeTriggerOf(match.event) ?? { seq: match.event.seq, time: match.event.time, text: "", items: [] },
    update: (context) => context.state,
    buildViewNode: (context) => {
      if (context.state === void 0) return null;
      return {
        key: context.key,
        kind: WAKE_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        groupTree: "input",
        data: context.state
      };
    }
  };
}
function WakeNode(props) {
  const data = props.node?.data;
  if (!data) return null;
  return /* @__PURE__ */ React20.createElement(WakeTriggerCard, { trigger: data });
}
var WORKFLOW_RUN_START_EVENT = "tool-workflow/run-start";
var WORKFLOW_RUN_END_EVENT = "tool-workflow/run-end";
var WORKFLOW_NODE_KIND = "raw-agent-workflow";
var WORKFLOW_DEFINITION_KIND = "raw-agent-workflow-run";
function workflowDefinition() {
  const runIdOf = (data) => {
    const id = data?.runId;
    return typeof id === "string" && id !== "" ? id : typeof id === "number" ? String(id) : void 0;
  };
  return {
    kind: WORKFLOW_DEFINITION_KIND,
    target: "chat",
    match: (event) => {
      if (event.type !== WORKFLOW_RUN_START_EVENT && event.type !== WORKFLOW_RUN_END_EVENT) return null;
      const id = runIdOf(event.data);
      if (id === void 0) return null;
      return { id, role: event.type === WORKFLOW_RUN_START_EVENT ? "start" : "update" };
    },
    start: (_context, match) => {
      const data = match.event.data;
      return { runId: runIdOf(match.event.data) ?? "", name: typeof data?.name === "string" ? data.name : "" };
    },
    update: (context, match) => {
      if (!context.state) return context.state;
      if (match.event.type !== WORKFLOW_RUN_END_EVENT) return context.state;
      const reason = match.event.data?.stopReason;
      return typeof reason === "string" ? { ...context.state, stopReason: reason } : context.state;
    },
    buildViewNode: (context) => {
      if (context.state === void 0 || context.start === void 0) return null;
      return {
        key: context.key,
        kind: WORKFLOW_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq: context.start.event?.seq ?? 0,
        location: context.start.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        data: context.state
      };
    }
  };
}
function WorkflowNode(props) {
  const runId = props.node?.data?.runId;
  if (!runId || !props.sessionId || !props.stores || !props.actions) return null;
  return /* @__PURE__ */ React20.createElement(WorkflowNodeView, { sessionId: props.sessionId, runId, stores: props.stores, actions: props.actions });
}
var ASSISTANT_MESSAGE_EVENT = "assistant/message";
var LOCAL_COMMAND_NODE_KIND = "raw-agent-local-command";
var LOCAL_COMMAND_DEFINITION_KIND = "raw-agent-local-command-output";
var LOCAL_COMMAND_GROUP_TREE = "turn";
function localCommandDefinition() {
  const dataOf = (event) => {
    if (event.type !== ASSISTANT_MESSAGE_EVENT) return void 0;
    const source = event.data?.message?.source;
    const d = localCommandOf(source, event.seq);
    if (!d) return void 0;
    const text3 = messageText(event.data?.message);
    return text3 !== "" ? { ...d, text: text3 } : d;
  };
  return {
    kind: LOCAL_COMMAND_DEFINITION_KIND,
    target: "chat",
    match: (event) => {
      const d = dataOf(event);
      return d ? { id: `local-${event.seq}`, role: "start", exclusive: true } : null;
    },
    start: (_context, match) => dataOf(match.event),
    update: (context) => context.state,
    buildViewNode: (context) => {
      if (context.state === void 0) return null;
      return {
        key: context.key,
        kind: LOCAL_COMMAND_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        // R7.2 (live M6): without a position DSH put the node in a folded "process" group, so the
        // `/context` table stayed hidden. `turn` keeps it in its turn, outside the disclosure,
        // next to DSH's own text of the output (`P/dsh-client-ui-chat` ChatGroupTree).
        groupTree: LOCAL_COMMAND_GROUP_TREE,
        data: context.state
      };
    }
  };
}
function LocalCommandNode(props) {
  const data = props.node?.data;
  if (!data) return null;
  if (!props.sessionId || !props.stores || !props.api) return /* @__PURE__ */ React20.createElement(LocalCommandText, { text: data.text ?? "" });
  return /* @__PURE__ */ React20.createElement(
    LocalCommandView,
    {
      data,
      sessionId: props.sessionId,
      store: props.stores.get(props.sessionId),
      api: props.api
    }
  );
}
var USER_MESSAGE_EVENT = "user/message";
var COMMAND_MARKER_NODE_KIND = "raw-agent-command-marker";
var COMMAND_MARKER_DEFINITION_KIND = "raw-agent-command-marker";
function markerOfEvent(event) {
  if (event.type !== USER_MESSAGE_EVENT) return void 0;
  const m = event.data;
  if (m?.source?.kind !== "user" || !Array.isArray(m.content) || m.content.length !== 1) return void 0;
  const b = m.content[0];
  if (b?.type !== "text" || typeof b.text !== "string") return void 0;
  return commandMarkerOf(b.text, event.seq, event.time);
}
function commandMarkerDefinition() {
  return {
    kind: COMMAND_MARKER_DEFINITION_KIND,
    target: "chat",
    match: (event) => {
      return markerOfEvent(event) ? { id: `marker-${event.seq}`, role: "start" } : null;
    },
    start: (_context, match) => markerOfEvent(match.event),
    update: (context) => context.state,
    buildViewNode: (context) => {
      if (context.state === void 0) return null;
      return {
        key: context.key,
        kind: COMMAND_MARKER_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        groupTree: LOCAL_COMMAND_GROUP_TREE,
        data: context.state
      };
    }
  };
}
function CommandMarkerNode(props) {
  const data = props.node?.data;
  if (!data || !props.sessionId || !props.stores) return null;
  const reader = data.kind === "compacted" ? props.readers?.get(props.sessionId) : void 0;
  return /* @__PURE__ */ React20.createElement(CommandMarkerView, { marker: data, store: props.stores.get(props.sessionId), ...reader ? { reader } : {} });
}
function fileResourceAddress(sessionId, path) {
  const enc = (s2) => encodeURIComponent(s2).replace(/%3A/gi, ":");
  const posix = path.replace(/\\/g, "/");
  const parts = posix.split("/").map(enc).join("/");
  return `dsh-resource://file/session/${enc(sessionId)}/${parts}`;
}
async function copyText(text3) {
  try {
    const clip = globalThis.navigator?.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text3);
      return true;
    }
  } catch {
  }
  try {
    const doc = globalThis.document;
    const area = doc.createElement("textarea");
    area.value = text3;
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
function hostActions(ctx, sideChat = { on: false }) {
  const sidebar = () => ctx.get("sidebarRight");
  return {
    sideChatInSidebar: () => sideChat.on && typeof sidebar()?.openTabIn === "function",
    onSideChatChange(listener) {
      const set = sideChat.listeners ??= /* @__PURE__ */ new Set();
      set.add(listener);
      return () => set.delete(listener);
    },
    openSideChat: (sessionId, options) => openSideChatTab(sidebar(), sideChat, sessionId, options),
    openPreview(sessionId, path) {
      const s2 = sidebar();
      if (typeof s2?.openResourceIn !== "function") return false;
      s2.openResourceIn(sessionId, fileResourceAddress(sessionId, path));
      return true;
    },
    openTerminal(sessionId) {
      const s2 = sidebar();
      if (typeof s2?.openTabIn !== "function") return false;
      s2.openTabIn(sessionId, TERMINAL_TAB_KIND);
      return true;
    },
    copy: copyText,
    hideNativeSeat: (el) => hideNativeSeat(el),
    isOurPreset,
    markToolCall: (callId, label2) => markToolCard(callId, label2),
    revealToolCall(callId) {
      const el = findToolCard(callId);
      if (!el || typeof el.scrollIntoView !== "function") return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    },
    stopTurn(sessionId) {
      const sessions = ctx.get("sessions");
      const conversation = sessions?.scope?.(sessionId)?.get("conversation");
      if (typeof conversation?.cancel !== "function") return false;
      void conversation.cancel().catch(() => void 0);
      return true;
    },
    portal(node) {
      const body = globalThis.document?.body;
      return body ? (0, import_react_dom.createPortal)(node, body) : node;
    },
    openChild(address) {
      const ws = ctx.get("uiWorkspace");
      if (typeof ws?.openSession !== "function") return false;
      ws.openSession(address);
      return true;
    },
    openChildAside(address) {
      const s2 = sidebar();
      if (typeof s2?.openResource !== "function") return false;
      s2.openResource(childChatAddress(address), { kind: CHILD_CHAT_TAB_KIND, preferNewPane: true });
      return true;
    },
    async forkSession(sessionId, atSeq) {
      const sessions = ctx.get("sessions");
      if (typeof sessions?.fork !== "function") throw new Error("DSH offers no branch action here");
      return sessions.fork({ sessionId, atSeq, increaseTitle: true });
    },
    openSession(sessionId) {
      const ws = ctx.get("uiWorkspace");
      if (typeof ws?.openSession !== "function") return false;
      ws.openSession(sessionId);
      return true;
    }
  };
}
var SETTINGS_SECTION_SLOT = "settings.section";
var GRANTS_SECTION_ID = "raw-agent-plugin-access";
var PLUGIN_EXTRAS_ENTRY_ID = "raw-agent-plugin-extras";
var PLUGIN_EXTRAS_SLOT = "raw-agent.controls.extra";
var PLUGIN_EXTRAS_ORDER = 51;
var SETTINGS_GENERAL_SLOT = "settings.general.item";
var ACCESS_NOTE_ID = "raw-agent-access-note";
var ACCESS_NOTE_ORDER = -19;
function registerSideChat(scope, registry, state, inject2) {
  const tabs = registry;
  if (typeof tabs?.register !== "function") return false;
  const register = () => {
    let off;
    try {
      off = tabs.register(sideChatTabDefinition());
    } catch (error) {
      console.warn("[raw-agent] could not register the side chat tab; the inline box stays", error);
      return () => {
      };
    }
    setSideChat(state, true);
    return () => {
      setSideChat(state, false);
      off();
    };
  };
  if (typeof scope.effect === "function") scope.effect(register, "raw-agent: side chat tab type");
  else register();
  scope.slots.inject(
    SIDE_CHAT_TAB_SLOT,
    () => scope.slots.register(
      {
        name: SIDE_CHAT_TAB_SLOT,
        key: SIDE_CHAT_TAB_ID,
        inject: (sessionId) => ({
          ...typeof sessionId === "string" ? { sessionId } : {},
          stores: inject2.stores,
          api: inject2.api,
          agentNames: inject2.agentNames
        })
      },
      SideChatTab
    )
  );
  return true;
}
function mountClient(ctx, options = {}) {
  const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, { credentials: "same-origin", ...init }));
  const api = options.api ?? createApi(fetchFn);
  const plugin = options.plugin ?? createPluginApi(fetchFn);
  const stores = new SessionStores(api);
  try {
    ctx.provide?.(RAW_AGENT_CLIENT_SERVICE, createRawAgentClientService(stores, plugin));
  } catch (error) {
    console.warn("[raw-agent] could not provide the rawAgentClient service", error);
  }
  const links = new ChildLinks(api);
  const readers = new UsageReaders(stores, api);
  const sideChat = { on: false };
  const actions = hostActions(ctx, sideChat);
  ctx.effect?.(
    () => () => {
      readers.dispose();
      stores.dispose();
      links.dispose();
    },
    "raw-agent: session stores"
  );
  const takeover = { on: false };
  const withService = (name2, fn) => {
    if (typeof ctx.inject === "function")
      ctx.inject([name2, "slots"], (scope) => fn(scope[name2] ?? scope.get(name2), scope));
    else {
      const svc = ctx.get(name2);
      if (svc) fn(svc, ctx);
    }
  };
  withService("inputTriggers", (svc, scope) => {
    const triggers = svc;
    if (typeof triggers?.registerSource !== "function") return;
    const source = agentCommandSource(stores, api);
    scope.effect?.(() => triggers.registerSource(source), "raw-agent: agent command source");
  });
  withService("uiSession", (svc, scope) => {
    const ui = svc;
    if (typeof ui?.registerPendingInteraction !== "function") return;
    const publish = ui.registerPendingInteraction(() => ASK_INTERACTION_PRECEDENCE);
    takeover.on = true;
    scope.effect?.(() => {
      const off = publishAsks(stores, publish);
      return () => {
        takeover.on = false;
        off();
      };
    }, "raw-agent: pending asks");
    scope.slots.inject(
      "conversation.composer",
      () => scope.slots.register(
        {
          name: "conversation.composer",
          priority: ASK_COMPOSER_PRIORITY,
          select: selectAsk,
          inject: () => ({ stores, actions })
        },
        AskComposer
      )
    );
  });
  withService("commandUi", (svc, scope) => {
    scope.effect?.(() => {
      const undo = guardPresetDecoration(svc, (id) => isOurSession(stores, id), modePopup(stores));
      if (!undo) console.warn("[raw-agent] DSH command UI has no decoration map; /permission may open DSH presets");
      return undo ?? (() => {
      });
    }, "raw-agent: /permission preset popup");
    scope.effect?.(() => {
      const undo = guardModelContribution(
        svc,
        (id) => isOurSession(stores, id),
        (id) => stores.get(id).requestPanel("model")
      );
      if (!undo) console.warn("[raw-agent] DSH command UI has no contribution map; /model opens DSH models");
      return undo ?? (() => {
      });
    }, "raw-agent: /model popup");
  });
  withService("shortcuts", (svc, scope) => {
    const keys = svc;
    if (typeof keys?.observeFixedInput !== "function" || typeof keys.registerFixed !== "function") return;
    scope.effect?.(() => {
      let unregister;
      try {
        unregister = keys.registerFixed({
          id: MODE_SHORTCUT_ID,
          label: () => "Next permission mode (agent sessions)",
          keys: ["Shift", "Tab"],
          bindings: [{ code: "Tab", modifiers: ["shift"] }],
          group: "input"
        });
      } catch {
        return () => {
        };
      }
      const unobserve = keys.observeFixedInput(modeKeyHandler(stores));
      return () => {
        unobserve();
        unregister();
      };
    }, "raw-agent: Shift+Tab mode key");
  });
  withService("uiConversation", (svc, scope) => {
    const conv = svc;
    if (typeof conv?.events?.register !== "function") return;
    const events = conv.events;
    scope.effect?.(() => events.register(wakeDefinition()), "raw-agent: wake trigger");
    scope.slots.inject(
      "conversation.chat.node",
      () => scope.slots.register(
        { name: "conversation.chat.node", key: WAKE_NODE_KIND },
        WakeNode
      )
    );
    scope.effect?.(() => events.register(workflowDefinition()), "raw-agent: workflow card");
    scope.slots.inject(
      "conversation.chat.node",
      () => scope.slots.register(
        { name: "conversation.chat.node", key: WORKFLOW_NODE_KIND, inject: () => ({ stores, actions }) },
        WorkflowNode
      )
    );
    scope.effect?.(() => events.register(localCommandDefinition()), "raw-agent: local command outputs");
    scope.slots.inject(
      "conversation.chat.node",
      () => scope.slots.register(
        { name: "conversation.chat.node", key: LOCAL_COMMAND_NODE_KIND, inject: () => ({ stores, api }) },
        LocalCommandNode
      )
    );
    scope.effect?.(() => events.register(commandMarkerDefinition()), "raw-agent: command markers");
    scope.slots.inject(
      "conversation.chat.node",
      () => scope.slots.register(
        { name: "conversation.chat.node", key: COMMAND_MARKER_NODE_KIND, inject: () => ({ stores, readers }) },
        CommandMarkerNode
      )
    );
  });
  if (typeof ctx.inject === "function")
    ctx.inject(["sidebarRightTabs", "sidebarRight", "slots"], (scope) => {
      registerSideChat(scope, scope.sidebarRightTabs ?? scope.get("sidebarRightTabs"), sideChat, {
        stores,
        api,
        agentNames: options.agentNames ?? []
      });
    });
  else
    registerSideChat(ctx, ctx.get("sidebarRightTabs"), sideChat, { stores, api, agentNames: options.agentNames ?? [] });
  if (options.toolViews && options.toolViews.length > 0) registerToolViews(ctx.slots, options.toolViews, stores, links);
  ctx.slots.inject(
    AGENTS_SLOT,
    () => ctx.slots.register(
      {
        name: AGENTS_SLOT,
        id: AGENTS_ENTRY_ID,
        order: 20,
        inject: (sessionId) => ({ sessionId, stores, links, actions })
      },
      AgentsHeader
    )
  );
  ctx.slots.inject(
    CONTEXT_PILL_SLOT,
    () => ctx.slots.register(
      {
        name: CONTEXT_PILL_SLOT,
        id: CONTEXT_PILL_ENTRY_ID,
        order: CONTEXT_PILL_ORDER,
        inject: (sessionId) => ({ store: stores.get(sessionId), reader: readers.get(sessionId), actions })
      },
      ContextPill
    )
  );
  ctx.slots.inject(
    LIFECYCLE_SLOT,
    () => ctx.slots.register(
      {
        name: LIFECYCLE_SLOT,
        id: LIFECYCLE_ENTRY_ID,
        order: LIFECYCLE_ORDER,
        inject: (sessionId) => ({ store: stores.get(sessionId) })
      },
      LifecycleBanner
    )
  );
  ctx.slots.inject(
    CONTROLS_SLOT,
    () => ctx.slots.register(
      {
        name: CONTROLS_SLOT,
        id: CONTROLS_ENTRY_ID,
        order: 50,
        // A strict session slot passes the session id to `inject` (`P/dsh-client-ui-renderer`, runInject).
        inject: (sessionId) => ({
          store: stores.get(sessionId),
          api,
          actions,
          stores,
          plugin,
          // Read at render: the session service may arrive after the controls mount.
          asksInComposer: () => takeover.on
        })
      },
      SessionControls
    )
  );
  ctx.slots.inject(
    SETTINGS_SECTION_SLOT,
    () => ctx.slots.register(
      {
        name: SETTINGS_SECTION_SLOT,
        id: GRANTS_SECTION_ID,
        order: 900,
        label: "Agent plugin access",
        inject: () => ({ plugin, copy: actions.copy })
      },
      GrantsPanel
    )
  );
  ctx.slots.inject(
    SETTINGS_GENERAL_SLOT,
    () => ctx.slots.register(
      {
        name: SETTINGS_GENERAL_SLOT,
        id: ACCESS_NOTE_ID,
        order: ACCESS_NOTE_ORDER,
        inject: () => ({ agentNames: options.agentNames ?? [] })
      },
      AccessNote
    )
  );
  ctx.slots.inject(CONTROLS_SLOT, () => {
    try {
      return ctx.slots.register(
        {
          name: CONTROLS_SLOT,
          id: PLUGIN_EXTRAS_ENTRY_ID,
          order: PLUGIN_EXTRAS_ORDER,
          children: { [PLUGIN_EXTRAS_SLOT]: { kind: "list", scope: "session" } },
          inject: (sessionId) => ({ store: stores.get(sessionId), slotKey: PLUGIN_EXTRAS_SLOT })
        },
        PluginExtras
      );
    } catch (error) {
      console.warn("[raw-agent] could not declare the plugin slot", error);
      return () => {
      };
    }
  });
  return stores;
}

// packages/dsh-client/src/index.ts
function createRawAgentClient(options = {}) {
  return {
    name: options.name ?? "dsh-raw-agent-client",
    inject: ["slots"],
    apply(ctx) {
      mountClient(ctx, options);
    }
  };
}

// packages/views-claude/src/views.tsx
var React21 = __toESM(require("react"), 1);

// packages/views-claude/src/model.ts
var str2 = (v4) => typeof v4 === "string";
var rec2 = (v4) => typeof v4 === "object" && v4 !== null && !Array.isArray(v4);
var text2 = (v4) => str2(v4) && v4.trim() !== "" ? v4 : void 0;
var num = (v4) => typeof v4 === "number" && Number.isFinite(v4) ? v4 : void 0;
function displayPath(path, cwd, home) {
  const p = path.replace(/\\/g, "/");
  const strip = (base) => {
    if (!base) return void 0;
    const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
    if (b === "") return void 0;
    if (p === b) return ".";
    return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : void 0;
  };
  const rel = strip(cwd);
  if (rel !== void 0) return rel;
  const h = strip(home);
  if (h !== void 0) return h === "." ? "~" : `~/${h}`;
  return path;
}
function firstLine(value, max = 120) {
  const line = value.split("\n").find((l) => l.trim() !== "") ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}
var STOPPED = /^(?:The user doesn't want to proceed|\[Request interrupted by user)/;
function rowState(p) {
  if (p.phase === "preparing") return "preparing";
  if (!p.result) return "running";
  if (p.result.isError) return STOPPED.test(p.result.text.trim()) ? "stopped" : "error";
  return "done";
}
var STATE_LABEL = {
  preparing: "writing\u2026",
  running: "running\u2026",
  done: "",
  error: "failed",
  stopped: "stopped"
};
function bashModel(input) {
  const m = {
    command: str2(input.command) ? input.command : "",
    background: input.run_in_background === true
  };
  const d = text2(input.description);
  if (d) m.description = d;
  const t = num(input.timeout);
  if (t !== void 0) m.timeoutMs = t;
  return m;
}
function readModel(input) {
  const m = {};
  const path = text2(input.file_path) ?? text2(input.notebook_path) ?? text2(input.path);
  if (path) m.path = path;
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset !== void 0 && limit !== void 0) m.range = `lines ${offset}\u2013${offset + limit - 1}`;
  else if (offset !== void 0) m.range = `from line ${offset}`;
  else if (limit !== void 0) m.range = `first ${limit} lines`;
  if (text2(input.pages)) m.range = `pages ${String(input.pages)}`;
  if (offset !== void 0 && offset > 0) m.line = offset;
  return m;
}
function readLines2(result) {
  return splitLines(result).map((l) => {
    const m = /^\s*(\d+)(?:\t|→)(.*)$/.exec(l);
    return m ? { n: Number(m[1]), text: m[2] ?? "" } : { text: l };
  });
}
function editModel(input) {
  const path = text2(input.file_path);
  const lines = [];
  let edits = 0;
  if (str2(input.old_string) || str2(input.new_string)) {
    edits = 1;
    lines.push(
      ...numberDiff(
        lineDiff(str2(input.old_string) ? input.old_string : "", str2(input.new_string) ? input.new_string : "")
      )
    );
  } else if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!rec2(e)) continue;
      if (edits > 0) lines.push({ op: " ", text: "\u22EF" });
      edits++;
      lines.push(...numberDiff(lineDiff(str2(e.old_string) ? e.old_string : "", str2(e.new_string) ? e.new_string : "")));
    }
  }
  const { added, removed } = diffCounts(lines);
  const m = { lines, added, removed, replaceAll: input.replace_all === true, edits };
  if (path) m.path = path;
  return m;
}
function writeModel(input) {
  const content = str2(input.content) ? input.content : "";
  const lines = splitLines(content).map((t, i) => ({ op: "+", text: t, new: i + 1 }));
  const path = text2(input.file_path);
  return path ? { path, lines } : { lines };
}
function searchSummary(input, cwd, home) {
  const parts = [];
  const pattern = text2(input.pattern);
  if (pattern) parts.push(pattern);
  const path = text2(input.path);
  if (path) parts.push(`in ${displayPath(path, cwd, home)}`);
  const glob = text2(input.glob);
  if (glob) parts.push(`(${glob})`);
  const type = text2(input.type);
  if (type) parts.push(`type ${type}`);
  return parts.join(" ");
}
function resultCount(result) {
  return splitLines(result).filter((l) => l.trim() !== "").length;
}
function agentModel(input) {
  const m = { background: input.run_in_background === true };
  const t = text2(input.subagent_type);
  if (t) m.agentType = t;
  const d = text2(input.description);
  if (d) m.description = d;
  const p = text2(input.prompt);
  if (p) m.prompt = p;
  const n2 = text2(input.name);
  if (n2) m.name = n2;
  const mo = text2(input.model);
  if (mo) m.model = mo;
  return m;
}
function todoItems(input) {
  if (!Array.isArray(input.todos)) return [];
  const out = [];
  for (const t of input.todos) {
    if (!rec2(t)) continue;
    const status = str2(t.status) ? t.status : "pending";
    const label2 = status === "in_progress" ? text2(t.activeForm) ?? text2(t.content) : text2(t.content);
    if (label2) out.push({ text: label2, status });
  }
  return out;
}
function todoSummary(items) {
  if (items.length === 0) return "";
  const done = items.filter((t) => t.status === "completed").length;
  const now = items.find((t) => t.status === "in_progress");
  return `${done}/${items.length} done${now ? ` \xB7 ${now.text}` : ""}`;
}
function skillName(input) {
  const n2 = text2(input.skill) ?? text2(input.command) ?? text2(input.name);
  return n2?.replace(/^\//, "");
}
function questionModels(input) {
  if (!Array.isArray(input.questions)) return [];
  const out = [];
  for (const q2 of input.questions) {
    if (!rec2(q2) || !str2(q2.question)) continue;
    const options = Array.isArray(q2.options) ? q2.options.map((o) => rec2(o) && str2(o.label) ? o.label : str2(o) ? o : "").filter((o) => o !== "") : [];
    const m = { question: q2.question, options, multiSelect: q2.multiSelect === true };
    const h = text2(q2.header);
    if (h) m.header = h;
    out.push(m);
  }
  return out;
}
function planTitle(plan) {
  const heading = plan.split("\n").find((l) => /^#{1,6}\s+\S/.test(l));
  return firstLine(heading ? heading.replace(/^#{1,6}\s+/, "") : plan, 100);
}
function safeUrl(v4) {
  if (!str2(v4)) return void 0;
  try {
    const u = new URL(v4);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : void 0;
  } catch {
    return void 0;
  }
}

// packages/views-claude/src/views.tsx
var v3 = (name2, alias, fallback) => `var(--raw-agent-${name2}, var(--dsw-alias-${alias}, ${fallback}))`;
var muted9 = v3("muted", "label-secondary", "GrayText");
var border9 = v3("border", "border-l2", "rgba(128,128,128,0.35)");
var mono = "var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
var toolCss = {
  row: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, minWidth: 0, padding: "2px 0" },
  head: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    padding: 0,
    font: "inherit",
    color: "inherit",
    textAlign: "left",
    width: "100%"
  },
  title: { fontWeight: 600, flex: "none" },
  summary: {
    color: muted9,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: "0 1 auto"
  },
  state: { fontSize: 11, color: muted9, flex: "none" },
  error: { fontSize: 11, color: v3("danger", "state-error-primary", "#c0392b"), flex: "none" },
  body: { display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12, minWidth: 0 },
  pre: {
    fontFamily: mono,
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    border: `1px solid ${border9}`,
    borderRadius: 6,
    padding: 8,
    margin: 0,
    maxHeight: 320,
    overflow: "auto"
  },
  errorText: { color: v3("danger", "state-error-primary", "#c0392b") },
  label: { fontSize: 11, color: muted9 },
  add: { background: v3("diff-add", "code-diff-added", "rgba(46,160,67,0.18)") },
  del: { background: v3("diff-del", "code-diff-deleted", "rgba(248,81,73,0.18)") },
  num: { color: muted9, userSelect: "none", whiteSpace: "pre" },
  gap: { color: muted9 },
  counts: { fontSize: 11, flex: "none" },
  addCount: { color: v3("done", "state-success-primary", "#22a06b") },
  delCount: { color: v3("danger", "state-error-primary", "#c0392b") },
  link: { color: v3("link", "link", "LinkText"), wordBreak: "break-all", cursor: "pointer" },
  todo: { display: "flex", gap: 6, alignItems: "baseline", listStyle: "none", fontSize: 13 },
  todoList: { margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 },
  button: {
    font: "inherit",
    fontSize: 12,
    color: "inherit",
    background: "transparent",
    border: `1px solid ${border9}`,
    borderRadius: 6,
    padding: "1px 6px",
    cursor: "pointer",
    alignSelf: "flex-start"
  }
};
var BODY_LINES = 40;
function StateTag(props) {
  const label2 = STATE_LABEL[props.state];
  if (!label2) return null;
  return /* @__PURE__ */ React21.createElement(
    "span",
    {
      style: props.state === "error" ? toolCss.error : toolCss.state,
      "data-raw-agent": "tool-state",
      "data-state": props.state
    },
    label2
  );
}
function ToolRow(props) {
  const state = rowState(props.call);
  const [open, setOpen] = React21.useState(props.open === true);
  const hasBody = props.children !== void 0 && props.children !== null && props.children !== false;
  return /* @__PURE__ */ React21.createElement("div", { style: toolCss.row, "data-raw-agent": `tool-${props.view}`, "data-tool": props.call.toolName }, /* @__PURE__ */ React21.createElement(
    "button",
    {
      type: "button",
      style: toolCss.head,
      "aria-expanded": hasBody ? open : void 0,
      onClick: () => hasBody && setOpen(!open),
      "data-raw-agent": "tool-head"
    },
    /* @__PURE__ */ React21.createElement("span", { style: toolCss.title }, props.title),
    props.summary !== void 0 && props.summary !== "" && /* @__PURE__ */ React21.createElement("span", { style: toolCss.summary }, props.summary),
    props.extra,
    /* @__PURE__ */ React21.createElement(StateTag, { state })
  ), hasBody && open && /* @__PURE__ */ React21.createElement("div", { style: toolCss.body, "data-raw-agent": "tool-body" }, props.children));
}
function TextBox(props) {
  const [all, setAll] = React21.useState(false);
  const lines = splitLines(props.text);
  const shown = all ? lines : lines.slice(0, BODY_LINES);
  const hidden = lines.length - shown.length;
  return /* @__PURE__ */ React21.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2 } }, props.label && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, props.label), /* @__PURE__ */ React21.createElement(
    "pre",
    {
      style: props.error ? { ...toolCss.pre, ...toolCss.errorText } : toolCss.pre,
      "data-raw-agent": props.testId ?? "tool-text"
    },
    shown.join("\n") || "\xA0"
  ), hidden > 0 && /* @__PURE__ */ React21.createElement("button", { type: "button", style: toolCss.button, onClick: () => setAll(true), "data-raw-agent": "tool-show-all" }, "Show all (", hidden, " more ", hidden === 1 ? "line" : "lines", ")"));
}
function ResultBox(props) {
  const r = props.call.result;
  if (!r) return null;
  const note = r.images > 0 ? `${r.images === 1 ? "An image" : `${r.images} images`} (shown by the host).` : void 0;
  if (r.text === "" && note) return /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, note);
  return /* @__PURE__ */ React21.createElement(React21.Fragment, null, /* @__PURE__ */ React21.createElement(TextBox, { text: r.text, error: r.isError, testId: "tool-result", ...props.label ? { label: props.label } : {} }), note && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, note));
}
function PathLink(props) {
  const { call, path } = props;
  const shown = displayPath(path, call.cwd, call.home);
  if (!call.openFile) return /* @__PURE__ */ React21.createElement("span", null, shown);
  return /* @__PURE__ */ React21.createElement(
    "span",
    {
      role: "link",
      tabIndex: 0,
      style: toolCss.link,
      title: path,
      "data-raw-agent": "tool-path",
      onClick: (e) => {
        e.stopPropagation();
        call.openFile?.(path, props.line);
      },
      onKeyDown: (e) => {
        if (e.key !== "Enter") return;
        e.stopPropagation();
        call.openFile?.(path, props.line);
      }
    },
    shown
  );
}
function DiffBox(props) {
  const [full, setFull] = React21.useState(false);
  const changed = props.lines.some((l) => l.op !== " ");
  const rows = full || !changed ? props.lines : diffHunks(props.lines);
  const width = String(props.lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length;
  const numbered = props.lines.some((l) => l.old !== void 0 || l.new !== void 0);
  return /* @__PURE__ */ React21.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React21.createElement("pre", { style: toolCss.pre, "data-raw-agent": "tool-diff" }, rows.map(
    (l, i) => l.op === "\u2026" ? /* @__PURE__ */ React21.createElement("div", { key: i, style: toolCss.gap }, `\u22EF ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}`) : /* @__PURE__ */ React21.createElement("div", { key: i, style: l.op === "+" ? toolCss.add : l.op === "-" ? toolCss.del : void 0, "data-op": l.op }, numbered && /* @__PURE__ */ React21.createElement("span", { style: toolCss.num, "data-raw-agent": "tool-diff-num", "aria-hidden": "true" }, `${l.old ?? ""}`.padStart(width), " ", `${l.new ?? ""}`.padStart(width), " "), `${l.op} ${l.text}`)
  )), rows.length < props.lines.length || full ? /* @__PURE__ */ React21.createElement("button", { type: "button", style: toolCss.button, onClick: () => setFull(!full) }, full ? "Show only the changes" : "Show the whole edit") : null);
}
function Counts(props) {
  if (props.added === 0 && props.removed === 0) return null;
  return /* @__PURE__ */ React21.createElement("span", { style: toolCss.counts, "data-raw-agent": "tool-counts" }, /* @__PURE__ */ React21.createElement("span", { style: toolCss.addCount }, "+", props.added), " ", /* @__PURE__ */ React21.createElement("span", { style: toolCss.delCount }, "\u2212", props.removed));
}
function BashView(call) {
  const m = bashModel(call.input);
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "bash",
      call,
      title: "Bash",
      summary: m.description ?? firstLine(m.command),
      extra: m.background ? /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, "background") : void 0
    },
    m.command !== "" && /* @__PURE__ */ React21.createElement(TextBox, { text: `$ ${m.command}`, testId: "tool-command" }),
    /* @__PURE__ */ React21.createElement(ResultBox, { call, label: m.background ? "Started in the background" : "Output" })
  );
}
function ReadView(call) {
  const m = readModel(call.input);
  const r = call.result;
  const lines = r && !r.isError ? readLines2(r.text) : [];
  const numbered = lines.some((l) => l.n !== void 0);
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "read",
      call,
      title: "Read",
      summary: m.path ? /* @__PURE__ */ React21.createElement(React21.Fragment, null, /* @__PURE__ */ React21.createElement(PathLink, { call, path: m.path, ...m.line !== void 0 ? { line: m.line } : {} }), m.range ? ` \xB7 ${m.range}` : "") : void 0,
      extra: numbered ? /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, `${lines.length} lines`) : void 0
    },
    r && numbered ? /* @__PURE__ */ React21.createElement(
      TextBox,
      {
        text: lines.map((l) => l.n !== void 0 ? `${String(l.n).padStart(5)}  ${l.text}` : l.text).join("\n"),
        testId: "tool-result"
      }
    ) : /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
function EditView(call) {
  const m = editModel(call.input);
  const failed = call.result?.isError === true;
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "edit",
      call,
      title: call.toolName === "MultiEdit" ? "MultiEdit" : "Edit",
      summary: m.path ? /* @__PURE__ */ React21.createElement(PathLink, { call, path: m.path }) : void 0,
      extra: /* @__PURE__ */ React21.createElement(React21.Fragment, null, !failed && /* @__PURE__ */ React21.createElement(Counts, { added: m.added, removed: m.removed }), m.edits > 1 && /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, `${m.edits} edits`))
    },
    m.replaceAll && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, "Every match is replaced."),
    m.lines.length > 0 && /* @__PURE__ */ React21.createElement(DiffBox, { lines: m.lines }),
    m.lines.length > 0 && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, "Line numbers count from the start of the edited text."),
    failed && /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
function WriteView(call) {
  const m = writeModel(call.input);
  const failed = call.result?.isError === true;
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "write",
      call,
      title: "Write",
      summary: m.path ? /* @__PURE__ */ React21.createElement(PathLink, { call, path: m.path }) : void 0,
      extra: /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, `${m.lines.length} ${m.lines.length === 1 ? "line" : "lines"}`)
    },
    m.lines.length > 0 && /* @__PURE__ */ React21.createElement(DiffBox, { lines: m.lines }),
    failed && /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
function SearchView(props) {
  const { call } = props;
  const r = call.result;
  const count = r && !r.isError ? resultCount(r.text) : void 0;
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: props.view,
      call,
      title: props.title,
      summary: searchSummary(call.input, call.cwd, call.home),
      extra: count !== void 0 ? /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, `${count} ${props.noun}`) : void 0
    },
    /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
var GrepView = (call) => /* @__PURE__ */ React21.createElement(SearchView, { call, title: "Grep", noun: "lines", view: "grep" });
var GlobView = (call) => /* @__PURE__ */ React21.createElement(SearchView, { call, title: "Glob", noun: "files", view: "glob" });
function AgentView(call) {
  const m = agentModel(call.input);
  const who = m.name ?? m.agentType ?? "agent";
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "agent",
      call,
      title: call.toolName === "Task" ? "Task" : "Agent",
      summary: `${who}${m.description ? ` \xB7 ${m.description}` : ""}`,
      extra: m.background ? /* @__PURE__ */ React21.createElement("span", { style: toolCss.state }, "background") : void 0
    },
    m.prompt && /* @__PURE__ */ React21.createElement(TextBox, { text: m.prompt, label: "Task", testId: "tool-prompt" }),
    /* @__PURE__ */ React21.createElement(ResultBox, { call, label: "Result" })
  );
}
var TODO_MARK = { completed: "\u2611", in_progress: "\u25D0", pending: "\u2610" };
function TodoWriteView(call) {
  const items = todoItems(call.input);
  return /* @__PURE__ */ React21.createElement(ToolRow, { view: "todo", call, title: "Tasks", summary: todoSummary(items), open: true }, items.length > 0 && /* @__PURE__ */ React21.createElement("ul", { style: toolCss.todoList, "data-raw-agent": "tool-checklist" }, items.map((t, i) => /* @__PURE__ */ React21.createElement(
    "li",
    {
      key: i,
      style: {
        ...toolCss.todo,
        ...t.status === "completed" ? { textDecoration: "line-through", color: muted9 } : {},
        ...t.status === "in_progress" ? { fontWeight: 600 } : {}
      },
      "data-status": t.status
    },
    /* @__PURE__ */ React21.createElement("span", { "aria-hidden": "true" }, TODO_MARK[t.status] ?? "\u2610"),
    /* @__PURE__ */ React21.createElement("span", null, t.text)
  ))), call.result?.isError === true && /* @__PURE__ */ React21.createElement(ResultBox, { call }));
}
function WebFetchView(call) {
  const url = safeUrl(call.input.url);
  const raw = str2(call.input.url) ? call.input.url : "";
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "web-fetch",
      call,
      title: "Fetch",
      summary: url ? /* @__PURE__ */ React21.createElement(
        "a",
        {
          href: url,
          target: "_blank",
          rel: "noreferrer noopener",
          style: toolCss.link,
          onClick: (e) => e.stopPropagation(),
          "data-raw-agent": "tool-url"
        },
        url
      ) : raw
    },
    str2(call.input.prompt) && call.input.prompt !== "" && /* @__PURE__ */ React21.createElement(TextBox, { text: call.input.prompt, label: "Prompt" }),
    /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
function WebSearchView(call) {
  const q2 = str2(call.input.query) ? call.input.query : "";
  const domains = Array.isArray(call.input.allowed_domains) ? call.input.allowed_domains.filter(str2) : [];
  return /* @__PURE__ */ React21.createElement(ToolRow, { view: "web-search", call, title: "Web search", summary: q2 }, domains.length > 0 && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, "Only: ", domains.join(", ")), /* @__PURE__ */ React21.createElement(ResultBox, { call }));
}
function SkillView(call) {
  const name2 = skillName(call.input);
  const args = str2(call.input.args) && call.input.args.trim() !== "" ? call.input.args : void 0;
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "skill",
      call,
      title: "Skill",
      summary: name2 ? /* @__PURE__ */ React21.createElement(React21.Fragment, null, /* @__PURE__ */ React21.createElement("span", { "data-raw-agent": "tool-skill-name", style: { fontFamily: mono } }, name2), args ? ` ${firstLine(args, 80)}` : "") : void 0
    },
    args && /* @__PURE__ */ React21.createElement(TextBox, { text: args, label: "Arguments" }),
    /* @__PURE__ */ React21.createElement(ResultBox, { call })
  );
}
function ExitPlanModeView(call) {
  const plan = str2(call.input.plan) ? call.input.plan : "";
  return /* @__PURE__ */ React21.createElement(ToolRow, { view: "plan", call, title: "Plan", summary: plan ? planTitle(plan) : void 0 }, plan !== "" && /* @__PURE__ */ React21.createElement(TextBox, { text: plan, testId: "tool-plan" }), /* @__PURE__ */ React21.createElement(ResultBox, { call, label: "Answer" }));
}
function AskUserQuestionView(call) {
  const qs = questionModels(call.input);
  return /* @__PURE__ */ React21.createElement(
    ToolRow,
    {
      view: "question",
      call,
      title: "Question",
      summary: qs.length === 1 ? qs[0].question : qs.length > 1 ? `${qs.length} questions` : void 0
    },
    qs.map((q2, i) => /* @__PURE__ */ React21.createElement("div", { key: i, style: { display: "flex", flexDirection: "column", gap: 2 }, "data-raw-agent": "tool-question" }, q2.header && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, q2.header), /* @__PURE__ */ React21.createElement("span", null, q2.question), q2.options.length > 0 && /* @__PURE__ */ React21.createElement("span", { style: toolCss.label }, q2.multiSelect ? "Pick any: " : "Pick one: ", q2.options.join(" \xB7 ")))),
    /* @__PURE__ */ React21.createElement(ResultBox, { call, label: "Answers" })
  );
}

// packages/views-claude/src/index.ts
var CLAUDE_TOOL_VIEWS = Object.freeze({
  Bash: BashView,
  Read: ReadView,
  Edit: EditView,
  MultiEdit: EditView,
  Write: WriteView,
  Grep: GrepView,
  Glob: GlobView,
  Agent: AgentView,
  Task: AgentView,
  TodoWrite: TodoWriteView,
  WebFetch: WebFetchView,
  WebSearch: WebSearchView,
  Skill: SkillView,
  ExitPlanMode: ExitPlanModeView,
  AskUserQuestion: AskUserQuestionView
});
var toolViewPack = { kind: "claude-code", views: CLAUDE_TOOL_VIEWS };

// packages/plugin/src/client.ts
var client = createRawAgentClient({
  name: "dsh-raw-agent-client",
  toolViews: [toolViewPack],
  agentNames: ["Claude Code"]
});
var name = client.name;
var inject = client.inject;
var apply = client.apply;
return module.exports; } });
//# sourceMappingURL=client.js.map
