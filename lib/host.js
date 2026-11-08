// packages/backend-claude/src/factory.ts
import {
  accessSync,
  closeSync as closeSync2,
  constants,
  existsSync,
  openSync as openSync2,
  readdirSync,
  readFileSync,
  readSync as readSync2,
  realpathSync as realpathSync2,
  statSync as statSync2
} from "node:fs";
import { homedir } from "node:os";
import * as path8 from "node:path";

// packages/core/src/node.ts
import { createHash } from "node:crypto";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidv5(namespace, name2) {
  if (!UUID_RE.test(namespace)) throw new Error(`uuidv5: namespace is not a UUID: ${namespace}`);
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name2, "utf8")).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// packages/backend-claude/src/binary.ts
import * as path from "node:path";
var ClaudeBinaryNotFoundError = class extends Error {
  constructor(message, tried) {
    super(message);
    this.tried = tried;
    this.name = "ClaudeBinaryNotFoundError";
  }
  tried;
};
function envGet(env, name2, platform) {
  if (platform !== "win32") return env[name2];
  const upper = name2.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper) return v;
  return void 0;
}
function npmShimTarget(shimPath, text) {
  const dir = path.win32.dirname(shimPath);
  const re = /"%~?dp0%?\\([^"]+\.(?:exe|js|mjs|cjs))"/gi;
  let match;
  let last;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last === void 0 ? void 0 : path.win32.join(dir, last);
}
function normalizeConfiguredPath(configured, homedir2, platform) {
  if (configured === void 0) return void 0;
  let c = configured.trim();
  if (c.length >= 2 && (c.startsWith('"') && c.endsWith('"') || c.startsWith("'") && c.endsWith("'")))
    c = c.slice(1, -1).trim();
  if (c === "") return void 0;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (c === "~") return homedir2;
  if (c.startsWith("~/") || platform === "win32" && c.startsWith("~\\")) return p.join(homedir2, c.slice(2));
  return c;
}
function resolveClaudeBinary(configured, deps) {
  const tried = [];
  const p = deps.platform === "win32" ? path.win32 : path.posix;
  const c = normalizeConfiguredPath(configured, deps.homedir, deps.platform);
  if (c !== void 0) {
    tried.push(c);
    if (deps.isExecutable(c)) return { path: c, source: "configured" };
    throw new ClaudeBinaryNotFoundError(
      `The configured Claude Code path does not exist or is not executable: ${c}`,
      tried
    );
  }
  const pathVar = envGet(deps.env, "PATH", deps.platform) ?? "";
  const sep = deps.platform === "win32" ? ";" : ":";
  const names = deps.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of pathVar.split(sep)) {
    if (dir === "") continue;
    for (const name2 of names) {
      const candidate = p.join(dir, name2);
      tried.push(candidate);
      if (!deps.isExecutable(candidate)) continue;
      if (name2.endsWith(".cmd")) {
        const text = deps.readText(candidate);
        const target = text === void 0 ? void 0 : npmShimTarget(candidate, text);
        if (target !== void 0 && deps.isExecutable(target)) return { path: target, source: "path" };
        continue;
      }
      return { path: candidate, source: "path" };
    }
  }
  const localNames = deps.platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
  for (const name2 of localNames) {
    const candidate = p.join(deps.homedir, ".local", "bin", name2);
    tried.push(candidate);
    if (deps.isExecutable(candidate)) return { path: candidate, source: "local-bin" };
  }
  throw new ClaudeBinaryNotFoundError(
    "Claude Code was not found. Install it, or set the path to your `claude` in the plugin settings.",
    tried
  );
}

// packages/backend-claude/src/checkpoint.ts
import * as path2 from "node:path";
function managedSettingsPath(platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return void 0;
}
function claudeConfigDir(env, homedir2, platform) {
  const p = platform === "win32" ? path2.win32 : path2.posix;
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== void 0 && dir !== "" ? dir : p.join(homedir2, ".claude");
}
function claudeGlobalConfigPath(env, homedir2, platform) {
  const p = platform === "win32" ? path2.win32 : path2.posix;
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== void 0 && dir !== "" ? p.join(dir, ".claude.json") : p.join(homedir2, ".claude.json");
}
function envTruthy(v) {
  if (v === void 0) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}
function readJson(deps, file) {
  const text = deps.readText(file);
  if (text === void 0) return void 0;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
  } catch {
    return void 0;
  }
}
function decideFileCheckpointing(deps) {
  if (envTruthy(deps.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)) {
    return { enabled: false, disabledBy: "env:CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING" };
  }
  const p = deps.platform === "win32" ? path2.win32 : path2.posix;
  const configDir = claudeConfigDir(deps.env, deps.homedir, deps.platform);
  const sources = [
    ["user", p.join(configDir, "settings.json")],
    ["project", p.join(deps.cwd, ".claude", "settings.json")],
    ["local", p.join(deps.cwd, ".claude", "settings.local.json")],
    ["policy", managedSettingsPath(deps.platform)],
    ["global-config", claudeGlobalConfigPath(deps.env, deps.homedir, deps.platform)]
  ];
  for (const [label, file] of sources) {
    if (file === void 0) continue;
    const json3 = readJson(deps, file);
    if (json3?.fileCheckpointingEnabled === false) return { enabled: false, disabledBy: label };
  }
  return { enabled: true };
}

// packages/backend-claude/src/config-files.ts
import * as path3 from "node:path";
function claudeConfigFiles(cwd, deps) {
  const p = deps.platform === "win32" ? path3.win32 : path3.posix;
  const dir = claudeConfigDir(deps.env, deps.homedir, deps.platform);
  return [
    { label: "User settings", path: p.join(dir, "settings.json"), scope: "user", format: "json" },
    { label: "Project settings", path: p.join(cwd, ".claude", "settings.json"), scope: "project", format: "json" },
    {
      label: "Project local settings",
      path: p.join(cwd, ".claude", "settings.local.json"),
      scope: "local",
      format: "json"
    }
  ];
}
var MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
function tokenize(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r" || c === "\uFEFF") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i = Math.min(n, i + 1);
      out.push({ t: "str", start, end: i });
    } else if ("{}[]:,".includes(c)) {
      out.push({ t: "punct", c, start: i, end: ++i });
    } else {
      const start = i;
      while (i < n && !' 	\n\r{}[]:,"/'.includes(text[i])) i++;
      if (i === start) i++;
      out.push({ t: "lit", start, end: i });
    }
  }
  return out;
}
function decodeKey(raw) {
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : raw;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}
function envValueTokens(text, toks) {
  const hide = [];
  const stack = [];
  const pathOf = () => stack.filter((f) => f.kind === "obj").map((f) => f.key ?? "");
  const underEnv = () => stack.length >= 1 && stack[0].kind === "obj" && stack[0].key === "env";
  for (const tok of toks) {
    const top = stack[stack.length - 1];
    if (tok.t === "punct") {
      switch (tok.c) {
        case "{":
        case "[":
          if (top?.kind === "obj" && top.expectKey) return void 0;
          stack.push({ kind: tok.c === "{" ? "obj" : "arr", expectKey: tok.c === "{" });
          break;
        case "}":
        case "]":
          if (!top || top.kind !== (tok.c === "}" ? "obj" : "arr")) return void 0;
          stack.pop();
          break;
        case ":":
          if (top?.kind !== "obj" || !top.expectKey || top.key === void 0) return void 0;
          top.expectKey = false;
          break;
        case ",":
          if (!top) return void 0;
          if (top.kind === "obj") {
            top.expectKey = true;
            delete top.key;
          }
          break;
      }
      continue;
    }
    if (!top) {
      if (stack.length === 0 && tok.t === "lit") continue;
      return void 0;
    }
    if (top.kind === "obj" && top.expectKey) {
      if (tok.t !== "str" || top.key !== void 0) return void 0;
      top.key = decodeKey(text.slice(tok.start, tok.end));
      continue;
    }
    if (underEnv()) hide.push({ tok, key: pathOf().join(".") });
  }
  return stack.length === 0 ? hide : void 0;
}
function valueTokensAfterColon(toks) {
  const hide = [];
  for (let k = 1; k < toks.length; k++) {
    const prev = toks[k - 1];
    const tok = toks[k];
    if (prev.t === "punct" && prev.c === ":" && tok.t !== "punct") hide.push({ tok, key: "" });
  }
  return hide;
}
function maskClaudeSettings(file, text) {
  if (file.format !== "json") return { masked: text, secrets: [] };
  const toks = tokenize(text);
  const hide = envValueTokens(text, toks) ?? valueTokensAfterColon(toks);
  let masked = "";
  let at = 0;
  const secrets = [];
  for (const { tok, key } of hide) {
    const isStr = tok.t === "str" && tok.end - tok.start >= 2 && text[tok.end - 1] === '"';
    const sourceStart = isStr ? tok.start + 1 : tok.start;
    const sourceEnd = isStr ? tok.end - 1 : tok.end;
    masked += text.slice(at, sourceStart);
    const start = masked.length;
    masked += MASK;
    const secret = { start, end: masked.length, sourceStart, sourceEnd };
    if (key !== "") secret.key = key;
    secrets.push(secret);
    at = sourceEnd;
  }
  masked += text.slice(at);
  return { masked, secrets };
}

// packages/backend-claude/src/env.ts
var HOST_SESSION_VARS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID"
]);
var CONDITIONAL_HOST_VARS = Object.freeze(["AI_AGENT", "TRACEPARENT", "TRACESTATE"]);
var KEPT_HOST_MARKERS = Object.freeze([
  // Set for Bash, hook and MCP children; the CLI never reads it from its own env (no env
  // accessor in 2.1.318) and overwrites it for its own children.
  "CLAUDE_PROJECT_DIR",
  // Set for MCP children only; read only to gate the Chrome MCP server. A DSH started as a
  // Claude Code MCP server is not a supported setup.
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "GIT_EDITOR",
  "COREPACK_ENABLE_AUTO_PIN",
  "NoDefaultCurrentDirectoryInExePath",
  "SHELL"
]);
function buildClaudeEnv(source, platform = process.platform) {
  const norm2 = (n) => platform === "win32" ? n.toUpperCase() : n;
  const always = new Set(HOST_SESSION_VARS.map(norm2));
  const hadClaudeCode = Object.keys(source).some((k) => norm2(k) === norm2("CLAUDECODE") && source[k] !== void 0);
  const env = {};
  const removed = [];
  for (const [name2, value] of Object.entries(source)) {
    if (value === void 0) continue;
    const n = norm2(name2);
    let reason;
    if (always.has(n)) reason = "host-session";
    else if (n === norm2("AI_AGENT") && value.startsWith("claude-code")) reason = "host-agent-marker";
    else if ((n === norm2("TRACEPARENT") || n === norm2("TRACESTATE")) && hadClaudeCode) reason = "host-trace";
    if (reason !== void 0) removed.push({ name: name2, reason });
    else env[name2] = value;
  }
  return { env, removed };
}
var SDK_DELETED_VARS = Object.freeze(["NODE_OPTIONS", "DEBUG"]);
function restoreSdkDeletedVars(sdkEnv, ours) {
  const out = {};
  for (const [k, v] of Object.entries(sdkEnv)) if (v !== void 0) out[k] = v;
  for (const name2 of SDK_DELETED_VARS) {
    const v = ours[name2];
    if (v !== void 0) out[name2] = v;
  }
  return out;
}
var SDK_PROCESS_ENV_WRITES = Object.freeze([
  "CLAUDE_AGENT_SDK_VERSION",
  "NoDefaultCurrentDirectoryInExePath"
]);
function snapshotEnv(names, target) {
  const saved = names.map((n) => [n, Object.prototype.hasOwnProperty.call(target, n), target[n]]);
  return () => {
    for (const [n, had, v] of saved) {
      if (had && v !== void 0) target[n] = v;
      else delete target[n];
    }
  };
}
function withProcessEnvRestored(names, fn, target = process.env) {
  const restore = snapshotEnv(names, target);
  let result;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result instanceof Promise) {
    return result.finally(restore);
  }
  restore();
  return result;
}
function withSdkVersionEnvRestored(fn, target = process.env) {
  return withProcessEnvRestored(["CLAUDE_AGENT_SDK_VERSION"], fn, target);
}

// packages/backend-claude/src/interactions.ts
var REJECT_CONSTANTS = {
  "2.1.318": {
    mainNoFeedback: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    mainFeedbackPrefix: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n",
    subagentNoFeedback: "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.",
    subagentFeedbackPrefix: "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n",
    /** AskUserQuestion "Chat about this" (binary fn `tht`): this text, then one block per question. */
    clarifyIntro: "The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n",
    clarifyNoAnswer: "  (No answer provided)"
  }
};
var TUI_TEXT = {
  yes: "Yes",
  no: "No",
  rejectPlaceholder: "and tell Claude what to do differently",
  dontAskAgainFor: "Yes, and don't ask again for ",
  allowAccessTo: "Yes, and always allow access to ",
  forThisSession: " for this session",
  switchTo: "Yes, and switch to ",
  planUseAuto: "Yes, and use auto mode",
  planAcceptEdits: "Yes, auto-accept edits",
  planManual: "Yes, manually approve edits",
  planKeepPlanning: "No, keep planning",
  planKeepPlanningPlaceholder: "Tell Claude what to change",
  questionOther: "Other",
  questionChat: "Chat about this",
  prefixPlaceholder: "command prefix (e.g., npm run *)"
};
var MODE_DESCRIPTIONS = {
  default: "default (ask each time)",
  acceptEdits: "accept edits (auto-approve file edits and common file commands)",
  auto: "auto (no routine prompts; a reviewer model screens actions)",
  dontAsk: "don't ask (auto-deny anything that would prompt)",
  plan: "plan mode (research and propose changes without making them)",
  bypassPermissions: "BYPASS PERMISSIONS (no further prompts)"
};
function rejectConstantsFor(cliVersion, warn) {
  const table = REJECT_CONSTANTS;
  if (cliVersion !== void 0 && table[cliVersion]) return table[cliVersion];
  const newest = Object.keys(table).at(-1);
  if (cliVersion !== void 0) warn?.(`no reject-text entry for Claude Code ${cliVersion}; using ${newest} (D40)`);
  return table[newest];
}
function rejectMessage(c, isSubagent, feedback) {
  const fb = feedback?.trim();
  if (isSubagent) {
    return { message: fb ? c.subagentFeedbackPrefix + fb : c.subagentNoFeedback, interrupt: false };
  }
  return fb ? { message: c.mainFeedbackPrefix + fb, interrupt: false } : { message: c.mainNoFeedback, interrupt: true };
}
function planChoices(ctx) {
  const c = typeof ctx === "boolean" ? { canBypass: ctx } : ctx;
  const acceptEdits = { id: "accept-edits", label: TUI_TEXT.planAcceptEdits, mode: "acceptEdits" };
  const out = [];
  if (c.canBypass)
    out.push({
      id: "bypass",
      label: `${TUI_TEXT.switchTo}${MODE_DESCRIPTIONS.bypassPermissions}${TUI_TEXT.forThisSession}`,
      mode: "bypassPermissions"
    });
  else if (c.prePlanMode === "auto") out.push({ id: "yes", label: TUI_TEXT.planUseAuto, mode: "auto" });
  else out.push(acceptEdits);
  out.push({ id: "default", label: TUI_TEXT.planManual, mode: "default" });
  if (out[0] !== acceptEdits) out.push(acceptEdits);
  return out;
}
var PLAN_MODES = {
  "accept-edits": "acceptEdits",
  default: "default",
  bypass: "bypassPermissions"
};
function destinationLabel(d) {
  switch (d) {
    case "localSettings":
      return "project local settings (.claude/settings.local.json)";
    case "projectSettings":
      return "project settings (.claude/settings.json)";
    case "userSettings":
      return "user settings (~/.claude/settings.json)";
    case "session":
      return "this session only";
    case "cliArg":
      return "this session only (command-line rules)";
    default:
      return d;
  }
}
function ruleText(r) {
  return r.ruleContent === void 0 ? r.toolName : `${r.toolName}(${r.ruleContent})`;
}
function rulesOf(s) {
  return "rules" in s && Array.isArray(s.rules) ? s.rules.map(ruleText) : [];
}
function dirsOf(s) {
  return "directories" in s && Array.isArray(s.directories) ? s.directories.map(String) : [];
}
function suggestionEffects(s) {
  const where = destinationLabel(s.destination);
  const at = where ? ` (${where})` : "";
  switch (s.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules": {
      const verb = s.type === "addRules" ? "add" : s.type === "replaceRules" ? "replace with" : "remove";
      return rulesOf(s).map((r) => `${verb} ${s.behavior} rule ${r}${at}`);
    }
    case "addDirectories":
    case "removeDirectories":
      return dirsOf(s).map((d) => `${s.type === "addDirectories" ? "allow" : "remove"} directory ${d}${at}`);
    case "setMode":
      return [`switch to ${MODE_DESCRIPTIONS[s.mode] ?? s.mode}${at}`];
    default:
      return [];
  }
}
function sessionSuffix(dest) {
  return dest === "session" || dest === "cliArg" ? TUI_TEXT.forThisSession : "";
}
function alwaysOptions(suggestions) {
  const out = [];
  const grouped = [];
  const singles = [];
  for (const s of suggestions) {
    if (s.type === "addDirectories" || s.type === "addRules" && s.behavior === "allow") grouped.push(s);
    else singles.push(s);
  }
  const make = (applies, label) => {
    const dests = [...new Set(applies.map((s) => destinationLabel(s.destination)).filter((d) => d !== void 0))];
    const option = {
      id: `always-${out.length}`,
      kind: "allow-always",
      label,
      effects: applies.flatMap(suggestionEffects)
    };
    if (dests.length > 0) option.destination = dests.join("; ");
    out.push({ option, applies });
  };
  if (grouped.length > 0) {
    const parts = [];
    const rules = grouped.filter((s) => s.type === "addRules");
    const ruleNames = [...new Set(rules.flatMap(rulesOf))];
    if (ruleNames.length > 0)
      parts.push(`${TUI_TEXT.dontAskAgainFor}${ruleNames.join(", ")}${sessionSuffix(rules[0]?.destination)}`);
    const dirSugs = grouped.filter((s) => s.type === "addDirectories");
    const dirs = [...new Set(dirSugs.flatMap(dirsOf))];
    if (dirs.length > 0)
      parts.push(`${TUI_TEXT.allowAccessTo}${dirs.join(", ")}${sessionSuffix(dirSugs[0]?.destination)}`);
    if (parts.length > 0) {
      make(grouped, parts.join("; "));
      const only = rules.length === 1 && rulesOf(rules[0]).length === 1 ? rules[0] : void 0;
      const rule = only && "rules" in only ? only.rules[0] : void 0;
      if (rule && rule.toolName === "Bash" && typeof rule.ruleContent === "string")
        out[out.length - 1].option.editableRule = {
          toolName: "Bash",
          ruleContent: rule.ruleContent,
          placeholder: TUI_TEXT.prefixPlaceholder
        };
    }
  }
  for (const s of singles) {
    if (s.type === "setMode") {
      make([s], `${TUI_TEXT.switchTo}${MODE_DESCRIPTIONS[s.mode] ?? s.mode}${sessionSuffix(s.destination)}`);
      continue;
    }
    const effects = suggestionEffects(s);
    if (effects.length > 0) make([s], `Yes, and ${effects.join("; ")}`);
  }
  return out;
}
function editedRule(picked, ruleContent) {
  const edit = picked.option.editableRule;
  const text = ruleContent?.trim();
  if (!edit || !text || text === edit.ruleContent) return picked.applies;
  return picked.applies.map(
    (s) => s.type === "addRules" && s.rules.length === 1 && s.rules[0].toolName === edit.toolName ? { ...s, rules: [{ toolName: edit.toolName, ruleContent: text }] } : s
  );
}
function readQuestions(input) {
  const list = Array.isArray(input.questions) ? input.questions : [];
  const out = [];
  for (const q of list) {
    if (typeof q !== "object" || q === null) continue;
    const r = q;
    if (typeof r.question !== "string") continue;
    const options = [];
    for (const o of Array.isArray(r.options) ? r.options : []) {
      if (typeof o !== "object" || o === null) continue;
      const opt = o;
      if (typeof opt.label !== "string") continue;
      const item2 = { label: opt.label };
      if (typeof opt.description === "string" && opt.description !== "") item2.description = opt.description;
      if (typeof opt.preview === "string" && opt.preview !== "") item2.preview = opt.preview;
      options.push(item2);
    }
    const item = {
      question: r.question,
      multiSelect: r.multiSelect === true,
      options,
      allowsOther: true
    };
    if (typeof r.header === "string" && r.header !== "") item.header = r.header;
    out.push(item);
  }
  return out;
}
function questionUpdate(questions, answer) {
  const answers = {};
  const annotations = {};
  for (const q of questions) {
    const raw = answer.answers[q.question];
    const value = Array.isArray(raw) ? raw.map(String).filter((s) => s !== "").join(", ") : raw;
    if (typeof value === "string" && value !== "") answers[q.question] = value;
    const note = {};
    if (!q.multiSelect && typeof value === "string") {
      const picked = q.options.find((o) => o.label === value);
      if (picked?.preview !== void 0) note.preview = picked.preview;
    }
    const notes = answer.notes?.[q.question]?.trim();
    if (notes) note.notes = notes;
    if (note.preview !== void 0 || note.notes !== void 0) annotations[q.question] = note;
  }
  return Object.keys(annotations).length > 0 ? { answers, annotations } : { answers };
}
function clarifyMessage(c, questions, answer) {
  const { answers } = questionUpdate(questions, answer);
  const blocks = questions.map((q) => {
    const lines = [`- "${q.question}"`];
    const a = answers[q.question];
    lines.push(a !== void 0 ? `  Answer: ${a}` : c.clarifyNoAnswer);
    const notes = answer.notes?.[q.question]?.trim();
    if (notes && !q.multiSelect && q.options.some((o) => o.preview !== void 0)) lines.push(`  User notes: ${notes}`);
    return lines.join("\n");
  });
  return c.clarifyIntro + blocks.join("\n");
}
function createCanUseTool(o) {
  return async (toolName, input, opts) => {
    const agentId = opts.agentID;
    const agent = agentId ? { kind: "child", id: agentId } : { kind: "main" };
    const agentLabel = agentId ? o.agentLabel?.(agentId) : void 0;
    const callId = opts.toolUseID;
    const id = opts.requestId ?? o.newId();
    const isChild = agent.kind === "child";
    const constants2 = () => rejectConstantsFor(o.cliVersion(), o.warn);
    if (toolName === "AskUserQuestion") {
      const questions = readQuestions(input);
      const req2 = {
        id,
        agent,
        questions,
        previewFormat: o.previewFormat?.() ?? "markdown",
        otherLabel: TUI_TEXT.questionOther,
        chatLabel: TUI_TEXT.questionChat
      };
      if (callId !== void 0) req2.callId = callId;
      if (agentLabel !== void 0) req2.agentLabel = agentLabel;
      const answer2 = await o.handler.question(req2, opts.signal);
      if (answer2 === null) return deny(rejectMessage(constants2(), isChild, void 0));
      if (answer2.chat === true) return { behavior: "deny", message: clarifyMessage(constants2(), questions, answer2) };
      return { behavior: "allow", updatedInput: { ...input, ...questionUpdate(questions, answer2) } };
    }
    if (toolName === "ExitPlanMode") {
      const plan = typeof input.plan === "string" ? input.plan : "";
      const req2 = {
        id,
        agent,
        plan,
        choices: planChoices({ canBypass: o.canBypass(), prePlanMode: o.prePlanMode?.() }),
        keepPlanning: { label: TUI_TEXT.planKeepPlanning, feedbackPlaceholder: TUI_TEXT.planKeepPlanningPlaceholder }
      };
      if (callId !== void 0) req2.callId = callId;
      if (agentLabel !== void 0) req2.agentLabel = agentLabel;
      if (typeof input.planFilePath === "string") req2.planFilePath = input.planFilePath;
      const answer2 = await o.handler.plan(req2, opts.signal);
      if (answer2.kind === "keep-planning") return deny(rejectMessage(constants2(), isChild, answer2.feedback));
      if (!req2.choices.some((c) => c.id === answer2.choiceId))
        throw new Error(`unknown plan choice: ${answer2.choiceId}`);
      const mode = PLAN_MODES[answer2.choiceId];
      if (mode === void 0) return { behavior: "allow", updatedInput: input };
      return {
        behavior: "allow",
        updatedInput: input,
        // Session only: any other destination is a settings file (Round 3b).
        updatedPermissions: [{ type: "setMode", mode, destination: "session" }]
      };
    }
    const suggestions = opts.suppressAlwaysAllowRule ? [] : opts.suggestions ?? [];
    const always = alwaysOptions(suggestions);
    const options = [
      { id: "allow-once", kind: "allow-once", label: TUI_TEXT.yes },
      ...always.map((a) => a.option),
      {
        id: "reject",
        kind: "reject-once",
        label: TUI_TEXT.no,
        acceptsFeedback: true,
        feedbackPlaceholder: TUI_TEXT.rejectPlaceholder
      }
    ];
    const req = { id, agent, toolName, input, options };
    if (agentLabel !== void 0) req.agentLabel = agentLabel;
    if (callId !== void 0) req.callId = callId;
    if (opts.displayName !== void 0) req.displayName = opts.displayName;
    if (opts.title !== void 0) req.title = opts.title;
    if (opts.description !== void 0) req.description = opts.description;
    if (opts.blockedPath !== void 0) req.blockedPath = opts.blockedPath;
    if (opts.decisionReason !== void 0) req.reason = opts.decisionReason;
    if (opts.defaultToNo === true) req.defaultToNo = true;
    if (opts.mcpServer !== void 0) req.mcpServer = { name: opts.mcpServer.name, source: opts.mcpServer.source };
    const answer = await o.handler.permission(req, opts.signal);
    if (answer.optionId === "allow-once") return { behavior: "allow", updatedInput: input };
    const picked = always.find((a) => a.option.id === answer.optionId);
    if (picked)
      return { behavior: "allow", updatedInput: input, updatedPermissions: editedRule(picked, answer.ruleContent) };
    if (answer.optionId !== "reject") throw new Error(`unknown permission choice: ${answer.optionId}`);
    return deny(rejectMessage(constants2(), isChild, answer.feedback));
  };
  function deny(r) {
    if (!r.interrupt) return { behavior: "deny", message: r.message };
    o.onInterruptingDeny?.();
    return { behavior: "deny", message: r.message, interrupt: true };
  }
}
function createOnElicitation(o) {
  return async (request, opts) => {
    const req = {
      id: opts.requestId ?? o.newId(),
      serverName: request.serverName,
      message: request.message
    };
    const agent = o.elicitationAgent?.(request.serverName);
    if (agent !== void 0) {
      req.agent = agent;
      const label = agent.kind === "child" ? o.agentLabel?.(agent.id) : void 0;
      if (label !== void 0) req.agentLabel = label;
    }
    if (request.mode !== void 0) req.mode = request.mode;
    if (request.url !== void 0) req.url = request.url;
    if (request.elicitationId !== void 0) req.elicitationId = request.elicitationId;
    if (request.requestedSchema !== void 0) req.requestedSchema = request.requestedSchema;
    if (request.title !== void 0) req.title = request.title;
    if (request.displayName !== void 0) req.displayName = request.displayName;
    if (request.description !== void 0) req.description = request.description;
    const eid = request.mode === "url" ? request.elicitationId : void 0;
    if (eid !== void 0) o.rememberElicitation?.(eid, req.id);
    let answer;
    try {
      answer = await o.handler.elicitation(req, opts.signal);
    } catch (e) {
      if (eid !== void 0) o.forgetElicitation?.(eid);
      throw e;
    }
    if (eid !== void 0 && answer.action !== "accept") o.forgetElicitation?.(eid);
    if (answer.action === "accept")
      return answer.content !== void 0 ? { action: "accept", content: answer.content } : { action: "accept" };
    return { action: answer.action };
  };
}

// packages/backend-claude/src/sdk.ts
var loaded;
function loadSdk(importer = () => import("@anthropic-ai/claude-agent-sdk"), target = process.env) {
  if (loaded) return loaded;
  const p = withProcessEnvRestored(SDK_PROCESS_ENV_WRITES, importer, target);
  loaded = p;
  p.catch(() => {
    if (loaded === p) loaded = void 0;
  });
  return p;
}

// packages/backend-claude/src/session.ts
import { randomUUID } from "node:crypto";

// packages/core/src/sent-inputs.ts
var SentInputTracker = class {
  #pending = /* @__PURE__ */ new Set();
  #consumed = /* @__PURE__ */ new Set();
  /** True once the agent has sent any per-input consumption signal in this process. */
  #sawSignal = false;
  /** Record a sent input. A repeat of a known id is ignored. */
  sent(id) {
    if (this.#consumed.has(id)) return;
    this.#pending.add(id);
  }
  /** Mark one input consumed. Returns true only the first time an id that was pending is consumed. */
  consume(id) {
    this.#sawSignal = true;
    if (!this.#pending.delete(id)) return false;
    this.#consumed.add(id);
    return true;
  }
  /** Inputs the agent dropped (interrupt with cancelQueued, D25). Returns the ids that were pending. */
  cancel(ids) {
    const out = [];
    for (const id of ids) if (this.#pending.delete(id)) out.push(id);
    return out;
  }
  /**
   * Fallback (D27): if the agent never sent a consumption signal in this process, a turn end
   * with nothing queued marks every pending input consumed. Returns the ids it consumed.
   */
  consumeAllIfNoSignal() {
    if (this.#sawSignal) return [];
    const ids = [...this.#pending];
    for (const id of ids) {
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
    return ids;
  }
  /** True for an id we sent, pending or consumed. */
  wasSent(id) {
    return this.#pending.has(id) || this.#consumed.has(id);
  }
  isPending(id) {
    return this.#pending.has(id);
  }
  get pendingCount() {
    return this.#pending.size;
  }
  get pendingIds() {
    return [...this.#pending];
  }
};

// packages/core/src/async-queue.ts
var AsyncQueue = class {
  #items = [];
  #waiters = [];
  #ended = false;
  #iterated = false;
  push(item) {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }
  /** No more items. Pending reads finish once the buffer drains. */
  end() {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: void 0, done: true });
  }
  get ended() {
    return this.#ended;
  }
  [Symbol.asyncIterator]() {
    if (this.#iterated) throw new Error("AsyncQueue supports one consumer only");
    this.#iterated = true;
    return {
      next: () => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#ended) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.end();
        this.#items.length = 0;
        return Promise.resolve({ value: void 0, done: true });
      }
    };
  }
};

// packages/core/src/side-questions.ts
var SIDE_HISTORY_LIMIT = 20;
var SideQuestionHistory = class {
  #limit;
  #exchanges = [];
  constructor(limit = SIDE_HISTORY_LIMIT) {
    this.#limit = Math.max(0, Math.floor(limit));
  }
  /** Oldest first. A copy: pass it to `askSideQuestion` as is. */
  list() {
    return this.#exchanges.map((e) => ({ ...e }));
  }
  get size() {
    return this.#exchanges.length;
  }
  /**
   * Record one answered question. A synthetic answer (the agent's own "no answer" text) or a
   * cancelled one (`null`) is not kept. Returns whether it was kept.
   */
  record(question, answer) {
    if (answer === null || answer.synthetic) return false;
    const e = { question, answer: answer.text };
    if (answer.fallback !== void 0 && answer.fallback.content !== "") e.fallbackNotice = answer.fallback.content;
    this.#exchanges = [...this.#exchanges, e].slice(-this.#limit);
    if (this.#limit === 0) this.#exchanges = [];
    return true;
  }
  /** D70: a conversation reset (`/clear`) starts a new history. */
  clear() {
    this.#exchanges = [];
  }
};

// packages/core/src/modes.ts
function offeredPermissionModes(modes, options, current2 = []) {
  return modes.filter(
    (m) => m.requiresOption === void 0 || options?.[m.requiresOption] === true || current2.includes(m.id)
  );
}

// packages/core/src/workflow.ts
function isSettledWorkflowAgent(state) {
  return state === "done" || state === "error" || state === "stopped";
}
function mergeAgent(prev, next) {
  const prevAttempt = prev.attempt ?? 1;
  const nextAttempt = next.attempt ?? prevAttempt;
  if (nextAttempt < prevAttempt) return prev;
  if (nextAttempt === prevAttempt && isSettledWorkflowAgent(prev.state) && !isSettledWorkflowAgent(next.state)) {
    const merged = { ...prev };
    for (const key of ["agentId", "tokens", "toolCalls", "durationMs", "resultPreview"])
      if (next[key] !== void 0 && merged[key] === void 0)
        merged[key] = next[key];
    return merged;
  }
  if (next.agentId === void 0 && prev.agentId !== void 0 && nextAttempt === prevAttempt)
    return { ...next, agentId: prev.agentId };
  return next;
}
function mergeWorkflowSnapshot(prev, next) {
  if (prev === void 0)
    return { phases: [...next.phases], agents: [...next.agents].sort((a, b) => a.index - b.index) };
  const byIndex = /* @__PURE__ */ new Map();
  for (const a of prev.agents) byIndex.set(a.index, a);
  for (const a of next.agents) {
    const old = byIndex.get(a.index);
    byIndex.set(a.index, old === void 0 ? a : mergeAgent(old, a));
  }
  return {
    phases: next.phases.length > 0 ? [...next.phases] : [...prev.phases],
    agents: [...byIndex.values()].sort((a, b) => a.index - b.index)
  };
}
function settleWorkflowSnapshot(snap, stopReason) {
  return {
    phases: snap.phases,
    agents: snap.agents.map((a) => {
      if (isSettledWorkflowAgent(a.state)) return a;
      let state = "stopped";
      if (a.state === "running" && stopReason === "completed") state = "done";
      else if (a.state === "running" && stopReason === "error") state = "error";
      return { ...a, state };
    })
  };
}

// packages/core/src/usage.ts
function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function addTokens(a, b) {
  const out = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  };
  if (a.reasoning !== void 0 || b.reasoning !== void 0) out.reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return out;
}
function subtractTokens(a, b) {
  const out = {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite)
  };
  if (a.reasoning !== void 0) out.reasoning = Math.max(0, a.reasoning - (b.reasoning ?? 0));
  return out;
}
function totalTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}
function isZeroTokens(t) {
  return totalTokens(t) === 0;
}
function contextTokens(t) {
  return t.input + t.cacheRead + t.cacheWrite;
}
var BASIS_RANK = { list: 0, managed: 1, unknown: 2 };
function worstCostBasis(bases) {
  let worst = "list";
  for (const b of bases) if (b !== void 0 && BASIS_RANK[b] > BASIS_RANK[worst]) worst = b;
  return worst;
}

// packages/core/src/plugin-api.ts
var RAW_AGENT_SERVICE = "rawAgent";
var RAW_AGENT_API_VERSION = 1;
var PLUGIN_SOURCE_KIND = "raw-agent-plugin";
var PLUGIN_TEXT_MAX = 1e5;
var GRANT_LABEL_MAX = 80;
var RawAgentServiceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  name = "RawAgentServiceError";
};
function isRawAgentServiceError(e) {
  return e instanceof Error && e.name === "RawAgentServiceError" && typeof e.code === "string";
}
var put = (o, k, v) => {
  if (v !== void 0) o[k] = v;
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
function checkGrantLabel(label) {
  if (typeof label !== "string") return { ok: false, error: "the label must be text" };
  const l = label.replace(/\s+/g, " ").trim();
  if (l === "") return { ok: false, error: "Name the plugin this grant is for." };
  if (l.length > GRANT_LABEL_MAX) return { ok: false, error: `The name is longer than ${GRANT_LABEL_MAX} characters.` };
  return { ok: true, label: l };
}

// packages/backend-claude/src/mapper.ts
import { isDeepStrictEqual } from "node:util";

// packages/backend-claude/src/wire.ts
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v) {
  return typeof v === "string" ? v : void 0;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

// packages/backend-claude/src/children.ts
var MAIN = Object.freeze({ kind: "main" });
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
var SEND_MESSAGE_TOOL = "SendMessage";
var CALL_LIMIT = 512;
function inputOf(b) {
  const input = b.input;
  return isObject(input) ? input : {};
}
function agentMessageSender(prompt) {
  const m = /<agent-message\s+from="([^"]*)"/.exec(prompt);
  return m?.[1];
}
function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return void 0;
  const texts = content.filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
  return texts.length > 0 ? texts.join("\n") : void 0;
}
function isSystemReminder(text) {
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}
function statusOf(s) {
  return s === "completed" ? "completed" : s === "stopped" || s === "killed" ? "stopped" : "failed";
}
var ChildAgents = class {
  #debug;
  /** By child id (= task id), and by spawning call under `call:<id>`. */
  #ids = /* @__PURE__ */ new Map();
  #calls = /* @__PURE__ */ new Map();
  #seen = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.#debug = options.debug ?? (() => {
    });
  }
  /** A display label for an agent id (D77: an ask names its subagent). */
  label(agentId) {
    return this.#ids.get(agentId)?.label;
  }
  /** Whether a task id is a child agent this mapper knows (its progress is the child's). */
  isAgentTask(taskId) {
    return this.#ids.get(taskId)?.taskId === taskId;
  }
  /** The sender name in a `team-message`: 'main' for the main agent. */
  senderName(ref) {
    if (ref.kind === "main") return "main";
    const a = this.#ids.get(ref.id);
    return a?.name ?? a?.label ?? ref.id;
  }
  /** Remember the spawning calls in a frame's blocks, so `task_started` can name the child. */
  noteCalls(content, owner) {
    for (const b of content) {
      if (b.type !== "tool_use") continue;
      const id = str(b.id);
      const name2 = str(b.name);
      if (id === void 0 || name2 === void 0 || !AGENT_TOOLS.has(name2)) continue;
      this.#calls.delete(id);
      this.#calls.set(id, { owner, input: inputOf(b) });
      while (this.#calls.size > CALL_LIMIT) {
        const oldest = this.#calls.keys().next();
        if (oldest.done) break;
        this.#calls.delete(oldest.value);
      }
    }
  }
  /**
   * `task_started` of a `local_agent` / `remote_agent` task. Emits `agent-start` for a new child or
   * a woken one. Returns the child's ref, for the background task's `task-start`.
   */
  taskStarted(msg, at, out) {
    const taskId = str(msg.task_id);
    if (taskId === void 0) return void 0;
    const callId = str(msg.tool_use_id);
    const prompt = str(msg.prompt) ?? "";
    const background = msg.is_backgrounded === true;
    let agent = this.#ids.get(taskId);
    if (agent === void 0 && callId !== void 0) {
      const byCall = this.#ids.get(`call:${callId}`);
      if (byCall !== void 0 && byCall.taskId === void 0) agent = byCall;
    }
    if (agent !== void 0) {
      this.#ids.set(taskId, agent);
      agent.taskId = taskId;
      if (agent.running) {
        if (background) agent.background = true;
        return agent.ref;
      }
      agent.running = true;
      agent.background = background;
      delete agent.stepId;
      agent.pendingPrompt = prompt;
      const e = this.#startEvent(agent, prompt, at);
      e.resumed = true;
      const from = agentMessageSender(prompt);
      if (from !== void 0) e.wokenBy = from;
      out.push(e);
      return agent.ref;
    }
    const call = callId === void 0 ? void 0 : this.#calls.get(callId);
    const input = call?.input ?? {};
    const parentTask = str(msg.parent_task_id);
    const parentAgent = parentTask === void 0 ? void 0 : this.#ids.get(parentTask);
    const created = this.#create(taskId, {
      parent: parentAgent?.ref ?? call?.owner ?? MAIN,
      parentCallId: callId,
      input,
      description: str(msg.description),
      agentType: str(msg.subagent_type),
      background,
      depth: num(msg.spawn_depth),
      prompt: prompt !== "" ? prompt : str(input.prompt) ?? ""
    });
    created.taskId = taskId;
    out.push(this.#startEvent(created, created.pendingPrompt ?? "", at));
    return created.ref;
  }
  /** `task_notification` of a child agent task. */
  taskEnded(taskId, status, summary, out) {
    const agent = this.#ids.get(taskId);
    if (agent === void 0 || !agent.running) return;
    this.#end(agent, statusOf(status), summary, out);
  }
  /**
   * The main turn ended. A foreground child cannot outlive the main turn that runs it; after an
   * interrupt or an error the CLI may send no notification for it (**inferred**), so it ends here.
   */
  mainTurnEnded(outcome, out) {
    if (outcome === "completed") return;
    for (const agent of this.#unique())
      if (agent.running && !agent.background)
        this.#end(agent, outcome === "interrupted" ? "stopped" : "failed", void 0, out);
  }
  /** The CLI ended: every running child ends with it (D74). */
  exit(out, reason) {
    for (const agent of this.#unique()) if (agent.running) this.#end(agent, "failed", reason, out);
  }
  /** A child `assistant` frame (D68: one CLI message → one `step-message`, no usage). */
  assistant(msg, at, out) {
    const uuid = str(msg.uuid);
    if (uuid !== void 0) {
      if (this.#seen.has(uuid)) return;
      this.#seen.add(uuid);
    }
    const message = isObject(msg.message) ? msg.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const agent = this.#resolve(msg, at, out);
    if (agent === void 0) return;
    this.noteCalls(content, agent.ref);
    const blocks = [];
    for (const raw of content) {
      const b = convertBlock(raw);
      if (b === void 0) continue;
      if (b.type === "reasoning" && b.text === "") continue;
      if (b.type === "tool-call" && agent.advertised.has(b.id)) {
        this.#debug("re-sent child tool_use block", b);
        continue;
      }
      blocks.push(b);
    }
    if (blocks.length === 0) return;
    const stepId = str(message.id) ?? uuid ?? `${agent.ref.id}-${at}`;
    if (agent.stepId !== stepId) {
      agent.stepId = stepId;
      out.push({ type: "step-start", agent: agent.ref, stepId, at });
    }
    const e = {
      type: "step-message",
      agent: agent.ref,
      stepId,
      blocks,
      final: false
    };
    const model = canonicalModel(str(message.model));
    if (model !== void 0 && model !== "<synthetic>") e.model = model;
    if (uuid !== void 0) e.lastChainId = uuid;
    out.push(e);
    for (const b of blocks) if (b.type === "tool-call") agent.advertised.add(b.id);
    this.#flush(agent, out);
    this.teamMessages(blocks, agent.ref, out);
  }
  /** A child `user` frame: tool results, or text the CLI delivered to the child. */
  user(msg, at, out) {
    const uuid = str(msg.uuid);
    if (uuid !== void 0) {
      if (this.#seen.has(uuid)) return;
      this.#seen.add(uuid);
    }
    const message = isObject(msg.message) ? msg.message : {};
    const agent = this.#resolve(msg, at, out);
    if (agent === void 0) return;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObject(b) || b.type !== "tool_result") continue;
        const callId = str(b.tool_use_id);
        if (callId === void 0) continue;
        const e = {
          type: "tool-result",
          agent: agent.ref,
          callId,
          isError: b.is_error === true,
          content: convertToolResultContent(b.content)
        };
        if (uuid !== void 0) e.chainId = uuid;
        if (agent.advertised.has(callId)) out.push(e);
        else agent.buffered.push(e);
      }
    }
    const text = userText(content);
    if (text === void 0 || text.trim() === "" || isSystemReminder(text)) return;
    if (agent.pendingPrompt !== void 0 && text.trim() === agent.pendingPrompt.trim()) {
      delete agent.pendingPrompt;
      return;
    }
    out.push({ type: "agent-input", ref: agent.ref, text, at });
  }
  /** D50: each `SendMessage` call in a written step-message is one team message. */
  teamMessages(blocks, sender, out) {
    for (const b of blocks) {
      if (b.type !== "tool-call" || b.name !== SEND_MESSAGE_TOOL) continue;
      let input = {};
      try {
        const parsed = JSON.parse(b.arguments);
        if (isObject(parsed)) input = parsed;
      } catch {
        continue;
      }
      const to = str(input.to) ?? str(input.recipient);
      const body = input.message ?? input.content;
      if (to === void 0 || body === void 0) continue;
      const e = {
        type: "team-message",
        from: this.senderName(sender),
        to,
        text: typeof body === "string" ? body : JSON.stringify(body),
        agent: sender,
        callId: b.id
      };
      const summary = str(input.summary);
      if (summary !== void 0) e.summary = summary;
      out.push(e);
    }
  }
  /**
   * Adopt a child known from elsewhere (a transcript read, D49), so its frames map without an
   * `agent-start`. The pending prompt is not set: its first user text is an `agent-input`.
   */
  adopt(id, label) {
    const agent = this.#create(id, { parent: MAIN, input: {}, background: false, prompt: "" });
    agent.label = label;
    delete agent.pendingPrompt;
  }
  // ---- internals ----
  #unique() {
    return [...new Set(this.#ids.values())];
  }
  #create(id, o) {
    const name2 = str(o.input.name);
    const team = str(o.input.team_name);
    const agentType = o.agentType ?? str(o.input.subagent_type);
    const agent = {
      ref: { kind: "child", id },
      parent: o.parent,
      label: name2 ?? o.description ?? str(o.input.description) ?? agentType ?? "subagent",
      // D50: a teammate is a child started with a name or a team (it is addressable by name).
      role: name2 !== void 0 || team !== void 0 ? "teammate" : "subagent",
      background: o.background,
      running: true,
      advertised: /* @__PURE__ */ new Set(),
      buffered: []
    };
    if (o.parentCallId !== void 0) agent.parentCallId = o.parentCallId;
    if (name2 !== void 0) agent.name = name2;
    if (team !== void 0) agent.team = team;
    if (agentType !== void 0) agent.agentType = agentType;
    if (o.depth !== void 0) agent.depth = o.depth;
    else if (o.parent.kind === "main") agent.depth = 1;
    else {
      const parentDepth = this.#ids.get(o.parent.id)?.depth;
      if (parentDepth !== void 0) agent.depth = parentDepth + 1;
    }
    if (o.prompt !== "") agent.pendingPrompt = o.prompt;
    this.#ids.set(id, agent);
    if (o.parentCallId !== void 0) this.#ids.set(`call:${o.parentCallId}`, agent);
    return agent;
  }
  #startEvent(agent, prompt, at) {
    const e = {
      type: "agent-start",
      ref: agent.ref,
      parent: agent.parent,
      label: agent.label,
      role: agent.role,
      background: agent.background,
      taskPrompt: prompt,
      at
    };
    if (agent.parentCallId !== void 0) e.parentCallId = agent.parentCallId;
    if (agent.taskId !== void 0) e.taskId = agent.taskId;
    if (agent.agentType !== void 0) e.agentType = agent.agentType;
    if (agent.name !== void 0) e.name = agent.name;
    if (agent.team !== void 0) e.team = agent.team;
    if (agent.depth !== void 0) e.depth = agent.depth;
    return e;
  }
  /** The child a frame belongs to; an unknown one is announced from its spawning call. */
  #resolve(msg, at, out) {
    const agentId = str(msg.agent_id);
    const callId = str(msg.parent_tool_use_id);
    const known = (agentId !== void 0 ? this.#ids.get(agentId) : void 0) ?? (callId !== void 0 ? this.#ids.get(`call:${callId}`) : void 0);
    if (known !== void 0) {
      if (!known.running) {
        this.#debug("frame of a finished child dropped", msg);
        return void 0;
      }
      if (agentId !== void 0 && !this.#ids.has(agentId)) this.#ids.set(agentId, known);
      return known;
    }
    if (callId === void 0) return void 0;
    const call = this.#calls.get(callId);
    const input = call?.input ?? {};
    const agent = this.#create(agentId ?? `call:${callId}`, {
      parent: call?.owner ?? MAIN,
      parentCallId: callId,
      input,
      description: str(msg.task_description),
      agentType: str(msg.subagent_type),
      background: input.run_in_background === true,
      prompt: str(input.prompt) ?? ""
    });
    out.push(this.#startEvent(agent, agent.pendingPrompt ?? "", at));
    return agent;
  }
  #flush(agent, out) {
    const keep2 = [];
    for (const r of agent.buffered) (agent.advertised.has(r.callId) ? out : keep2).push(r);
    agent.buffered = keep2;
  }
  #end(agent, status, summary, out) {
    agent.running = false;
    delete agent.stepId;
    delete agent.pendingPrompt;
    if (agent.buffered.length > 0) {
      this.#debug("dropping child tool results with no advertised call", agent.buffered);
      agent.buffered = [];
    }
    const e = { type: "agent-end", ref: agent.ref, status };
    if (summary !== void 0) e.summary = summary;
    out.push(e);
  }
};

// packages/backend-claude/src/workflow-tail.ts
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import * as path4 from "node:path";
var MAX_READ_BYTES = 512 * 1024;
var MAX_LINE_BYTES = 8 * 1024 * 1024;
var AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
var nodeTailFs = {
  realpath(p) {
    try {
      return realpathSync(p);
    } catch {
      return void 0;
    }
  },
  fileSize(p) {
    try {
      const st = statSync(p);
      return st.isFile() ? st.size : void 0;
    } catch {
      return void 0;
    }
  },
  readAt(p, offset, length) {
    let fd;
    try {
      fd = openSync(p, "r");
      if (!fstatSync(fd).isFile()) return void 0;
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } catch {
      return void 0;
    } finally {
      if (fd !== void 0) closeSync(fd);
    }
  }
};
function insideFolder(dir, projectsDir, fs) {
  const real = fs.realpath(dir);
  const root = fs.realpath(projectsDir);
  if (real === void 0 || root === void 0) return false;
  const rel = path4.relative(root, real);
  return rel !== "" && !rel.startsWith("..") && !path4.isAbsolute(rel);
}
var TranscriptTail = class {
  dir;
  #fs;
  #files = /* @__PURE__ */ new Map();
  constructor(dir, fs = nodeTailFs) {
    this.dir = dir;
    this.#fs = fs;
  }
  /** The agent's file path, or undefined for an id that is not a plain token. */
  agentFile(agentId) {
    if (!AGENT_ID_RE.test(agentId)) return void 0;
    return path4.join(this.dir, `agent-${agentId}.jsonl`);
  }
  /** New complete lines of one agent's file, parsed; [] when nothing new. Reads at most one chunk. */
  read(agentId) {
    const file = this.agentFile(agentId);
    if (file === void 0) return [];
    const size = this.#fs.fileSize(file);
    if (size === void 0) return [];
    let st = this.#files.get(agentId);
    if (st === void 0) {
      st = { offset: 0, carry: Buffer.alloc(0), skipping: false };
      this.#files.set(agentId, st);
    }
    if (size < st.offset) {
      st.offset = 0;
      st.carry = Buffer.alloc(0);
      st.skipping = false;
    }
    if (size === st.offset) return [];
    const chunk = this.#fs.readAt(file, st.offset, Math.min(MAX_READ_BYTES, size - st.offset));
    if (chunk === void 0 || chunk.length === 0) return [];
    st.offset += chunk.length;
    const out = [];
    let start = 0;
    for (; ; ) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (st.skipping) {
        st.skipping = false;
        st.carry = Buffer.alloc(0);
        continue;
      }
      const line = st.carry.length > 0 ? Buffer.concat([st.carry, piece]) : piece;
      st.carry = Buffer.alloc(0);
      const text = line.toString("utf8").trim();
      if (text === "") continue;
      try {
        out.push(JSON.parse(text));
      } catch {
      }
    }
    if (start < chunk.length && !st.skipping) {
      const rest = chunk.subarray(start);
      if (st.carry.length + rest.length > MAX_LINE_BYTES) {
        st.skipping = true;
        st.carry = Buffer.alloc(0);
      } else st.carry = Buffer.concat([st.carry, rest]);
    }
    return out;
  }
  /** Read until the file is caught up (at most `maxChunks` reads). */
  drain(agentId, maxChunks = 64) {
    const out = [];
    for (let i = 0; i < maxChunks; i++) {
      const lines = this.read(agentId);
      const file = this.agentFile(agentId);
      const st = this.#files.get(agentId);
      out.push(...lines);
      if (file === void 0 || st === void 0) break;
      const size = this.#fs.fileSize(file);
      if (size === void 0 || size <= st.offset) break;
    }
    return out;
  }
};

// packages/backend-claude/src/workflows.ts
var MAIN2 = Object.freeze({ kind: "main" });
var WORKFLOW_POLL_MS = 500;
var ANNOUNCE_AFTER_MS = 1500;
var SETTLE_GRACE_MS = 1e3;
var FRAME_COMPUTED_TASK = "[Workflow harness \u2014 computed task]";
function parseWorkflowProgress(raw) {
  if (!Array.isArray(raw)) return void 0;
  const snap = { phases: [], agents: [] };
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (item.type === "workflow_phase") {
      const index = num(item.index);
      if (index !== void 0) snap.phases.push({ index, title: str(item.title) ?? `Phase ${index}` });
    } else if (item.type === "workflow_agent") {
      const a = parseAgent(item);
      if (a !== void 0) snap.agents.push(a);
    }
  }
  return snap;
}
var WORKFLOW_STOPPED_ERROR = "Stopped because the workflow was stopped";
function workflowAgentState(raw, started) {
  switch (raw) {
    case "start":
      return started ? "running" : "queued";
    case "queued":
      return "queued";
    case "progress":
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "running";
  }
}
function parseAgent(item) {
  const index = num(item.index);
  if (index === void 0) return void 0;
  const raw = str(item.state);
  const agentId = str(item.agentId);
  const startedAt = num(item.startedAt);
  let state = workflowAgentState(raw, startedAt !== void 0 || agentId !== void 0);
  if (state === "error" && str(item.error)?.startsWith(WORKFLOW_STOPPED_ERROR) === true) state = "stopped";
  const a = { index, label: str(item.label) ?? `agent ${index}`, state };
  if (raw !== void 0 && raw !== state) a.rawState = raw;
  const n = (k, v) => {
    const x = num(v);
    if (x !== void 0) a[k] = x;
  };
  const s = (k, v) => {
    const x = str(v);
    if (x !== void 0 && x !== "") a[k] = x;
  };
  n("phaseIndex", item.phaseIndex);
  s("phaseTitle", item.phaseTitle);
  s("agentId", agentId);
  n("attempt", item.attempt);
  s("model", item.model);
  s("agentType", item.agentType);
  n("tokens", item.tokens);
  n("toolCalls", item.toolCalls);
  s("lastToolName", item.lastToolName);
  s("lastToolSummary", item.lastToolSummary);
  n("queuedAt", item.queuedAt);
  n("startedAt", startedAt);
  n("lastProgressAt", item.lastProgressAt);
  n("durationMs", item.durationMs);
  s("promptPreview", item.promptPreview);
  s("resultPreview", item.resultPreview);
  s("error", item.error);
  if (item.cached === true) a.cached = true;
  if (item.blocked === true) a.blocked = true;
  return a;
}
function taskUsageOf(raw) {
  if (!isObject(raw)) return void 0;
  const usage = {};
  const tokens = num(raw.total_tokens);
  const toolUses = num(raw.tool_uses);
  const durationMs = num(raw.duration_ms);
  if (tokens !== void 0) usage.tokens = tokens;
  if (toolUses !== void 0) usage.toolUses = toolUses;
  if (durationMs !== void 0) usage.durationMs = durationMs;
  return usage;
}
function workflowStopReason(status) {
  if (status === "completed") return "completed";
  if (status === "stopped" || status === "killed") return "cancelled";
  return "error";
}
function framingText(line) {
  if (line.type !== "user" || line.isMeta === true) return void 0;
  const message = isObject(line.message) ? line.message : {};
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.length === 0) return void 0;
  const texts = [];
  for (const b of c) {
    if (!isObject(b) || b.type !== "text" || typeof b.text !== "string") return void 0;
    texts.push(b.text);
  }
  return texts.join("\n");
}
var nodeTimers = {
  set(fn, ms) {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clear(h) {
    clearInterval(h);
  }
};
var WorkflowRuns = class {
  #o;
  #now;
  #debug;
  #runs = /* @__PURE__ */ new Map();
  /** Workflow agent id → its run's task id. */
  #agentRuns = /* @__PURE__ */ new Map();
  #kids;
  #timer;
  constructor(options = {}) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? (() => {
    });
    this.#kids = new ChildAgents({ debug: this.#debug });
  }
  isRun(taskId) {
    return this.#runs.has(taskId);
  }
  /** Whether an id is a workflow agent of this session (it cannot be stopped on its own). */
  isAgent(id) {
    return this.#agentRuns.has(id);
  }
  /** The workflow run task id that holds an agent. */
  runOfAgent(id) {
    return this.#agentRuns.get(id);
  }
  label(agentId) {
    const taskId = this.#agentRuns.get(agentId);
    return taskId === void 0 ? void 0 : this.#runs.get(taskId)?.agents.get(agentId)?.label;
  }
  /** The run's merged snapshot (for tests and views). */
  snapshot(taskId) {
    return this.#runs.get(taskId)?.snap;
  }
  /** `task_started` of a `local_workflow` task. */
  taskStarted(msg) {
    const taskId = str(msg.task_id);
    if (taskId === void 0 || this.#runs.has(taskId)) return;
    const run = {
      taskId,
      name: str(msg.workflow_name) ?? str(msg.description) ?? "workflow",
      started: false,
      ended: false,
      agents: /* @__PURE__ */ new Map()
    };
    const label = str(msg.description);
    if (label !== void 0) run.label = label;
    const callId = str(msg.tool_use_id);
    if (callId !== void 0) run.callId = callId;
    this.#runs.set(taskId, run);
  }
  /** The launch result of a Workflow call: `tool_use_result` of a main-thread user frame. */
  static launchInfo(msg) {
    const r = msg.tool_use_result;
    if (!isObject(r) || r.status !== "async_launched" || str(r.taskId) === void 0) return void 0;
    if (r.taskType !== void 0 && r.taskType !== "local_workflow") return void 0;
    return r;
  }
  /** The user asked to stop the whole run (`stopTask(run)`): its agents that end now were stopped. */
  noteStopRequested(taskId) {
    const run = this.#runs.get(taskId);
    if (run !== void 0 && !run.ended) run.stopping = true;
  }
  /** Emit `workflow-start` (and any snapshot held until now). Call after the call's `tool-result`. */
  launched(info, callId, at, out) {
    const taskId = str(info.taskId);
    let run = this.#runs.get(taskId);
    if (run === void 0) {
      run = { taskId, name: str(info.workflowName) ?? "workflow", started: false, ended: false, agents: /* @__PURE__ */ new Map() };
      this.#runs.set(taskId, run);
    }
    if (run.ended) return;
    const name2 = str(info.workflowName);
    if (name2 !== void 0) run.name = name2;
    const label = str(info.summary);
    if (label !== void 0 && run.label === void 0) run.label = label;
    if (callId !== void 0 && run.callId === void 0) run.callId = callId;
    const runId = str(info.runId);
    if (runId !== void 0) run.runId = runId;
    const scriptPath = str(info.scriptPath);
    if (scriptPath !== void 0) run.scriptPath = scriptPath;
    const dir = str(info.transcriptDir);
    if (dir !== void 0) {
      run.transcriptDir = dir;
      run.pendingDir = dir;
      this.#openTail(run);
    }
    this.#start(run, at, out);
    if (run.snap !== void 0) this.#publish(run, at, out);
    this.#poll();
  }
  /** `task_progress` of a run. Frames without `workflow_progress` change nothing here (D48). */
  progress(msg, at, out) {
    const taskId = str(msg.task_id);
    const run = taskId === void 0 ? void 0 : this.#runs.get(taskId);
    if (run === void 0 || run.ended) return;
    const frame = parseWorkflowProgress(msg.workflow_progress);
    if (frame === void 0) return;
    run.snap = mergeWorkflowSnapshot(run.snap, frame);
    const usage = taskUsageOf(msg.usage);
    if (usage !== void 0) run.usage = usage;
    this.#syncAgents(run, at);
    if (run.started) this.#publish(run, at, out);
  }
  /** `task_notification` of a run: its agents end, a final snapshot, then `workflow-end`. */
  ended(taskId, status, summary, usage, out) {
    const run = this.#runs.get(taskId);
    if (run === void 0 || run.ended) return;
    const stopReason = workflowStopReason(status);
    if (stopReason === "cancelled") run.stopping = true;
    const at = this.#now();
    if (!run.started) this.#start(run, at, out);
    if (usage !== void 0) run.usage = usage;
    if (run.snap !== void 0) {
      this.#syncAgents(run, at);
      for (const a of run.agents.values()) this.#readAgent(run, a, at, out, true);
      run.snap = settleWorkflowSnapshot(run.snap, stopReason);
      this.#publish(run, at, out, stopReason);
    }
    for (const a of run.agents.values()) if (a.announced && !a.ended) this.#endAgent(run, a, stopReason, out);
    run.ended = true;
    delete run.tail;
    delete run.pendingDir;
    const e = { type: "workflow-end", taskId, stopReason };
    if (summary !== void 0) e.summary = summary;
    if (run.usage !== void 0) e.usage = run.usage;
    out.push(e);
    this.#poll();
  }
  /** The CLI ended: live runs end with it (D74). */
  exit(out, reason) {
    for (const run of this.#runs.values()) if (!run.ended) this.ended(run.taskId, "failed", reason, void 0, out);
    this.dispose();
  }
  dispose() {
    if (this.#timer !== void 0) (this.#o.timers ?? nodeTimers).clear(this.#timer);
    this.#timer = void 0;
  }
  /** One live poll (D49). Public for tests; the timer calls it. */
  tick() {
    const out = [];
    const at = this.#now();
    for (const run of this.#runs.values()) {
      if (run.ended || !run.started) continue;
      for (const a of run.agents.values()) {
        const late = a.settledAt !== void 0 && at - a.settledAt >= (this.#o.settleGraceMs ?? SETTLE_GRACE_MS);
        this.#readAgent(run, a, at, out, late);
        if (late && a.announced) this.#endAgent(run, a, void 0, out);
      }
      const e = this.#snapshotEvent(run, at);
      if (e !== void 0) out.push(e);
      for (const a of run.agents.values()) {
        if (!a.announced || a.ended) continue;
        const row = this.#row(run, a);
        if (row !== void 0) this.#usage(a, this.#liveRow(a, row), out);
      }
    }
    return out;
  }
  // ---- internals ----
  /**
   * D49 guard: read a run's folder only when its real path is under the CLI's `projects` folder.
   * A folder that does not exist yet stays pending (the CLI creates it at the first agent's start);
   * an existing folder outside `projects` is never read.
   */
  #openTail(run) {
    const dir = run.pendingDir;
    if (dir === void 0 || run.tail !== void 0) return;
    const projects = this.#o.projectsDir?.();
    const fs = this.#o.fs ?? nodeTailFs;
    if (projects === void 0) {
      delete run.pendingDir;
      return;
    }
    if (insideFolder(dir, projects, fs)) {
      run.tail = new TranscriptTail(dir, fs);
      delete run.pendingDir;
    } else if (fs.realpath(dir) !== void 0) {
      delete run.pendingDir;
      this.#debug("workflow transcript folder not under the projects folder; not read", { dir, projects });
    }
  }
  #start(run, at, out) {
    if (run.started) return;
    run.started = true;
    const e = {
      type: "workflow-start",
      taskId: run.taskId,
      name: run.name,
      at
    };
    if (run.label !== void 0) e.label = run.label;
    if (run.runId !== void 0) e.runId = run.runId;
    if (run.callId !== void 0) e.callId = run.callId;
    if (run.transcriptDir !== void 0) e.transcriptDir = run.transcriptDir;
    if (run.scriptPath !== void 0) e.scriptPath = run.scriptPath;
    out.push(e);
  }
  /** Snapshot (if changed), new agents, their usage and settled agents. */
  #publish(run, at, out, stopReason) {
    const snap = run.snap;
    if (snap === void 0) return;
    const pos = out.length;
    this.#syncAgents(run, at);
    for (const row of snap.agents) {
      if (row.agentId === void 0) continue;
      const a = run.agents.get(row.agentId);
      if (a === void 0 || a.ended) continue;
      const settled = row.state === "done" || row.state === "error" || row.state === "stopped";
      this.#readAgent(run, a, at, out, settled);
      if (!a.announced) continue;
      this.#usage(a, this.#liveRow(a, row), out);
      if (!settled) continue;
      if (stopReason === void 0 && this.#timer !== void 0) a.settledAt ??= at;
      else this.#endAgent(run, a, stopReason, out);
    }
    const e = this.#snapshotEvent(run, at);
    if (e !== void 0) out.splice(pos, 0, e);
  }
  /** The run's snapshot with live tokens, if it changed since the last one sent. */
  #snapshotEvent(run, at) {
    const snap = run.snap;
    if (snap === void 0) return void 0;
    const agents = snap.agents.map((row) => {
      const a = row.agentId === void 0 ? void 0 : run.agents.get(row.agentId);
      return a === void 0 ? row : this.#liveRow(a, row);
    });
    const key = JSON.stringify({ phases: snap.phases, agents });
    if (key === run.lastSent) return void 0;
    run.lastSent = key;
    const e = {
      type: "workflow-snapshot",
      taskId: run.taskId,
      phases: snap.phases,
      agents,
      at
    };
    if (run.usage !== void 0) e.usage = run.usage;
    return e;
  }
  /** A running row with the agent's live tokens (M5). A settled row keeps the CLI's own count. */
  #liveRow(a, row) {
    if (a.liveTokens === void 0 || row.state === "done" || row.state === "error" || row.state === "stopped")
      return row;
    return { ...row, tokens: a.liveTokens };
  }
  /** Register the agents a snapshot names for the first time. */
  #syncAgents(run, at) {
    for (const row of run.snap?.agents ?? []) {
      if (row.agentId === void 0 || run.agents.has(row.agentId)) continue;
      run.agents.set(row.agentId, {
        agentId: row.agentId,
        index: row.index,
        label: row.label,
        announced: false,
        ended: false,
        firstSeen: at,
        framing: [],
        framingDone: false
      });
      this.#agentRuns.set(row.agentId, run.taskId);
    }
  }
  #row(run, a) {
    return run.snap?.agents.find((r) => r.agentId === a.agentId) ?? run.snap?.agents.find((r) => r.index === a.index);
  }
  /**
   * Read new lines of an agent's file. Before the agent is announced, its leading user texts are
   * the CLI's framing (its task prompt); the announce happens at the computed-task frame, at the
   * first other chat line, after ANNOUNCE_AFTER_MS, or when `force` (the agent or run settled).
   */
  #readAgent(run, a, at, out, force) {
    if (a.ended) return;
    this.#openTail(run);
    const lines = run.tail === void 0 ? [] : force ? run.tail.drain(a.agentId) : run.tail.read(a.agentId);
    for (const raw of lines) {
      if (!isObject(raw) || raw.type !== "user" && raw.type !== "assistant") continue;
      if (!a.announced && !a.framingDone) {
        const text = framingText(raw);
        if (text !== void 0) {
          a.framing.push(text);
          if (text.startsWith(FRAME_COMPUTED_TASK)) {
            a.framingDone = true;
            this.#announce(run, a, at, out);
          }
          continue;
        }
        a.framingDone = true;
      }
      if (!a.announced) this.#announce(run, a, at, out);
      this.#feed(a, raw, at, out);
    }
    if (!a.announced && (force || at - a.firstSeen >= (this.#o.announceAfterMs ?? ANNOUNCE_AFTER_MS)))
      this.#announce(run, a, at, out);
  }
  #announce(run, a, at, out) {
    if (a.announced) return;
    a.announced = true;
    const row = this.#row(run, a);
    this.#kids.adopt(a.agentId, a.label);
    const e = {
      type: "agent-start",
      ref: { kind: "child", id: a.agentId },
      parent: MAIN2,
      label: a.label,
      role: "workflow-agent",
      background: true,
      // D49: the CLI's own framing texts, as written; else its preview of the prompt.
      taskPrompt: a.framing.length > 0 ? a.framing.join("\n\n") : row?.promptPreview ?? a.label,
      depth: 1,
      at
    };
    if (run.callId !== void 0) e.parentCallId = run.callId;
    if (row?.agentType !== void 0) e.agentType = row.agentType;
    out.push(e);
  }
  #feed(a, raw, at, out) {
    const wire = {
      type: raw.type,
      message: raw.message,
      parent_tool_use_id: `workflow:${a.agentId}`,
      agent_id: a.agentId
    };
    const uuid = str(raw.uuid);
    if (uuid !== void 0) wire.uuid = uuid;
    if (raw.type === "assistant") {
      const usage = isObject(raw.message) && isObject(raw.message.usage) ? raw.message.usage : void 0;
      if (usage !== void 0) {
        const t = (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0);
        if (t > 0) a.liveTokens = t;
      }
    }
    const evs = [];
    if (raw.type === "assistant") this.#kids.assistant(wire, at, evs);
    else this.#kids.user(wire, at, evs);
    for (const e of evs) if (e.type !== "agent-start" && e.type !== "agent-end") out.push(e);
  }
  #usage(a, row, out) {
    const usage = {};
    if (row.tokens !== void 0) usage.tokens = row.tokens;
    if (row.toolCalls !== void 0) usage.toolUses = row.toolCalls;
    if (row.durationMs !== void 0) usage.durationMs = row.durationMs;
    const key = JSON.stringify(usage);
    if (key === "{}" || key === a.usageKey) return;
    a.usageKey = key;
    out.push({ type: "task-progress", taskId: a.agentId, usage });
  }
  #endAgent(run, a, stopReason, out) {
    if (a.ended) return;
    a.ended = true;
    const row = this.#row(run, a);
    if (row !== void 0) this.#usage(a, row, out);
    let status;
    if (row?.state === "done") status = "completed";
    else if (stopReason === "error") status = "failed";
    else if (row?.state === "stopped" || stopReason === "cancelled" || run.stopping === true) status = "stopped";
    else status = "failed";
    const e = {
      type: "agent-end",
      ref: { kind: "child", id: a.agentId },
      status
    };
    const summary = row?.resultPreview ?? row?.error;
    if (summary !== void 0) e.summary = summary;
    out.push(e);
  }
  /** Start or stop the live poll: it runs while a run with a readable folder is live. */
  #poll() {
    const live = [...this.#runs.values()].some((r) => !r.ended && (r.tail !== void 0 || r.pendingDir !== void 0));
    const timers = this.#o.timers ?? nodeTimers;
    if (live && this.#timer === void 0 && this.#o.emit !== void 0) {
      const emit = this.#o.emit;
      this.#timer = timers.set(() => {
        const evs = this.tick();
        if (evs.length > 0) emit(evs);
      }, this.#o.pollMs ?? WORKFLOW_POLL_MS);
    } else if (!live && this.#timer !== void 0) this.dispose();
  }
};

// packages/backend-claude/src/model-id.ts
function canonicalModel(model) {
  if (model === void 0) return void 0;
  let m = model;
  const slash = m.lastIndexOf("/");
  if (m.startsWith("arn:") && slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  m = m.replace(/-v\d+(?::\d+)?$/, "");
  return m;
}

// packages/backend-claude/src/usage.ts
function costBasisOf(v) {
  return v === "list" || v === "managed" || v === "unknown" ? v : void 0;
}
function parseModelEntry(key, raw) {
  if (!isObject(raw)) return void 0;
  const tokens = {
    input: num(raw.inputTokens) ?? 0,
    output: num(raw.outputTokens) ?? 0,
    cacheRead: num(raw.cacheReadInputTokens) ?? 0,
    cacheWrite: num(raw.cacheCreationInputTokens) ?? 0
  };
  const thinking = num(raw.thinkingTokens);
  if (thinking !== void 0) tokens.reasoning = thinking;
  const m = {
    model: canonicalModel(str(raw.canonicalModel) ?? key) ?? key,
    tokens,
    costUsd: num(raw.costUSD) ?? 0
  };
  const web = num(raw.webSearchRequests);
  if (web !== void 0) m.webSearches = web;
  const window = num(raw.contextWindow);
  if (window !== void 0 && window > 0) m.contextWindow = window;
  const maxOut = num(raw.maxOutputTokens);
  if (maxOut !== void 0 && maxOut > 0) m.maxOutputTokens = maxOut;
  const basis = costBasisOf(raw.costBasis);
  if (basis !== void 0) m.costBasis = basis;
  const provider = str(raw.provider);
  if (provider !== void 0) m.provider = provider;
  return m;
}
function mergeModel(a, b) {
  const out = { ...a, ...b, tokens: addTokens(a.tokens, b.tokens), costUsd: a.costUsd + b.costUsd };
  if (a.webSearches !== void 0 || b.webSearches !== void 0)
    out.webSearches = (a.webSearches ?? 0) + (b.webSearches ?? 0);
  const basis = b.costBasis ?? a.costBasis;
  if (basis !== void 0) out.costBasis = basis;
  else delete out.costBasis;
  return out;
}
function parseModelUsage(raw) {
  if (!isObject(raw)) return void 0;
  const out = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(raw)) {
    const m = parseModelEntry(key, value);
    if (m === void 0) continue;
    const prev = out.get(m.model);
    out.set(m.model, prev === void 0 ? m : mergeModel(prev, m));
  }
  return out;
}
function sumModels(models) {
  let tokens = zeroTokens();
  let costUsd = 0;
  for (const m of models) {
    tokens = addTokens(tokens, m.tokens);
    costUsd += m.costUsd;
  }
  return { tokens, costUsd };
}
function subtractModels(a, b) {
  const out = /* @__PURE__ */ new Map();
  for (const [k, m] of a) {
    const p = b.get(k);
    if (p === void 0) {
      out.set(k, m);
      continue;
    }
    const d = {
      ...m,
      tokens: subtractTokens(m.tokens, p.tokens),
      costUsd: Math.max(0, m.costUsd - p.costUsd)
    };
    if (m.webSearches !== void 0) d.webSearches = Math.max(0, m.webSearches - (p.webSearches ?? 0));
    if (!isZeroTokens(d.tokens) || d.costUsd > 0) out.set(k, d);
  }
  return out;
}
var AUTH_PROVIDERS = {
  bedrock: { kind: "bedrock", label: "Amazon Bedrock" },
  vertex: { kind: "vertex", label: "Google Vertex AI" },
  foundry: { kind: "foundry", label: "Microsoft Foundry" },
  anthropicAws: { kind: "cloud", label: "Anthropic on AWS" },
  anthropicGoogleCloud: { kind: "cloud", label: "Anthropic on Google Cloud" },
  mantle: { kind: "cloud", label: "Mantle" },
  gateway: { kind: "gateway", label: "Claude apps gateway" }
};
function authFromAccount(account, apiKeySource) {
  const a = isObject(account) ? account : {};
  const provider = str(a.apiProvider);
  const known = provider === void 0 ? void 0 : AUTH_PROVIDERS[provider];
  if (known !== void 0) return { kind: known.kind, label: known.label, provider };
  const out = { kind: "unknown", label: "Unknown account" };
  if (provider !== void 0) out.provider = provider;
  const sub = str(a.subscriptionType);
  const source = str(a.apiKeySource) ?? apiKeySource;
  if (sub !== void 0 && sub !== "") {
    out.kind = "subscription";
    out.label = `Claude ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
    out.subscriptionType = sub;
  } else if (source !== void 0 && source !== "none") {
    out.kind = "api-key";
    out.label = "API key";
    out.apiKeySource = source;
  } else if (provider === "firstParty") out.label = "Anthropic account";
  else if (provider !== void 0) {
    out.kind = "cloud";
    out.label = provider;
  }
  return out;
}
var CLOUD_BILL = {
  bedrock: "Your bill is in your AWS account.",
  vertex: "Your bill is in your Google Cloud account.",
  foundry: "Your bill is in your Azure account.",
  cloud: "Your bill is with your cloud provider.",
  gateway: "Your organisation\u2019s gateway decides what is billed.",
  "api-key": "Your bill is in your Anthropic Console account."
};
function costLabelFor(auth, basis) {
  const warning = basis === "unknown" ? "No price matched this model, so the figure is a guess." : void 0;
  let label;
  if (auth?.kind === "subscription")
    label = {
      text: "API-equivalent",
      primary: false,
      note: "Not a bill: your plan covers this use. Your plan limits are what count."
    };
  else if (basis === "managed")
    label = { text: "managed price", primary: true, note: "Priced at your organisation\u2019s own rates." };
  else if (basis === "unknown") label = { text: "unknown price", primary: true };
  else {
    label = { text: "estimate at list price", primary: true };
    const note = auth === void 0 ? void 0 : CLOUD_BILL[auth.kind];
    if (note !== void 0) label.note = note;
  }
  if (warning !== void 0) label.warning = warning;
  return label;
}
var LIMIT_LABELS = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly limit (Opus)",
  seven_day_sonnet: "Weekly limit (Sonnet)",
  seven_day_oauth_apps: "Weekly limit (apps)",
  seven_day_overage_included: "Weekly limit (extra usage included)",
  overage: "Extra usage",
  extra_usage: "Extra usage"
};
function limitLabel(id) {
  if (id.startsWith("model:")) return `Weekly limit (${id.slice(6)})`;
  return LIMIT_LABELS[id] ?? id.replace(/_/g, " ");
}
function statusOf2(v) {
  return v === "allowed" || v === "allowed_warning" || v === "rejected" ? v : void 0;
}
function parseRateLimitInfo(info, at) {
  if (!isObject(info)) return void 0;
  const report = { limits: [] };
  const status = statusOf2(info.status);
  if (status !== void 0) report.status = status;
  const type = str(info.rateLimitType);
  if (type !== void 0) report.rateLimitType = type;
  const resetsAtS = num(info.resetsAt);
  if (resetsAtS !== void 0) report.resetsAt = resetsAtS * 1e3;
  const seen = /* @__PURE__ */ new Set();
  if (isObject(info.unifiedWindows))
    for (const [id, w] of Object.entries(info.unifiedWindows)) {
      if (!isObject(w)) continue;
      const u2 = num(w.utilization);
      if (u2 === void 0) continue;
      const limit = { id, label: limitLabel(id), percent: u2 * 100, source: "event", at };
      const r = num(w.resetsAt);
      if (r !== void 0) limit.resetsAt = r * 1e3;
      const s = statusOf2(w.status);
      if (s !== void 0) limit.status = s;
      report.limits.push(limit);
      seen.add(id);
    }
  const u = num(info.utilization);
  if (type !== void 0 && !seen.has(type) && (u !== void 0 || status !== void 0 && status !== "allowed")) {
    const limit = { id: type, label: limitLabel(type), source: "event", at };
    if (u !== void 0) limit.percent = u * 100;
    if (report.resetsAt !== void 0) limit.resetsAt = report.resetsAt;
    if (status !== void 0) limit.status = status;
    report.limits.push(limit);
  }
  const overage = {};
  const os = statusOf2(info.overageStatus);
  if (os !== void 0) overage.status = os;
  const or = num(info.overageResetsAt);
  if (or !== void 0) overage.resetsAt = or * 1e3;
  const reason = str(info.overageDisabledReason);
  if (reason !== void 0) overage.disabledReason = reason;
  if (typeof info.isUsingOverage === "boolean") overage.inUse = info.isUsingOverage;
  if (Object.keys(overage).length > 0) report.overage = overage;
  return report;
}
function parseUsageLimits(resp, at) {
  if (!isObject(resp) || typeof resp.rate_limits_available !== "boolean") return void 0;
  const limits = [];
  const rl = isObject(resp.rate_limits) ? resp.rate_limits : void 0;
  const push = (id, w) => {
    if (!isObject(w)) return;
    const percent = num(w.utilization);
    if (percent === void 0) return;
    const limit = { id, label: limitLabel(id), percent, source: "usage-api", at };
    const resets = str(w.resets_at);
    const t = resets === void 0 ? NaN : Date.parse(resets);
    if (Number.isFinite(t)) limit.resetsAt = t;
    limits.push(limit);
  };
  if (rl !== void 0) {
    for (const id of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"])
      push(id, rl[id]);
    if (Array.isArray(rl.model_scoped)) {
      for (const w of rl.model_scoped) if (isObject(w) && str(w.display_name)) push(`model:${str(w.display_name)}`, w);
    }
    const extra = rl.extra_usage;
    if (isObject(extra) && extra.is_enabled === true) push("extra_usage", extra);
  }
  return { available: resp.rate_limits_available, limits };
}
function parseContextUsage(r) {
  const raw = isObject(r) ? r : {};
  const used = num(raw.totalTokens) ?? num(raw.total_tokens) ?? 0;
  const window = num(raw.maxTokens) ?? num(raw.raw_max_tokens) ?? num(raw.rawMaxTokens) ?? 0;
  const out = { used, window };
  const auto = num(raw.autoCompactThreshold);
  if (auto !== void 0) out.autoCompactAt = auto;
  if (typeof raw.isAutoCompactEnabled === "boolean") out.autoCompactEnabled = raw.isAutoCompactEnabled;
  const pct = num(raw.percentage);
  if (pct !== void 0) out.percent = pct;
  const model = canonicalModel(str(raw.model));
  if (model !== void 0) out.model = model;
  if (Array.isArray(raw.categories)) {
    const cats = [];
    for (const c of raw.categories) {
      if (!isObject(c)) continue;
      const name2 = str(c.name);
      const tokens = num(c.tokens);
      if (name2 === void 0 || tokens === void 0) continue;
      const cat = { name: name2, tokens };
      const id = str(c.id);
      if (id !== void 0) cat.id = id;
      const kind = c.kind;
      if (kind === "used" || kind === "free" || kind === "buffer" || kind === "deferred") cat.kind = kind;
      else if (c.isDeferred === true) cat.kind = "deferred";
      const color = str(c.color);
      if (color !== void 0) cat.color = color;
      cats.push(cat);
    }
    out.categories = cats;
  }
  const details = parseContextDetails(raw);
  if (details !== void 0) out.details = details;
  return out;
}
function parseContextDetails(raw) {
  const rows = (v) => Array.isArray(v) ? v.filter(isObject) : [];
  const d = {};
  const mcp = rows(raw.mcpTools ?? raw.mcp_tools).flatMap((t) => {
    const name2 = str(t.name);
    const server = str(t.serverName) ?? str(t.server_name);
    const tokens = num(t.tokens);
    return name2 !== void 0 && server !== void 0 && tokens !== void 0 ? [{ name: name2, server, tokens }] : [];
  });
  if (mcp.length > 0) d.mcpTools = mcp;
  const memory = rows(raw.memoryFiles ?? raw.memory_files).flatMap((f) => {
    const path9 = str(f.path);
    const type = str(f.type);
    const tokens = num(f.tokens);
    return path9 !== void 0 && type !== void 0 && tokens !== void 0 ? [{ path: path9, type, tokens }] : [];
  });
  if (memory.length > 0) d.memoryFiles = memory;
  const agents = rows(raw.agents).flatMap((a) => {
    const name2 = str(a.agentType) ?? str(a.agent_type);
    const source = str(a.source);
    const tokens = num(a.tokens);
    return name2 !== void 0 && source !== void 0 && tokens !== void 0 ? [{ name: name2, source, tokens }] : [];
  });
  if (agents.length > 0) d.agents = agents;
  const skillRows = Array.isArray(raw.skills) ? raw.skills : isObject(raw.skills) ? raw.skills.skillFrontmatter : [];
  const skills = rows(skillRows).flatMap((s) => {
    const name2 = str(s.name);
    const source = str(s.source);
    const tokens = num(s.tokens);
    if (name2 === void 0 || source === void 0 || tokens === void 0) return [];
    const row = { name: name2, source, tokens };
    const plugin = str(s.pluginName) ?? str(s.plugin_name);
    if (plugin !== void 0) row.plugin = plugin;
    return [row];
  });
  if (skills.length > 0) d.skills = skills;
  return Object.keys(d).length > 0 ? d : void 0;
}
function zeroCumulative() {
  return { models: /* @__PURE__ */ new Map(), costUsd: 0, apiDurationMs: 0 };
}
var UsageLedger = class {
  #now;
  /** The conversation's running totals (D58): baseline + every counted delta; reset on D70. */
  #conv = zeroCumulative();
  /** The process's last running totals (to difference when the CLI sends no delta). */
  #prev;
  /** Main-thread calls since the last result (D57). */
  #main = zeroTokens();
  #calls = 0;
  #counted = /* @__PURE__ */ new Set();
  #resultSeen = false;
  #resetPending = false;
  #lastTurn;
  #account;
  #apiKeySource;
  #credentialExpiresAt;
  #auth;
  #authKey;
  #windows = /* @__PURE__ */ new Map();
  #ctx;
  #lastContext;
  #limits = { limits: [] };
  #limitsKey = "";
  constructor(options = {}) {
    this.#now = options.now ?? Date.now;
    if ((options.startedAs ?? "new") === "new") this.#prev = zeroCumulative();
  }
  // ---- reads ----
  totals() {
    return this.#totalsOf(this.#conv);
  }
  get lastTurn() {
    return this.#lastTurn;
  }
  get auth() {
    return this.#auth;
  }
  costLabel() {
    return costLabelFor(this.#auth, worstCostBasis([...this.#conv.models.values()].map((m) => m.costBasis)));
  }
  limits() {
    const now = this.#now();
    const limits = this.#limits.limits.filter((l) => l.resetsAt === void 0 || l.resetsAt > now);
    const out = { ...this.#limits, limits };
    if (out.blocked?.resetsAt !== void 0 && out.blocked.resetsAt <= now) delete out.blocked;
    if (out.available === false && out.note === void 0)
      out.note = `No plan limits for this account${this.#auth ? ` (${this.#auth.label})` : ""}.`;
    return out;
  }
  snapshot() {
    const s = {
      totals: this.totals(),
      costLabel: this.costLabel(),
      limits: this.limits(),
      at: this.#now()
    };
    if (this.#auth !== void 0) s.auth = this.#auth;
    if (this.#lastTurn !== void 0) s.lastTurn = this.#lastTurn;
    return s;
  }
  // ---- inputs ----
  /**
   * One main-thread model call's final usage (D57), once per `message.id`. Returns the `context`
   * event for it when the model's window is known.
   */
  mainCall(messageId, usage, model) {
    if (this.#counted.has(messageId)) return [];
    this.#counted.add(messageId);
    this.#main = addTokens(this.#main, usage);
    this.#calls++;
    return this.#context(contextTokens(usage), model);
  }
  /** `initializationResult().account` / `accountInfo()`. */
  account(account) {
    this.#account = account;
    return this.#authChanged();
  }
  /** `system/init.apiKeySource`. */
  apiKeySource(source) {
    if (source === void 0 || source === this.#apiKeySource) return [];
    this.#apiKeySource = source;
    return this.#authChanged();
  }
  /**
   * The usage control's answer. Before the first result of this process it is the baseline
   * (resumed totals, D58); its plan windows always update the limits (D60).
   */
  usageControl(resp) {
    const out = [];
    if (!isObject(resp)) return out;
    const session = isObject(resp.session) ? resp.session : void 0;
    const models = parseModelUsage(session?.model_usage);
    if (session !== void 0 && models !== void 0 && !this.#resultSeen) {
      const base = {
        models,
        costUsd: num(session.total_cost_usd) ?? sumModels(models.values()).costUsd,
        apiDurationMs: num(session.total_api_duration_ms) ?? 0
      };
      this.#prev = base;
      this.#conv = { models: new Map(models), costUsd: base.costUsd, apiDurationMs: base.apiDurationMs };
      this.#noteWindows(models);
      if (models.size > 0) out.push(this.#usageEvent());
    }
    const sub = str(resp.subscription_type);
    if (sub !== void 0 && sub !== "" && this.#auth?.kind !== "subscription") {
      this.#account = { ...isObject(this.#account) ? this.#account : {}, subscriptionType: sub };
      out.push(...this.#authChanged());
    }
    const parsed = parseUsageLimits(resp, this.#now());
    if (parsed !== void 0) {
      const next = { ...this.#limits, available: parsed.available };
      if (!parsed.available) next.limits = [];
      else {
        const byId = new Map(this.#limits.limits.map((l) => [l.id, l]));
        for (const l of parsed.limits) byId.set(l.id, l);
        next.limits = [...byId.values()];
      }
      this.#limits = next;
      out.push(...this.#limitsChanged());
    }
    return out;
  }
  /** `rate_limit_event` (D60): live plan windows. Only plan accounts get one. */
  rateLimit(info) {
    const report = parseRateLimitInfo(info, this.#now());
    if (report === void 0) return [];
    const byId = new Map(this.#limits.limits.map((l) => [l.id, l]));
    for (const l of report.limits) byId.set(l.id, { ...byId.get(l.id), ...l });
    const next = { ...this.#limits, available: true, limits: [...byId.values()] };
    delete next.note;
    if (report.status === "rejected") {
      next.blocked = {};
      if (report.resetsAt !== void 0) next.blocked.resetsAt = report.resetsAt;
      if (report.rateLimitType !== void 0) next.blocked.limitId = report.rateLimitType;
    } else delete next.blocked;
    if (report.overage !== void 0) next.overage = report.overage;
    this.#limits = next;
    return this.#limitsChanged();
  }
  /** `getContextUsage` answered: the window and auto-compact point for later `context` events. */
  contextReport(c) {
    if (c.window <= 0) return;
    this.#ctx = { window: c.window };
    if (c.autoCompactAt !== void 0) this.#ctx.autoCompactAt = c.autoCompactAt;
    if (c.model !== void 0) this.#ctx.model = c.model;
  }
  /** A compaction finished: the context is now `postTokens` (D59). */
  compacted(postTokens) {
    if (postTokens === void 0) return [];
    return this.#context(postTokens, this.#ctx?.model);
  }
  /**
   * D70: the conversation was reset. The CLI's counters restart at 0. After `/clear` the clear's
   * own result still states calls counted before it, so that reset applies after that result.
   */
  conversationReset(trigger) {
    if (trigger === "clear") {
      this.#resetPending = true;
      return [];
    }
    return this.#applyReset();
  }
  /** A `result` frame. Returns the `usage` event (before the turn's end), if anything changed. */
  result(msg) {
    const out = [];
    const cumulative = parseModelUsage(msg.modelUsage);
    const sinceRaw = msg.model_usage_since_last_result;
    const since = parseModelUsage(sinceRaw);
    const cost = num(msg.total_cost_usd);
    const apiMs = num(msg.duration_api_ms);
    const expires = str(msg.credential_expires_at);
    if (expires !== void 0) {
      const t = Date.parse(expires);
      if (Number.isFinite(t) && t !== this.#credentialExpiresAt) {
        this.#credentialExpiresAt = t;
        out.push(...this.#authChanged());
      }
    }
    const zeroed = msg.subtype !== "success" && cumulative !== void 0 && cumulative.size === 0 && (cost ?? 0) === 0 && this.#prev !== void 0 && this.#prev.costUsd > 0 && !this.#resetPending;
    if (cumulative === void 0 || zeroed) {
      this.#main = zeroTokens();
      this.#calls = 0;
      return out;
    }
    const local = str(msg.local_command) !== void 0;
    const prevApi = this.#prev?.apiDurationMs;
    const keepApi = prevApi !== void 0 && (apiMs === void 0 || local && apiMs < prevApi);
    const now = {
      models: cumulative,
      costUsd: cost ?? sumModels(cumulative.values()).costUsd,
      apiDurationMs: keepApi ? prevApi : apiMs ?? 0
    };
    this.#noteWindows(cumulative);
    let delta;
    if (since !== void 0) delta = since;
    else if (this.#prev !== void 0) delta = subtractModels(now.models, this.#prev.models);
    let deltaCost;
    if (since !== void 0) deltaCost = sumModels(since.values()).costUsd;
    else if (this.#prev !== void 0) deltaCost = Math.max(0, now.costUsd - this.#prev.costUsd);
    let apiDelta = 0;
    if (this.#prev !== void 0)
      apiDelta = now.apiDurationMs >= this.#prev.apiDurationMs ? now.apiDurationMs - this.#prev.apiDurationMs : now.apiDurationMs;
    let turn;
    if (delta !== void 0) {
      for (const [k, m] of delta) {
        const c = this.#conv.models.get(k);
        this.#conv.models.set(k, c === void 0 ? m : mergeModel(c, m));
      }
      this.#conv.costUsd += deltaCost ?? 0;
      this.#conv.apiDurationMs += apiDelta;
      let total = sumModels(delta.values()).tokens;
      total = {
        ...total,
        input: Math.max(total.input, this.#main.input),
        output: Math.max(total.output, this.#main.output),
        cacheRead: Math.max(total.cacheRead, this.#main.cacheRead),
        cacheWrite: Math.max(total.cacheWrite, this.#main.cacheWrite)
      };
      turn = {
        main: this.#main,
        other: subtractTokens(total, this.#main),
        total,
        calls: this.#calls,
        costUsd: deltaCost ?? 0,
        apiDurationMs: apiDelta,
        models: [...delta.values()],
        costBasis: worstCostBasis([...delta.values()].map((m) => m.costBasis))
      };
      const d = num(msg.duration_ms);
      if (d !== void 0) turn.durationMs = d;
      const ttft = num(msg.ttft_ms);
      if (ttft !== void 0) turn.ttftMs = ttft;
    } else {
      this.#conv = { models: new Map(now.models), costUsd: now.costUsd, apiDurationMs: now.apiDurationMs };
    }
    this.#prev = now;
    this.#resultSeen = true;
    this.#main = zeroTokens();
    this.#calls = 0;
    const counted = turn !== void 0 && (!isZeroTokens(turn.total) || turn.costUsd > 0);
    if (turn !== void 0 && (counted || !local)) {
      this.#lastTurn = turn;
      out.push(this.#usageEvent(turn));
    } else if (turn === void 0) out.push(this.#usageEvent());
    if (this.#resetPending) out.push(...this.#applyReset());
    return out;
  }
  // ---- internals ----
  #applyReset() {
    this.#resetPending = false;
    this.#conv = zeroCumulative();
    this.#prev = zeroCumulative();
    this.#main = zeroTokens();
    this.#calls = 0;
    this.#lastTurn = void 0;
    this.#lastContext = void 0;
    return [this.#usageEvent()];
  }
  #totalsOf(c) {
    const models = [...c.models.values()];
    return {
      tokens: sumModels(models).tokens,
      costUsd: c.costUsd,
      apiDurationMs: c.apiDurationMs,
      models,
      costBasis: worstCostBasis(models.map((m) => m.costBasis))
    };
  }
  #usageEvent(turn) {
    const e = {
      type: "usage",
      cumulative: this.totals(),
      costLabel: this.costLabel()
    };
    if (turn !== void 0) e.turn = turn;
    return e;
  }
  #noteWindows(models) {
    for (const m of models.values()) if (m.contextWindow !== void 0) this.#windows.set(m.model, m.contextWindow);
  }
  #context(used, model) {
    const window = (model === void 0 ? void 0 : this.#windows.get(model)) ?? (this.#ctx !== void 0 && (model === void 0 || this.#ctx.model === void 0 || this.#ctx.model === model) ? this.#ctx.window : void 0) ?? (this.#windows.size === 1 ? [...this.#windows.values()][0] : void 0);
    if (window === void 0 || window <= 0) return [];
    if (this.#lastContext?.used === used && this.#lastContext.window === window) return [];
    this.#lastContext = { used, window };
    const e = { type: "context", used, window };
    if (this.#ctx?.autoCompactAt !== void 0 && this.#ctx.window === window)
      e.autoCompactAt = this.#ctx.autoCompactAt;
    return [e];
  }
  #authChanged() {
    if (this.#account === void 0 && this.#apiKeySource === void 0) return [];
    const auth = authFromAccount(this.#account, this.#apiKeySource);
    if (this.#credentialExpiresAt !== void 0) auth.credentialExpiresAt = this.#credentialExpiresAt;
    const key = JSON.stringify(auth);
    if (key === this.#authKey) return [];
    this.#authKey = key;
    this.#auth = auth;
    if (auth.kind !== "subscription" && auth.kind !== "gateway" && auth.kind !== "unknown" && this.#limits.available === void 0) {
      this.#limits = { ...this.#limits, available: false };
    }
    return [{ type: "auth", auth, costLabel: this.costLabel() }, ...this.#limitsChanged()];
  }
  #limitsChanged() {
    const limits = this.limits();
    const key = JSON.stringify({ ...limits, limits: limits.limits.map((l) => ({ ...l, at: 0 })) });
    if (key === this.#limitsKey) return [];
    this.#limitsKey = key;
    return [{ type: "limits", limits }];
  }
};

// packages/backend-claude/src/commands.ts
var MCP_TOGGLE_NOTE = "Saved by Claude Code in ~/.claude.json, like /mcp in the terminal.";
var MCP_PROMPT_SUFFIX = " (MCP)";
var CommandCatalog = class {
  #skills = /* @__PURE__ */ new Set();
  #terminal = /* @__PURE__ */ new Set();
  #initNames;
  #rows;
  /** `system/init`. Returns the names-only list to announce, or undefined when it lists none. */
  init(msg) {
    if (Array.isArray(msg.skills)) this.#skills = new Set(strArray(msg.skills));
    if (Array.isArray(msg.terminal_slash_commands)) this.#terminal = new Set(strArray(msg.terminal_slash_commands));
    if (!Array.isArray(msg.slash_commands)) return void 0;
    this.#initNames = strArray(msg.slash_commands);
    if (this.#rows !== void 0) return this.list();
    return this.#initNames.map((name2) => this.#decorate({ name: name2 }));
  }
  /** Full rows from `supportedCommands()` or a `commands_changed` push. */
  rows(raw) {
    const list = Array.isArray(raw) ? raw.flatMap((r) => isObject(r) ? [toCommandInfo(r)] : []) : [];
    this.#rows = list;
    return this.list();
  }
  /** The current list, decorated. Empty before any report. */
  list() {
    const base = this.#rows ?? (this.#initNames ?? []).map((name2) => ({ name: name2 }));
    return base.map((c) => this.#decorate({ ...c }));
  }
  isSkill(name2) {
    return this.#skills.has(name2);
  }
  /** The skill names `init` reported, in its order (undefined before `init`). */
  get skillNames() {
    return this.#initNames === void 0 && this.#skills.size === 0 ? void 0 : [...this.#skills];
  }
  #decorate(c) {
    if (this.#skills.has(c.name) && c.kind !== "builtin") c.kind = "skill";
    if (this.#terminal.has(c.name)) c.terminalOnly = true;
    return c;
  }
};
function toCommandInfo(raw) {
  const name2 = str(raw.name) ?? "";
  const info = { name: name2 };
  const description = str(raw.description);
  if (description) info.description = description;
  const hint = str(raw.argumentHint);
  if (hint) info.argumentHint = hint;
  const aliases = strArray(raw.aliases).filter((a) => a !== "");
  if (aliases.length > 0) info.aliases = aliases;
  if (raw.builtin === true) info.kind = "builtin";
  else if (name2.endsWith(MCP_PROMPT_SUFFIX)) info.kind = "mcp-prompt";
  else info.kind = "custom";
  return info;
}
function skillList(catalog, commands, contextSkills) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const fromContext = new Map((contextSkills ?? []).map((s) => [s.name, s]));
  const names = catalog.skillNames ?? (contextSkills ?? []).map((s) => s.name);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const name2 of names) {
    if (seen.has(name2)) continue;
    seen.add(name2);
    const info = { name: name2 };
    const c = byName.get(name2);
    if (c?.description) info.description = c.description;
    if (c?.argumentHint) info.argumentHint = c.argumentHint;
    const s = fromContext.get(name2);
    if (s !== void 0) {
      info.source = s.source;
      if (s.plugin !== void 0) info.plugin = s.plugin;
      info.tokens = s.tokens;
    }
    out.push(info);
  }
  return out;
}
function localCommandOf(msg) {
  const run = isObject(msg.local_command_run) ? msg.local_command_run : void 0;
  const outcome = isObject(msg.local_command_outcome) ? msg.local_command_outcome : void 0;
  if (run === void 0 && outcome === void 0 && msg.local_command_source === void 0) return void 0;
  const info = {};
  const name2 = str(run?.command) ?? nameFromSource(str(msg.local_command_source));
  if (name2 !== void 0 && name2 !== "") info.name = name2;
  const args = str(run?.args);
  if (args !== void 0 && args !== "") info.args = args;
  if (str(outcome?.kind) === "unavailable_headless") info.unavailable = true;
  if (isObject(msg.context_usage)) info.structured = { kind: "context", context: parseContextUsage(msg.context_usage) };
  return info;
}
function nameFromSource(source) {
  const m = source === void 0 ? null : /^<local-command-stdout>\/([^\s]+) isn't available/.exec(source);
  return m?.[1];
}
function slashCommandOf(input) {
  const first = input.parts[0];
  if (first === void 0 || first.type !== "text") return void 0;
  const m = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(first.text.trimEnd());
  if (m === null) return void 0;
  return { name: m[1], args: (m[2] ?? "").trim() };
}
function toMcpServerInfo(raw) {
  const name2 = str(raw.name);
  if (name2 === void 0) return void 0;
  const info = { name: name2, status: str(raw.status) ?? "pending" };
  const error = str(raw.error);
  if (error) info.error = error;
  const scope = str(raw.scope);
  if (scope) info.scope = scope;
  const source = str(raw.source);
  if (source) info.source = source;
  if (isObject(raw.serverInfo)) {
    const n = str(raw.serverInfo.name);
    const v = str(raw.serverInfo.version);
    if (n) info.serverName = n;
    if (v) info.serverVersion = v;
  }
  if (isObject(raw.config)) {
    const t = str(raw.config.type);
    if (t) info.transport = t;
    else if (str(raw.config.command) !== void 0) info.transport = "stdio";
  }
  if (Array.isArray(raw.tools)) {
    info.tools = raw.tools.flatMap((t) => {
      if (!isObject(t)) return [];
      const n = str(t.name);
      if (n === void 0) return [];
      const tool = { name: n };
      const d = str(t.description);
      if (d) tool.description = d;
      const a = isObject(t.annotations) ? t.annotations : void 0;
      if (a?.readOnly === true) tool.readOnly = true;
      if (a?.destructive === true) tool.destructive = true;
      return [tool];
    });
  }
  return info;
}
function toMcpServerList(raw) {
  return Array.isArray(raw) ? raw.flatMap((r) => {
    const s = isObject(r) ? toMcpServerInfo(r) : void 0;
    return s === void 0 ? [] : [s];
  }) : [];
}
function toMcpAuthStart(raw) {
  const r = isObject(raw) ? raw : {};
  const out = {
    needsUserAction: r.requiresUserAction === true,
    callbackExpected: r.callbackExpected === true
  };
  const url = str(r.authUrl);
  if (url) out.url = url;
  return out;
}
function sideHistoryWire(history) {
  return history.slice(-20).map((h) => {
    const e = { question: h.question, response: h.answer };
    if (h.fallbackNotice) e.fallback_notice = h.fallbackNotice;
    return e;
  });
}
function toSideAnswer(raw) {
  if (raw === null || raw === void 0) return null;
  const r = isObject(raw) ? raw : {};
  const text = str(r.response);
  if (text === void 0) return null;
  const out = { text, synthetic: r.synthetic === true };
  const f = isObject(r.refusalFallback) ? r.refusalFallback : void 0;
  if (f !== void 0) {
    const originalModel = str(f.originalModel);
    const fallbackModel = str(f.fallbackModel);
    const content = str(f.content);
    if (originalModel !== void 0 && fallbackModel !== void 0 && content !== void 0)
      out.fallback = { originalModel, fallbackModel, content };
  }
  return out;
}

// packages/backend-claude/src/mapper.ts
var MAIN3 = Object.freeze({ kind: "main" });
function isEmptyReasoning(b) {
  return b.type === "reasoning" && b.text === "";
}
function slotKept(s) {
  if (s.dropped) return false;
  if (s.block !== void 0) return !isEmptyReasoning(s.block);
  return s.kind !== "tool-call" && s.streamed !== "";
}
function usageFromStart(u) {
  if (!isObject(u)) return void 0;
  return {
    input: num(u.input_tokens) ?? 0,
    output: 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0
  };
}
function toolArguments(input) {
  return JSON.stringify(input ?? {});
}
function convertBlock(b) {
  switch (b.type) {
    case "text":
      return { type: "text", text: str(b.text) ?? "" };
    case "thinking":
      return { type: "reasoning", text: str(b.thinking) ?? "" };
    case "tool_use": {
      const t = b;
      const id = str(t.id);
      const name2 = str(t.name);
      if (id === void 0 || name2 === void 0) return void 0;
      return { type: "tool-call", id, name: name2, arguments: toolArguments(t.input) };
    }
    default:
      return void 0;
  }
}
function slotKind(b) {
  if (b === void 0) return void 0;
  if (b.type === "text") return "text";
  if (b.type === "thinking") return "reasoning";
  if (b.type === "tool_use") return "tool-call";
  return void 0;
}
function convertToolResultContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content === void 0 ? [] : [{ type: "other", value: content }];
  return content.map((c) => {
    if (isObject(c) && c.type === "text" && typeof c.text === "string") return { type: "text", text: c.text };
    if (isObject(c) && c.type === "image" && isObject(c.source) && c.source.type === "base64") {
      const mediaType = str(c.source.media_type);
      const data = str(c.source.data);
      if (mediaType !== void 0 && data !== void 0) return { type: "image", mediaType, base64: data };
    }
    return { type: "other", value: c };
  });
}
function taskKind(taskType) {
  switch (taskType) {
    case "local_agent":
    case "remote_agent":
      return "agent";
    case "local_workflow":
      return "workflow";
    case "local_bash":
      return "shell";
    default:
      return taskType !== void 0 && /monitor/i.test(taskType) ? "monitor" : "shell";
  }
}
var ClaudeMessageMapper = class {
  #tracker;
  #now;
  #debug;
  #turnOpen = false;
  /** An input of ours was consumed while no CLI turn was open (lifecycle `started` precedes `status`). */
  #consumedWhileIdle = false;
  #interruptRequested = false;
  #step;
  #seenUuids = /* @__PURE__ */ new Set();
  /** Tool ids advertised in an emitted step-message. */
  #advertised = /* @__PURE__ */ new Set();
  /** tool-result events waiting for their call to be advertised, in arrival order. */
  #buffered = [];
  /** The open whole-response step (D84): its message id, and whether its usage was sent. */
  #whole;
  #background = /* @__PURE__ */ new Map();
  #children;
  #workflows;
  /** Workflow launches whose call result is held (D18): emitted after that result. */
  #pendingLaunches = /* @__PURE__ */ new Map();
  #usage;
  /** R7.1: the CLI's command list and skill names (D52). */
  #commands = new CommandCatalog();
  /** The last slash command we sent, to name a local command output that has no name (R7.2). */
  /** The last sent line's slash command; `queued` when it was sent while a turn ran (it answers after that turn). */
  #lastSlash;
  /** The CLI session id of the frames (D70: it changes after a conversation reset). */
  #sessionId;
  /** A `conversation_reset` seen; its event waits for the first frame of the new conversation. */
  #pendingReset;
  /** A compaction is running (`status: compacting` seen, no end yet). */
  #compacting = false;
  constructor(tracker, options = {}) {
    this.#tracker = tracker;
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? (() => {
    });
    this.#children = new ChildAgents({ debug: this.#debug });
    this.#workflows = new WorkflowRuns({ ...options.workflows, now: this.#now, debug: this.#debug });
    this.#usage = options.usage ?? new UsageLedger({ now: this.#now });
  }
  /** Usage accounting of this stream (D57-D60). */
  get usage() {
    return this.#usage;
  }
  /** The command list and skills this stream reported (R7.1, R7.5). */
  get commands() {
    return this.#commands;
  }
  /** The session sent a line that starts with `/name` (it went to the CLI as plain text, D52). */
  noteSlashCommand(cmd) {
    this.#lastSlash = cmd === void 0 ? void 0 : { name: cmd.name, args: cmd.args, queued: this.#turnOpen };
  }
  /** Workflow runs seen on this stream (D48). */
  get workflows() {
    return this.#workflows;
  }
  /** Child agents seen on this stream (labels for asks, D77). */
  get children() {
    return this.#children;
  }
  /** The session calls this right before `interrupt()`, so the next error result maps to `interrupted`. */
  noteInterruptRequested() {
    if (this.#turnOpen) this.#interruptRequested = true;
  }
  get turnOpen() {
    return this.#turnOpen;
  }
  map(raw, at = this.#now()) {
    if (!isObject(raw)) return [];
    const msg = raw;
    const out = [];
    const sid = str(msg.session_id);
    if (msg.type !== "conversation_reset") {
      if (this.#pendingReset !== void 0 && sid !== void 0 && sid !== this.#pendingReset.from)
        this.#flushReset(sid, out);
      if (sid !== void 0) this.#sessionId = sid;
    }
    switch (msg.type) {
      case "system":
        this.#system(msg, at, out);
        break;
      case "command_lifecycle":
        this.#lifecycle(msg, out);
        break;
      case "stream_event":
        this.#stream(msg, at, out);
        break;
      case "assistant":
        this.#assistant(msg, at, out);
        break;
      case "user":
        if (msg.parent_tool_use_id) this.#children.user(msg, at, out);
        else this.#user(msg, out);
        break;
      case "result":
        this.#result(msg, out);
        if (this.#lastSlash?.queued) this.#lastSlash.queued = false;
        else this.#lastSlash = void 0;
        break;
      case "tombstone":
        this.#tombstone(msg, out);
        break;
      case "conversation_reset":
        if (this.#pendingReset !== void 0) this.#flushReset(this.#pendingReset.hinted, out);
        this.#pendingReset = {
          from: this.#sessionId ?? sid,
          hinted: str(msg.new_conversation_id),
          trigger: str(msg.trigger)
        };
        break;
      case "rate_limit_event":
        out.push(...this.#usage.rateLimit(msg.rate_limit_info));
        break;
      default:
        this.#debug("ignored message type", msg);
    }
    return out;
  }
  /** The sent slash command a local output answers, once. */
  #takeSlash() {
    const s = this.#lastSlash;
    this.#lastSlash = void 0;
    if (s === void 0) return void 0;
    return s.args === "" ? { name: s.name } : { name: s.name, args: s.args };
  }
  /** The CLI process ended or the iterator threw. Closes what the mapper holds. */
  exit(error) {
    const out = [];
    this.#step = void 0;
    this.#whole = void 0;
    this.#buffered = [];
    this.#turnOpen = false;
    this.#children.exit(out, error ?? "Claude Code ended");
    this.#workflows.exit(out, error ?? "Claude Code ended");
    this.#pendingLaunches.clear();
    out.push(error === void 0 ? { type: "exit" } : { type: "exit", error });
    return out;
  }
  /** D70: the conversation was reset; `newSessionId` is the id the CLI now runs under. */
  #flushReset(newSessionId, out) {
    const r = this.#pendingReset;
    this.#pendingReset = void 0;
    if (r === void 0) return;
    const id = newSessionId ?? r.hinted;
    if (id !== void 0) {
      const e = { type: "conversation-reset", newSessionId: id };
      if (r.trigger !== void 0) e.trigger = r.trigger;
      out.push(e);
    }
    out.push(...this.#usage.conversationReset(r.trigger));
  }
  // ---- consumption and turn start ----
  #consume(ids, out) {
    for (const id of ids) {
      if (!this.#tracker.consume(id)) continue;
      if (!this.#turnOpen) this.#consumedWhileIdle = true;
      out.push({ type: "input-consumed", inputId: id });
    }
  }
  #maybeTurnStart(msg, out) {
    const uuids = strArray(msg.user_message_uuids);
    if (!this.#turnOpen) {
      this.#turnOpen = true;
      const ours = this.#consumedWhileIdle || uuids.some((id) => this.#tracker.wasSent(id)) || this.#tracker.pendingCount > 0;
      this.#consumedWhileIdle = false;
      out.push({ type: "turn-start", origin: ours ? "user" : "self" });
    }
    this.#consume(uuids, out);
  }
  #lifecycle(msg, out) {
    const id = str(msg.command_uuid);
    const state = str(msg.state);
    if (id === void 0) return;
    if (state === "started") this.#consume([id], out);
    else if (state === "cancelled")
      for (const inputId of this.#tracker.cancel([id])) out.push({ type: "input-cancelled", inputId });
  }
  // ---- system frames ----
  #system(msg, at, out) {
    switch (msg.subtype) {
      case "init": {
        const e = { type: "session-info" };
        const model = canonicalModel(str(msg.model));
        if (model !== void 0) e.model = model;
        const mode = str(msg.permissionMode);
        if (mode !== void 0) e.mode = mode;
        const version = str(msg.claude_code_version);
        if (version !== void 0) e.version = version;
        out.push(e);
        out.push(...this.#usage.apiKeySource(str(msg.apiKeySource)));
        const names = this.#commands.init(msg);
        if (names !== void 0) {
          const ev = { type: "commands", list: names };
          if (names.every((c) => c.description === void 0)) ev.namesOnly = true;
          out.push(ev);
        }
        if (Array.isArray(msg.mcp_servers)) out.push({ type: "mcp-status", servers: toMcpServerList(msg.mcp_servers) });
        break;
      }
      case "commands_changed":
        out.push({ type: "commands", list: this.#commands.rows(msg.commands) });
        break;
      case "local_command_output": {
        const text = str(msg.content);
        if (text === void 0 || text === "") break;
        this.#maybeTurnStart(msg, out);
        const stepId = str(msg.uuid) ?? `local-${at}`;
        this.#step = void 0;
        this.#whole = void 0;
        out.push({ type: "step-start", agent: MAIN3, stepId, at, synthetic: true });
        const e = {
          type: "step-message",
          agent: MAIN3,
          stepId,
          blocks: [{ type: "text", text }],
          final: true,
          synthetic: true,
          localCommand: this.#takeSlash() ?? {}
        };
        const uuid = str(msg.uuid);
        if (uuid !== void 0) e.lastChainId = uuid;
        out.push(e);
        break;
      }
      case "status": {
        const mode = str(msg.permissionMode);
        if (mode !== void 0) out.push({ type: "mode", mode });
        if (msg.status === "requesting") {
          this.#maybeTurnStart(msg, out);
          if (!msg.parent_tool_use_id) out.push({ type: "request-start", agent: MAIN3, at });
        } else this.#consume(strArray(msg.user_message_uuids), out);
        if (msg.status === "compacting" && !this.#compacting) {
          this.#compacting = true;
          out.push({ type: "compaction", phase: "start" });
        }
        if (msg.compact_result === "failed") {
          this.#compacting = false;
          const e = { type: "compaction", phase: "end" };
          e.error = str(msg.compact_error) ?? "Compaction failed";
          out.push(e);
        }
        break;
      }
      case "compact_boundary": {
        const meta = isObject(msg.compact_metadata) ? msg.compact_metadata : {};
        if (!this.#compacting) out.push({ type: "compaction", phase: "start" });
        this.#compacting = false;
        const e = { type: "compaction", phase: "end" };
        if (meta.trigger === "manual" || meta.trigger === "auto") e.trigger = meta.trigger;
        const pre = num(meta.pre_tokens);
        if (pre !== void 0) e.preTokens = pre;
        const post = num(meta.post_tokens);
        if (post !== void 0) e.postTokens = post;
        out.push(e);
        out.push(...this.#usage.compacted(post));
        break;
      }
      case "api_retry": {
        const e = {
          type: "retry",
          attempt: num(msg.attempt) ?? 1,
          error: str(msg.error) ?? "unknown"
        };
        const max = num(msg.max_retries);
        if (max !== void 0) e.maxRetries = max;
        const delay = num(msg.retry_delay_ms);
        if (delay !== void 0) e.delayMs = delay;
        const status = num(msg.error_status);
        if (status !== void 0) e.httpStatus = status;
        out.push(e);
        break;
      }
      case "task_started": {
        const taskId = str(msg.task_id);
        if (taskId === void 0) break;
        const kind = taskKind(str(msg.task_type));
        const agent = kind === "agent" ? this.#children.taskStarted(msg, at, out) : void 0;
        if (kind === "workflow") this.#workflows.taskStarted(msg);
        const background = msg.is_backgrounded === true || kind === "workflow";
        if (!background || this.#background.has(taskId)) break;
        this.#background.set(taskId, kind);
        const e = {
          type: "task-start",
          taskId,
          kind,
          label: (agent && this.#children.label(taskId)) ?? str(msg.description) ?? taskId
        };
        if (agent !== void 0) e.agent = agent;
        out.push(e);
        break;
      }
      case "task_progress": {
        const taskId = str(msg.task_id);
        if (taskId === void 0 || !this.#background.has(taskId) && !this.#children.isAgentTask(taskId)) break;
        const e = { type: "task-progress", taskId };
        const isRun = this.#workflows.isRun(taskId);
        const summary = isRun ? str(msg.description) ?? str(msg.summary) : str(msg.summary) ?? str(msg.description);
        if (summary !== void 0) e.summary = summary;
        const usage = taskUsage(msg.usage);
        if (usage !== void 0) e.usage = usage;
        out.push(e);
        if (isRun) this.#workflows.progress(msg, at, out);
        break;
      }
      case "task_notification": {
        const taskId = str(msg.task_id);
        if (taskId === void 0) break;
        const finalUsage = taskUsage(msg.usage);
        if (finalUsage !== void 0 && (this.#background.has(taskId) || this.#children.isAgentTask(taskId)))
          out.push({ type: "task-progress", taskId, usage: finalUsage });
        if (this.#children.isAgentTask(taskId))
          this.#children.taskEnded(taskId, str(msg.status), str(msg.summary), out);
        if (this.#workflows.isRun(taskId))
          this.#workflows.ended(taskId, str(msg.status), str(msg.summary), taskUsageOf(msg.usage), out);
        if (!this.#background.has(taskId)) break;
        this.#background.delete(taskId);
        const s = str(msg.status);
        const status = s === "completed" ? "completed" : s === "stopped" || s === "killed" ? "stopped" : "failed";
        const e = { type: "task-end", taskId, status };
        const summary = str(msg.summary);
        if (summary !== void 0) e.summary = summary;
        out.push(e);
        break;
      }
      case "background_tasks_changed": {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
        out.push({
          type: "tasks-snapshot",
          taskIds: tasks.map((t) => isObject(t) ? str(t.task_id) : void 0).filter((x) => !!x)
        });
        break;
      }
      case "informational": {
        const text = str(msg.content);
        if (text !== void 0 && text.trim() !== "")
          out.push({ type: "notice", level: str(msg.level) ?? "notice", text });
        break;
      }
      default:
        this.#debug("ignored system subtype", msg);
    }
  }
  // ---- main-thread stream ----
  #stream(msg, at, out) {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (!isObject(ev)) return;
    switch (ev.type) {
      case "message_start": {
        this.#maybeTurnStart(msg, out);
        const id = str(ev.message?.id);
        if (id === void 0) return;
        const step = {
          id,
          streamed: true,
          slots: [],
          positions: /* @__PURE__ */ new Map(),
          filled: [],
          chain: [],
          aborted: false,
          toolIds: /* @__PURE__ */ new Set()
        };
        this.#whole = void 0;
        const usage = usageFromStart(ev.message?.usage);
        if (usage !== void 0) step.usage = usage;
        const model = canonicalModel(str(ev.message?.model));
        if (model !== void 0) step.model = model;
        this.#step = step;
        out.push({ type: "step-start", agent: MAIN3, stepId: id, at });
        return;
      }
      case "content_block_start": {
        const step = this.#step;
        const index = num(ev.index);
        const kind = slotKind(ev.content_block);
        if (step === void 0 || index === void 0 || kind === void 0) return;
        step.positions.set(index, step.slots.length);
        const slot = { kind, streamed: "" };
        if (kind === "tool-call") {
          const b = ev.content_block;
          const toolId = str(b?.id);
          const toolName = str(b?.name);
          if (toolId !== void 0 && toolName !== void 0) [slot.toolId, slot.toolName] = [toolId, toolName];
        }
        step.slots.push(slot);
        return;
      }
      case "content_block_delta": {
        const step = this.#step;
        const index = num(ev.index);
        if (step === void 0 || index === void 0) return;
        const slotIndex = step.positions.get(index);
        const slot = slotIndex === void 0 ? void 0 : step.slots[slotIndex];
        if (slotIndex === void 0 || slot === void 0 || slot.dropped) return;
        const d = ev.delta ?? {};
        let kind;
        let text;
        if (d.type === "text_delta") [kind, text] = ["text", d.text];
        else if (d.type === "thinking_delta") [kind, text] = ["reasoning", d.thinking];
        else if (d.type === "input_json_delta") [kind, text] = ["tool-input", d.partial_json];
        if (kind === void 0 || text === void 0 || text === "") return;
        slot.streamed += text;
        let pos = 0;
        for (let i = 0; i < slotIndex; i++) if (slotKept(step.slots[i])) pos++;
        const delta = {
          type: "delta",
          agent: MAIN3,
          stepId: step.id,
          kind,
          blockIndex: pos,
          text,
          at
        };
        if (kind === "tool-input" && slot.toolId !== void 0 && slot.toolName !== void 0) {
          delta.toolCallId = slot.toolId;
          delta.toolName = slot.toolName;
        }
        out.push(delta);
        return;
      }
      case "message_delta": {
        const step = this.#step;
        const u = ev.usage;
        if (step === void 0 || !isObject(u)) return;
        const usage = step.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        usage.output = num(u.output_tokens) ?? usage.output;
        const input = num(u.input_tokens);
        if (input !== void 0) usage.input = input;
        const cacheRead = num(u.cache_read_input_tokens);
        if (cacheRead !== void 0) usage.cacheRead = cacheRead;
        const cacheWrite = num(u.cache_creation_input_tokens);
        if (cacheWrite !== void 0) usage.cacheWrite = cacheWrite;
        const details = u.output_tokens_details;
        const reasoning = isObject(details) ? num(details.thinking_tokens) : void 0;
        if (reasoning !== void 0 && reasoning > 0) usage.reasoning = reasoning;
        step.usage = usage;
        return;
      }
      case "message_stop":
        this.#closeStep(out);
        return;
      default:
        return;
    }
  }
  #assistant(msg, at, out) {
    if (msg.parent_tool_use_id) {
      this.#children.assistant(msg, at, out);
      return;
    }
    const uuid = str(msg.uuid);
    if (uuid !== void 0) {
      if (this.#seenUuids.has(uuid)) return;
      this.#seenUuids.add(uuid);
    }
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    this.#children.noteCalls(content, MAIN3);
    const id = str(msg.message?.id) ?? uuid ?? `msg-${at}`;
    const step = this.#step;
    const inStreamedStep = step !== void 0 && step.id === id && step.streamed;
    if (!inStreamedStep && content.some((b) => b.type === "tool_use" && typeof b.id === "string" && this.#advertised.has(b.id))) {
      this.#debug("re-sent assistant message", msg);
      return;
    }
    this.#maybeTurnStart(msg, out);
    const model = str(msg.message?.model);
    const synthetic = model === "<synthetic>";
    const error = msg.error === void 0 || msg.error === null ? void 0 : String(msg.error);
    if (inStreamedStep) {
      const blocks2 = content.map(convertBlock).filter((b) => b !== void 0);
      let skip = 0;
      if (blocks2.length > 1)
        while (skip < blocks2.length && skip < step.filled.length && isDeepStrictEqual(blocks2[skip], step.filled[skip]))
          skip++;
      for (const block of blocks2.slice(skip)) {
        if (block.type === "tool-call" && (step.toolIds.has(block.id) || this.#advertised.has(block.id))) {
          this.#debug("re-sent tool_use block (W1)", block);
          continue;
        }
        const slot = step.slots.find((s) => s.block === void 0 && !s.dropped && s.kind === block.type);
        const filled = slot ?? { kind: block.type, streamed: "" };
        filled.block = block;
        if (uuid !== void 0) filled.uuid = uuid;
        if (slot === void 0) step.slots.push(filled);
        step.filled.push(block);
        if (block.type === "tool-call") step.toolIds.add(block.id);
      }
      if (uuid !== void 0) {
        step.lastChainId = uuid;
        step.chain.push(uuid);
      }
      if (msg.aborted === true) step.aborted = true;
      return;
    }
    const blocks = content.map(convertBlock).filter((b) => b !== void 0 && !isEmptyReasoning(b));
    const special = synthetic || error !== void 0;
    const continues = !special && this.#whole?.id === id;
    if (!continues) {
      this.#step = void 0;
      this.#whole = special ? void 0 : { id, usageSent: false };
      const startEvent = {
        type: "step-start",
        agent: MAIN3,
        stepId: id,
        at
      };
      if (special) startEvent.synthetic = true;
      out.push(startEvent);
    }
    if (blocks.length > 0) {
      const e = {
        type: "step-message",
        agent: MAIN3,
        stepId: id,
        blocks,
        // A whole response may continue in further frames of the same message id (D84, D68);
        // the step closes on the next step-start, at the turn end, or when its calls resolve.
        final: special
      };
      if (special) {
        e.synthetic = true;
        if (error !== void 0) e.error = error;
        const local = localCommandOf(msg);
        if (local !== void 0) {
          const sent = this.#takeSlash();
          if (local.name === void 0 && sent !== void 0) {
            local.name = sent.name;
            if (sent.args !== "" && local.args === void 0) local.args = sent.args;
          }
          e.localCommand = local;
        }
      } else {
        const whole = this.#whole;
        const usage = usageFromStart(msg.message?.usage);
        const output = num(msg.message?.usage?.output_tokens);
        if (usage !== void 0 && output !== void 0 && output > 0 && !whole.usageSent) {
          usage.output = output;
          e.usage = usage;
          whole.usageSent = true;
        }
        const m = canonicalModel(model);
        if (m !== void 0) e.model = m;
      }
      if (uuid !== void 0) e.lastChainId = uuid;
      out.push(e);
      if (e.usage !== void 0) out.push(...this.#usage.mainCall(id, e.usage, e.model));
      for (const b of blocks) if (b.type === "tool-call") this.#advertised.add(b.id);
      this.#children.teamMessages(blocks, MAIN3, out);
    }
    this.#flushResults(out);
  }
  /**
   * D84 (2): `tombstone {message}` (CLI 2.1.318: "@internal Emitted when a previously-yielded
   * message is superseded"; whether the SDK stream forwards it is **unverified**, S1). Drops
   * what is not yet written: a buffered tool result, or the step content the message filled.
   * Anything already emitted stays; the DSH layer takes the uuid off its fork points (D72).
   */
  #tombstone(msg, out) {
    const target = isObject(msg.message) ? msg.message : void 0;
    const uuid = str(target?.uuid);
    if (uuid === void 0) return;
    this.#seenUuids.add(uuid);
    const before = this.#buffered.length;
    this.#buffered = this.#buffered.filter((r) => r.chainId !== uuid);
    const step = this.#step;
    let dropped = 0;
    if (step !== void 0) {
      for (const slot of step.slots) {
        if (slot.uuid !== uuid || slot.dropped) continue;
        slot.dropped = true;
        if (slot.block?.type === "tool-call") step.toolIds.delete(slot.block.id);
        dropped++;
      }
      step.chain = step.chain.filter((c) => c !== uuid);
      if (step.lastChainId === uuid) {
        const last = step.chain.at(-1);
        if (last === void 0) delete step.lastChainId;
        else step.lastChainId = last;
      }
    }
    this.#debug("tombstone", { uuid, droppedResults: before - this.#buffered.length, droppedBlocks: dropped });
    out.push({ type: "superseded", chainIds: [uuid] });
  }
  #closeStep(out) {
    const step = this.#step;
    if (step === void 0) return;
    this.#step = void 0;
    const blocks = [];
    for (const s of step.slots) {
      if (s.dropped) continue;
      if (s.block !== void 0) {
        if (!isEmptyReasoning(s.block)) blocks.push(s.block);
      } else if (s.kind === "text" && s.streamed !== "") blocks.push({ type: "text", text: s.streamed });
      else if (s.kind === "reasoning" && s.streamed !== "") blocks.push({ type: "reasoning", text: s.streamed });
    }
    if (blocks.length === 0) {
      return;
    }
    const e = {
      type: "step-message",
      agent: MAIN3,
      stepId: step.id,
      blocks,
      final: true
    };
    if (step.usage !== void 0) e.usage = step.usage;
    if (step.model !== void 0) e.model = step.model;
    if (step.lastChainId !== void 0) e.lastChainId = step.lastChainId;
    const hasCall = blocks.some((b) => b.type === "tool-call");
    if (step.aborted && !hasCall) e.interrupted = true;
    out.push(e);
    if (step.usage !== void 0) out.push(...this.#usage.mainCall(step.id, step.usage, step.model));
    for (const b of blocks) if (b.type === "tool-call") this.#advertised.add(b.id);
    this.#flushResults(out);
    this.#children.teamMessages(blocks, MAIN3, out);
  }
  #flushResults(out) {
    const keep2 = [];
    for (const r of this.#buffered) {
      if (!this.#advertised.has(r.callId)) {
        keep2.push(r);
        continue;
      }
      out.push(r);
      this.#launch(r.callId, out);
    }
    this.#buffered = keep2;
  }
  /** A held workflow launch whose call result was just written (D48: start after the result). */
  #launch(callId, out) {
    const info = this.#pendingLaunches.get(callId);
    if (info === void 0) return;
    this.#pendingLaunches.delete(callId);
    this.#workflows.launched(info, callId, this.#now(), out);
  }
  #user(msg, out) {
    const uuid = str(msg.uuid);
    if (uuid !== void 0) {
      if (this.#seenUuids.has(uuid)) return;
      this.#seenUuids.add(uuid);
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    const single = content.filter((b) => b.type === "tool_result").length === 1;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const callId = str(b.tool_use_id);
      if (callId === void 0) continue;
      const e = {
        type: "tool-result",
        agent: MAIN3,
        callId,
        isError: b.is_error === true,
        content: convertToolResultContent(b.content)
      };
      if (uuid !== void 0) e.chainId = uuid;
      const launch = single ? WorkflowRuns.launchInfo(msg) : void 0;
      if (launch !== void 0) this.#pendingLaunches.set(callId, launch);
      if (this.#advertised.has(callId)) {
        out.push(e);
        this.#launch(callId, out);
      } else this.#buffered.push(e);
    }
  }
  // ---- turn end ----
  #result(msg, out) {
    const numTurns = num(msg.num_turns);
    const text = str(msg.result) ?? "";
    if (this.#pendingReset !== void 0) this.#flushReset(this.#pendingReset.hinted, out);
    const usage = this.#usage.result(msg);
    this.#compacting = false;
    const answersOurs = this.#consumedWhileIdle || strArray(msg.user_message_uuids).some((id) => this.#tracker.wasSent(id));
    if (!this.#turnOpen && numTurns === 0 && text === "" && !answersOurs) {
      out.push(...usage);
      this.#debug("empty result skipped", msg);
      return;
    }
    if (!this.#turnOpen) this.#maybeTurnStart(msg, out);
    this.#closeStep(out);
    this.#consume(strArray(msg.user_message_uuids), out);
    const queued = num(msg.queued_turn_count) ?? 0;
    if (queued === 0)
      for (const id of this.#tracker.consumeAllIfNoSignal()) out.push({ type: "input-consumed", inputId: id });
    if (this.#buffered.length > 0) {
      this.#debug("dropping tool results with no advertised call", this.#buffered);
      this.#buffered = [];
    }
    for (const callId of [...this.#pendingLaunches.keys()]) this.#launch(callId, out);
    const reason = str(msg.terminal_reason ?? void 0);
    const subtype = str(msg.subtype);
    let outcome;
    let error;
    if (reason === "tool_deferred" || reason === "tool_deferred_unavailable") outcome = "deferred";
    else if (subtype === "success" && msg.is_error !== true) outcome = "completed";
    else if (subtype === "error_during_execution" && this.#interruptRequested) outcome = "interrupted";
    else {
      outcome = "error";
      const errors = strArray(msg.errors);
      error = errors.length > 0 ? errors.join("\n") : text || subtype || "Claude Code reported an error";
    }
    const e = {
      type: "turn-end",
      agent: MAIN3,
      outcome,
      pendingInputs: Math.max(this.#tracker.pendingCount, queued)
    };
    if (reason !== void 0) e.reason = reason;
    if (error !== void 0) e.error = error;
    out.push(...usage);
    out.push(e);
    this.#children.mainTurnEnded(outcome, out);
    this.#turnOpen = false;
    this.#interruptRequested = false;
  }
};
function taskUsage(raw) {
  if (!isObject(raw)) return void 0;
  const usage = {};
  const tokens = num(raw.total_tokens);
  const toolUses = num(raw.tool_uses);
  const durationMs = num(raw.duration_ms);
  if (tokens !== void 0) usage.tokens = tokens;
  if (toolUses !== void 0) usage.toolUses = toolUses;
  if (durationMs !== void 0) usage.durationMs = durationMs;
  return usage;
}

// packages/backend-claude/src/ask-context.ts
function mcpServerOfTool(toolName) {
  if (!toolName.startsWith("mcp__")) return void 0;
  const rest = toolName.slice(5);
  const i = rest.indexOf("__");
  return i > 0 ? rest.slice(0, i) : void 0;
}
function normalizeServerName(name2) {
  return name2.replace(/[^a-zA-Z0-9_-]/g, "_");
}
var ASK_CONTEXT_LIMIT = 256;
function setBounded(map, key, value, limit = ASK_CONTEXT_LIMIT) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
function sameAgent(a, b) {
  return a.kind === b.kind && (a.kind === "main" || b.kind === "child" && a.id === b.id);
}
var AskContext = class {
  #labels = /* @__PURE__ */ new Map();
  /** Open MCP tool calls: tool_use id → server (normalized) and asking agent. */
  #mcpCalls = /* @__PURE__ */ new Map();
  /** URL elicitation id → our interaction id (D43). */
  #elicitations = /* @__PURE__ */ new Map();
  #mode;
  #prePlanMode;
  #startMode;
  /** The CLI's current permission mode (init, then every `status` frame). */
  get mode() {
    return this.#mode;
  }
  /** The mode before plan mode began; the CLI restores it on a plain plan approval (D42). */
  get prePlanMode() {
    return this.#prePlanMode;
  }
  /** The mode this process started in (the CLI allows bypass when it started in it, D14). */
  get startMode() {
    return this.#startMode;
  }
  agentLabel(agentId) {
    return this.#labels.get(agentId);
  }
  /**
   * The agent whose open MCP call is the only one to this server, or undefined when none or
   * several agents have one (**inferred**: the CLI's elicitation callback names no agent).
   */
  elicitationAgent(serverName) {
    const server = normalizeServerName(serverName);
    let found;
    for (const c of this.#mcpCalls.values()) {
      if (c.server !== server) continue;
      if (found && !sameAgent(found, c.agent)) return void 0;
      found = c.agent;
    }
    return found;
  }
  rememberElicitation(elicitationId, interactionId) {
    setBounded(this.#elicitations, elicitationId, interactionId);
  }
  forgetElicitation(elicitationId) {
    this.#elicitations.delete(elicitationId);
  }
  /**
   * The process start mode, known before the CLI reports one (a mode set right after the spawn
   * comes before the first `init`). Ignored once the CLI has reported a mode.
   */
  seedStartMode(mode) {
    if (mode === void 0 || this.#mode !== void 0 || this.#startMode !== void 0) return;
    this.#startMode = mode;
    this.#mode = mode;
  }
  /** Read one wire message. Returns the events it closes (D43 `interaction-done`). */
  observe(raw) {
    if (!isObject(raw)) return [];
    const msg = raw;
    const out = [];
    if (msg.type === "system") this.#system(msg, out);
    else if (msg.type === "assistant") this.#assistant(msg);
    else if (msg.type === "user") this.#user(msg);
    return out;
  }
  #setMode(mode) {
    if (mode === "plan" && this.#mode !== "plan") this.#prePlanMode = this.#mode;
    this.#mode = mode;
  }
  #system(msg, out) {
    const mode = str(msg.permissionMode);
    if (msg.subtype === "init") {
      if (mode !== void 0) {
        if (this.#startMode === void 0) {
          this.#startMode = mode;
          this.#mode = void 0;
        }
        this.#setMode(mode);
      }
      return;
    }
    if (msg.subtype === "status") {
      if (mode !== void 0) this.#setMode(mode);
      return;
    }
    if (msg.subtype === "elicitation_complete") {
      const eid = str(msg.elicitation_id);
      const id = eid === void 0 ? void 0 : this.#elicitations.get(eid);
      if (eid !== void 0 && id !== void 0) {
        this.#elicitations.delete(eid);
        out.push({ type: "interaction-done", id });
      }
    }
  }
  #assistant(msg) {
    const agentId = str(msg.agent_id);
    const agent = msg.parent_tool_use_id && agentId ? { kind: "child", id: agentId } : { kind: "main" };
    if (agentId !== void 0 && !this.#labels.has(agentId)) {
      const type = str(msg.subagent_type);
      const task = str(msg.task_description);
      const label = type && task ? `${type}: ${task}` : type ?? task;
      if (label !== void 0) setBounded(this.#labels, agentId, label, ASK_CONTEXT_LIMIT * 4);
    }
    const message = isObject(msg.message) ? msg.message : void 0;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const b of content) {
      if (!isObject(b) || b.type !== "tool_use") continue;
      const id = str(b.id);
      const server = mcpServerOfTool(str(b.name) ?? "");
      if (id !== void 0 && server !== void 0) setBounded(this.#mcpCalls, id, { server, agent });
    }
  }
  #user(msg) {
    const message = isObject(msg.message) ? msg.message : void 0;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const b of content) {
      if (!isObject(b) || b.type !== "tool_result") continue;
      const id = str(b.tool_use_id);
      if (id !== void 0) this.#mcpCalls.delete(id);
    }
  }
};

// packages/backend-claude/src/lifecycle.ts
var DROPS_TURN_REFUSAL_PREFIX = "Resume rejected by --resume-drops-turn:";
var FORK_SCAN_LIMIT_BYTES = 64 * 1024 * 1024;
function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
function dropsTurnRefusal(raw) {
  if (!isObject(raw) || raw.type !== "result") return void 0;
  for (const t of [...strList(raw.errors), str(raw.result) ?? ""])
    if (t.trimStart().startsWith(DROPS_TURN_REFUSAL_PREFIX)) return t.trim();
  return void 0;
}
function refusalInText(text) {
  if (text === void 0) return void 0;
  const i = text.indexOf(DROPS_TURN_REFUSAL_PREFIX);
  if (i < 0) return void 0;
  return text.slice(i).split("\n")[0]?.trim();
}
function userText2(entry) {
  const msg = entry.message;
  if (!isObject(msg)) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
function onlyToolResults(entry) {
  const msg = entry.message;
  if (!isObject(msg) || !Array.isArray(msg.content) || msg.content.length === 0) return false;
  return msg.content.every((b) => isObject(b) && b.type === "tool_result");
}
function checkDropsTurn(transcript, cutUuid, hint) {
  const chain = /* @__PURE__ */ new Set();
  let foundCut = false;
  const prompts = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(e)) continue;
    const uuid = str(e.uuid);
    if (!foundCut) {
      if (uuid === cutUuid) {
        foundCut = true;
        chain.add(cutUuid);
      }
      continue;
    }
    const parent = str(e.parentUuid);
    if (uuid === void 0 || parent === void 0 || !chain.has(parent)) continue;
    if (e.isSidechain === true) continue;
    chain.add(uuid);
    if (e.type === "attachment") {
      const a = e.attachment;
      if (isObject(a) && a.type === "queued_command")
        return { validated: false, reason: "a queued message lies past the cut" };
      continue;
    }
    if (e.type !== "user") continue;
    const origin = isObject(e.origin) ? str(e.origin.kind) : void 0;
    const text = userText2(e);
    if (origin === "task-notification" || text.trimStart().startsWith("<task-notification>"))
      return { validated: false, reason: "a task notification lies past the cut" };
    if (e.isMeta === true || onlyToolResults(e) || text.startsWith("[Request interrupted")) continue;
    if (origin !== void 0 && origin !== "human")
      return { validated: false, reason: `a ${origin} message lies past the cut` };
    prompts.push(uuid);
  }
  if (!foundCut) return { validated: false, reason: "the cut entry is not in the source transcript" };
  if (prompts.length === 0) return { validated: false, reason: "no turn lies past the cut" };
  if (prompts.length > 1) return { validated: false, reason: `${prompts.length} turns lie past the cut` };
  if (prompts[0] !== hint) return { validated: false, reason: "the turn past the cut is not the hinted one" };
  return { validated: true, reason: "exactly the hinted turn lies past the cut" };
}
function refusalNote(refusal) {
  return `Claude Code refused the exact rewind check (${refusal.slice(DROPS_TURN_REFUSAL_PREFIX.length).trim() || "no detail"}). The fork goes on with a plain cut at the same point: anything the source took in after that point is left out too.`;
}
function toFileRewindResult(raw, dryRun) {
  const r = isObject(raw) ? raw : {};
  const out = { ok: r.canRewind === true, filesChanged: strList(r.filesChanged) };
  const error = str(r.error);
  if (error !== void 0 && error !== "") out.error = error;
  if (typeof r.insertions === "number") out.insertions = r.insertions;
  if (typeof r.deletions === "number") out.deletions = r.deletions;
  if (typeof r.skippedLinks === "number" && r.skippedLinks > 0) out.skippedLinks = r.skippedLinks;
  if (dryRun) out.dryRun = true;
  if (!out.ok && out.error === void 0) out.error = "Claude Code could not restore the files";
  return out;
}
function withPreview(real, rawReal, preview) {
  if (!real.ok || preview === void 0 || !preview.ok) return real;
  if (isObject(rawReal) && Array.isArray(rawReal.filesChanged)) return real;
  const out = { ...real, filesChanged: preview.filesChanged };
  if (preview.insertions !== void 0) out.insertions = preview.insertions;
  if (preview.deletions !== void 0) out.deletions = preview.deletions;
  return out;
}
function stderrTail(text, maxLines = 12, maxChars = 1500) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxChars) out = `\u2026${out.slice(out.length - maxChars)}`;
  return out;
}
var SDK_STDERR_SUFFIX = /\.\s*stderr:\s*([\s\S]*)$/;
function describeExit(input) {
  const proc = input.proc;
  const out = { reason: input.asked ?? "crashed" };
  if (proc?.code !== null && proc?.code !== void 0) out.code = proc.code;
  if (proc?.signal !== null && proc?.signal !== void 0) out.signal = proc.signal;
  if (input.asked !== void 0) return out;
  let sdk = input.sdkError?.trim();
  let sdkTail = "";
  const m = sdk === void 0 ? null : SDK_STDERR_SUFFIX.exec(sdk);
  if (sdk !== void 0 && m) {
    sdkTail = m[1] ?? "";
    sdk = sdk.slice(0, m.index).trim();
  }
  const tail = stderrTail(proc && proc.stderr.trim() !== "" ? proc.stderr : sdkTail);
  const parts = [];
  if (out.signal !== void 0)
    parts.push(
      out.signal === "SIGKILL" ? "it was killed (SIGKILL: out of memory, or another program ended it)" : `it was ended by the signal ${out.signal}`
    );
  else if (out.code !== void 0 && out.code !== 0) parts.push(`it exited with code ${out.code}`);
  else if (!sdk) {
    out.reason = "ended";
    parts.push(`it ended by itself${out.code === 0 ? " (exit code 0)" : ""}`);
  }
  if (sdk && !/^Claude Code process (exited with code|terminated by signal)/i.test(sdk) && !tail.includes(sdk))
    parts.push(firstLine(sdk));
  else if (sdk && parts.length === 0) parts.push(firstLine(sdk));
  if (parts.length === 0) parts.push("no reason was given");
  out.error = parts.join("; ");
  if (tail !== "") out.stderr = tail;
  return out;
}
function firstLine(text) {
  const line = text.split(/\r?\n/)[0].trim();
  return line.length > 300 ? `${line.slice(0, 299)}\u2026` : line;
}

// packages/backend-claude/src/session.ts
function effortFlags(effortId) {
  if (effortId === null) return { effortLevel: null, ultracode: null };
  if (effortId === "ultracode") return { ultracode: true };
  return { effortLevel: effortId, ultracode: false };
}
function fileReference(hostPath) {
  if (!hostPath.includes('"')) return `@"${hostPath}"`;
  if (!/\s/.test(hostPath) && !hostPath.startsWith('"')) return `@${hostPath}`;
  throw new Error(`cannot attach ${JSON.stringify(hostPath)}: its path holds both a space and a double quote`);
}
function toSdkUserMessage(input, mode) {
  const content = [];
  let text = "";
  let afterFile = false;
  const flushText = () => {
    if (text !== "") content.push({ type: "text", text });
    text = "";
    afterFile = false;
  };
  for (const part of input.parts) {
    if (part.type === "text") {
      if (afterFile && part.text !== "" && !/^\s/.test(part.text)) text += " ";
      text += part.text;
      if (part.text !== "") afterFile = false;
    } else if (part.type === "file") {
      text += (text === "" || /\s$/.test(text) ? "" : " ") + fileReference(part.hostPath);
      afterFile = true;
    } else {
      flushText();
      content.push({ type: "image", source: { type: "base64", media_type: part.mediaType, data: part.base64 } });
    }
  }
  flushText();
  const msg = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: input.id,
    origin: { kind: "human" }
  };
  if (mode === "next") msg.priority = "next";
  return msg;
}
var USAGE_CONTROL = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
async function optionalControl(q, name2, ...args) {
  const fn = q[name2];
  if (typeof fn !== "function") return void 0;
  try {
    return await fn.apply(q, args);
  } catch (e) {
    if (isUnsupported(e)) return void 0;
    throw e;
  }
}
function isUnsupported(e) {
  return /Unsupported control request subtype/.test(String(e?.message ?? e));
}
function hasControl(q, name2) {
  return typeof q[name2] === "function";
}
var ClaudeBackendSession = class {
  kind;
  startedAs;
  capabilities;
  controls;
  #sessionId;
  #input = new AsyncQueue();
  #events = new AsyncQueue();
  #tracker = new SentInputTracker();
  #mapper;
  /** The live query. Replaced once at most, after a refused fork cut (D29). */
  #query;
  /** Every control goes through this, so it follows a replaced query. */
  #q;
  /**
   * D29: while a validated fork cut may still be refused, the messages sent so far, so the plain
   * restart gets them again (the refused process never ran them). Undefined once disarmed.
   */
  #forkGuard;
  /** D30: sends wait for the file restore, so the first turn sees the restored files. */
  #ready = Promise.resolve();
  /**
   * M8: settles when a refusal restart replaces `#ready`. A send that waits on the refused
   * process's restore moves on at once, even when that control never answers.
   */
  #readyReplaced;
  #replaceReady = () => {
  };
  /**
   * D29, D35 (M7 live): the session choices sent to this process (model, effort, ultracode,
   * mode), in order. A plain restart after a refused cut is a new process on the user's
   * settings, so it gets them again before any input.
   */
  #choices = /* @__PURE__ */ new Map();
  #remember(key, again) {
    this.#choices.delete(key);
    this.#choices.set(key, again);
  }
  /** Why we ended the process, when we did (R3.6). */
  #asked;
  #init;
  #asks = new AskContext();
  #cliVersion;
  #exited = false;
  #pump;
  constructor(init) {
    this.#init = init;
    this.#readyReplaced = this.#nextReadyEpoch();
    this.kind = init.kind;
    this.#sessionId = init.sessionId;
    this.startedAs = init.startedAs;
    const mapperOpts = {};
    if (init.now) mapperOpts.now = init.now;
    if (init.debug) mapperOpts.debug = init.debug;
    const projectsDir = init.projectsDir;
    const workflows = {
      emit: (events) => {
        if (this.#exited) return;
        for (const e of events) this.#events.push(e);
      },
      projectsDir: () => projectsDir
    };
    if (init.workflowFs) workflows.fs = init.workflowFs;
    if (init.workflowTimers) workflows.timers = init.workflowTimers;
    mapperOpts.workflows = workflows;
    const ledgerOpts = { startedAs: init.startedAs };
    if (init.now) ledgerOpts.now = init.now;
    mapperOpts.usage = new UsageLedger(ledgerOpts);
    this.#mapper = new ClaudeMessageMapper(this.#tracker, mapperOpts);
    this.capabilities = {
      perTaskStop: true,
      sideQuestions: false,
      workflows: true,
      workflowAgentStop: false,
      teamMessaging: false,
      cancelQueued: true,
      fileRewind: init.options.enableFileCheckpointing === true,
      planChoices: planChoices({ canBypass: init.bypassOption }),
      toolViewPack: init.kind
    };
    if (init.fallbackOptions) this.#forkGuard = [];
    this.#query = withSdkVersionEnvRestored(() => init.queryFn({ prompt: this.#input, options: init.options }));
    this.#q = new Proxy({}, {
      get: (_t, key) => {
        const cur = this.#query;
        const v = cur[key];
        return typeof v === "function" ? v.bind(cur) : v;
      }
    });
    this.capabilities.sideQuestions = hasControl(this.#query, "askSideQuestion");
    this.controls = this.#makeControls();
    this.#pump = this.#run();
    void this.#prime();
    if (init.restoreFilesAt !== void 0) this.#ready = this.#restoreFiles(init.restoreFilesAt);
  }
  /**
   * D30: a rewind fork's "restore code". `rewindFiles` on this (new) process, before any input is
   * sent. The outcome is an event; a failure never blocks the conversation.
   */
  async #restoreFiles(inputId) {
    const query = this.#query;
    let result;
    if (!this.capabilities.fileRewind)
      result = { ok: false, filesChanged: [], error: "file checkpoints are off for this session" };
    else
      try {
        result = await this.#rewindFiles(inputId, false);
      } catch (e) {
        result = { ok: false, filesChanged: [], error: String(e?.message ?? e) };
      }
    if (!this.#exited && this.#query === query) this.#events.push({ type: "files-rewound", inputId, result });
  }
  #nextReadyEpoch() {
    return new Promise((resolve) => this.#replaceReady = resolve);
  }
  async #rewindFiles(inputId, dryRun) {
    const fn = this.#q.rewindFiles;
    if (typeof fn !== "function") throw new Error("this Claude Code version cannot restore files");
    const call = fn;
    try {
      if (dryRun) return toFileRewindResult(await call(inputId, { dryRun: true }), true);
      let preview;
      try {
        preview = toFileRewindResult(await call(inputId, { dryRun: true }), true);
      } catch {
        preview = void 0;
      }
      const raw = await call(inputId, void 0);
      return withPreview(toFileRewindResult(raw, false), raw, preview);
    } catch (e) {
      if (isUnsupported(e)) throw new Error("this Claude Code version cannot restore files", { cause: e });
      throw e;
    }
  }
  /**
   * D58-D60, rule 9: read the auth type, the usage baseline (resumed totals) and the context
   * window from the live process right after spawn. Controls only: no model call, no extra
   * process. Each read is optional (D9); a failure only leaves that part unknown.
   */
  async #prime() {
    const q = this.#q;
    const usage = this.#mapper.usage;
    const step = async (name2, run) => {
      try {
        const evs = await run();
        if (evs && !this.#exited) for (const e of evs) this.#events.push(e);
      } catch (e) {
        this.#init.debug?.(`usage prime: ${name2} failed`, String(e?.message ?? e));
      }
    };
    await step("initializationResult", async () => {
      const r = await optionalControl(q, "initializationResult");
      return r !== void 0 && r.account !== void 0 ? usage.account(r.account) : void 0;
    });
    await step("usage", async () => {
      const r = await optionalControl(q, USAGE_CONTROL, { skipBehaviors: true });
      return r === void 0 ? void 0 : usage.usageControl(r);
    });
    await step("getContextUsage", async () => {
      const r = await optionalControl(q, "getContextUsage", { detail: "summary" });
      if (r !== void 0) usage.contextReport(parseContextUsage(r));
    });
  }
  get sessionId() {
    return this.#sessionId;
  }
  get cliVersion() {
    return this.#cliVersion;
  }
  /**
   * D77: the label of a child agent for an ask: the child's name or task description from the
   * spawning call (a teammate's name), else the frame's `subagent_type: task_description`.
   */
  agentLabel(agentId) {
    return this.#mapper.children.label(agentId) ?? this.#mapper.workflows.label(agentId) ?? this.#asks.agentLabel(agentId);
  }
  /** What the interaction adapter reads about the live session (D42, D43, D44, D77). */
  get asks() {
    return this.#asks;
  }
  /**
   * The CLI allows bypass when it was started with the allow flag (our switch) or started in
   * bypass mode (the user's settings `defaultMode`), D14 / sdk-surface answer 13.
   */
  get canBypass() {
    return this.#init.bypassOption || this.#asks.startMode === "bypassPermissions";
  }
  events() {
    return this.#events;
  }
  async #run() {
    let error;
    for (; ; ) {
      let refused;
      try {
        refused = await this.#drain(this.#query);
      } catch (e) {
        error = String(e?.message ?? e);
        if (this.#forkGuard !== void 0 && this.#asked === void 0) {
          const proc2 = await this.#init.exitInfo?.();
          refused = refusalInText(error) ?? refusalInText(proc2?.stderr);
        }
      }
      if (refused === void 0 || this.#asked !== void 0) break;
      error = void 0;
      this.#restartPlain(refused);
    }
    this.#exited = true;
    const proc = this.#asked === void 0 ? await this.#init.exitInfo?.() : void 0;
    const exit = describeExit({
      ...this.#asked !== void 0 ? { asked: this.#asked } : {},
      ...error !== void 0 ? { sdkError: error } : {},
      ...proc !== void 0 ? { proc } : {}
    });
    for (const e of this.#mapper.exit(exit.error)) {
      if (e.type === "exit") {
        e.reason = exit.reason;
        if (exit.code !== void 0) e.code = exit.code;
        if (exit.signal !== void 0) e.signal = exit.signal;
        if (exit.stderr !== void 0) e.stderr = exit.stderr;
      }
      this.#events.push(e);
    }
    this.#events.end();
    this.#input.end();
    this.#init.onExit?.(exit.error);
  }
  /**
   * D29 (r3): the CLI refused the validated cut. Never retried as is (the refusal is
   * deterministic): the same fork starts again with a plain cut at the same point, gets the
   * inputs the refused process never ran, and the user sees a note. The source is left alone.
   */
  #restartPlain(refusal) {
    const sent = this.#forkGuard ?? [];
    this.#forkGuard = void 0;
    this.#init.debug?.("fork cut refused; restarting with a plain cut", refusal);
    this.#input.end();
    try {
      this.#query.close();
    } catch {
    }
    this.#input = new AsyncQueue();
    this.#init.newProcess?.();
    const options = this.#init.fallbackOptions;
    this.#query = withSdkVersionEnvRestored(() => this.#init.queryFn({ prompt: this.#input, options }));
    this.#events.push({ type: "notice", level: "warning", text: refusalNote(refusal) });
    void this.#prime();
    const again = [...this.#choices.values()];
    const restoreAt = this.#init.restoreFilesAt;
    this.#ready = (async () => {
      for (const f of again) {
        try {
          await f();
        } catch (e) {
          this.#init.debug?.("choice not applied again after the plain restart", String(e?.message ?? e));
        }
      }
      if (restoreAt !== void 0) await this.#restoreFiles(restoreAt);
    })();
    const replaced = this.#replaceReady;
    this.#readyReplaced = this.#nextReadyEpoch();
    replaced();
    const input = this.#input;
    void this.#ready.then(() => {
      for (const m of sent) input.push(m);
    });
  }
  /** Map one query's frames. Returns the refusal text when the CLI refused a validated cut. */
  async #drain(query) {
    for await (const msg of query) {
      const m = msg;
      if (this.#forkGuard !== void 0) {
        const refusal = dropsTurnRefusal(msg);
        if (refusal !== void 0) return refusal;
        if (m.type === "result" || m.type === "assistant") this.#forkGuard = void 0;
      }
      if (m.type === "system" && m.subtype === "init" && typeof m.claude_code_version === "string") {
        this.#cliVersion = m.claude_code_version;
        this.capabilities.backendVersion = m.claude_code_version;
      }
      const closed = this.#asks.observe(msg);
      for (const e of this.#mapper.map(msg)) {
        if (e.type === "conversation-reset") this.#sessionId = e.newSessionId;
        this.#events.push(e);
      }
      for (const e of closed) this.#events.push(e);
    }
    return void 0;
  }
  async send(input, mode) {
    if (this.#exited) throw new Error("Claude Code is not running");
    const message = toSdkUserMessage(input, mode);
    for (; ; ) {
      const ready = this.#ready;
      await Promise.race([ready.catch(() => void 0), this.#readyReplaced]);
      if (ready === this.#ready) break;
    }
    if (this.#exited) throw new Error("Claude Code is not running");
    this.#forkGuard?.push(message);
    this.#mapper.noteSlashCommand(slashCommandOf(input));
    this.#tracker.sent(input.id);
    this.#input.push(message);
  }
  /** A user answer that interrupts the turn (reject on the main agent): the next error result is a stop. */
  noteInterruptRequested() {
    this.#mapper.noteInterruptRequested();
  }
  async interrupt(opts) {
    if (this.#exited) return { cancelledInputIds: [] };
    this.#mapper.noteInterruptRequested();
    const call = this.#q.interrupt;
    const receipt = await call(opts?.cancelQueued ? { cancelQueued: true } : void 0);
    const cancelled = Array.isArray(receipt?.cancelled) ? receipt.cancelled : [];
    return { cancelledInputIds: this.#tracker.cancel(cancelled) };
  }
  async forceStop() {
    this.#asked ??= "force-stopped";
    this.#input.end();
    this.#query.close();
    this.#init.killGroup?.();
    await this.#pump;
  }
  async dispose() {
    this.#asked ??= "disposed";
    this.#mapper.workflows.dispose();
    this.#input.end();
    this.#query.close();
    await this.#pump;
  }
  #makeControls() {
    const q = this.#q;
    const controls = this.#baseControls();
    if (hasControl(q, "askSideQuestion"))
      controls.askSideQuestion = async (question, history, signal) => {
        const ask = q.askSideQuestion;
        const opts = { signal };
        const wire = sideHistoryWire(history);
        if (wire.length > 0) opts.history = wire;
        try {
          return toSideAnswer(await ask.call(q, question, opts));
        } catch (e) {
          if (signal.aborted) return null;
          if (isUnsupported(e)) {
            this.capabilities.sideQuestions = false;
            throw new Error("this Claude Code version cannot answer side questions (/btw)", { cause: e });
          }
          throw e;
        }
      };
    if (hasControl(q, "mcpServerStatus"))
      controls.mcpStatus = async () => {
        const r = await optionalControl(q, "mcpServerStatus");
        if (r === void 0) throw new Error("this Claude Code version cannot report its MCP servers");
        return toMcpServerList(r);
      };
    if (hasControl(q, "reconnectMcpServer"))
      controls.mcpReconnect = async (name2) => {
        await this.#required("reconnectMcpServer", "reconnect an MCP server", name2);
      };
    if (hasControl(q, "toggleMcpServer"))
      controls.mcpToggle = async (name2, enabled) => {
        await this.#required("toggleMcpServer", "turn an MCP server on or off", name2, enabled);
        return { note: MCP_TOGGLE_NOTE };
      };
    if (hasControl(q, "mcpAuthenticate"))
      controls.mcpAuthenticate = async (name2) => toMcpAuthStart(await this.#required("mcpAuthenticate", "sign in to an MCP server", name2));
    if (hasControl(q, "mcpSubmitOAuthCallbackUrl"))
      controls.mcpSubmitAuthCallback = async (name2, callbackUrl) => {
        await this.#required("mcpSubmitOAuthCallbackUrl", "finish an MCP sign-in", name2, callbackUrl);
      };
    return controls;
  }
  /** Call a control this CLI must support; an older CLI's refusal becomes a plain error (D9). */
  async #required(name2, what, ...args) {
    const fn = this.#q[name2];
    if (typeof fn !== "function") throw new Error(`this Claude Code version cannot ${what}`);
    try {
      return await fn(...args);
    } catch (e) {
      if (isUnsupported(e)) throw new Error(`this Claude Code version cannot ${what}`, { cause: e });
      throw e;
    }
  }
  #baseControls() {
    const q = this.#q;
    return {
      // D30: the terminal app's "Restore code" (and its preview), on this process. Offered only
      // when the process keeps checkpoints (D16); the conversation is not touched.
      ...this.capabilities.fileRewind ? {
        rewindFiles: async (inputId, opts) => this.#rewindFiles(inputId, opts?.dryRun === true)
      } : {},
      stopTask: async (taskId) => {
        const run = this.#mapper.workflows.runOfAgent(taskId);
        if (run !== void 0)
          throw new Error("Claude Code cannot stop one agent of a workflow. Stop the whole workflow instead.");
        if (this.#mapper.workflows.isRun(taskId)) this.#mapper.workflows.noteStopRequested(taskId);
        await q.stopTask(taskId);
      },
      // D38: the CLI's `status.permissionMode` frame that follows is the truth; nothing here
      // reports a mode. Refused before the call: an unknown id, and bypass when this process
      // cannot bypass (the CLI would refuse it with "not launched with …").
      setPermissionMode: async (mode) => {
        const ids = this.#init.modeIds;
        if (ids && !ids.includes(mode)) throw new Error(`unknown permission mode: ${mode}`);
        if (mode === "bypassPermissions" && !this.canBypass)
          throw new Error(
            'Bypass permissions is not available in this Claude Code process: it was started without the plugin option "Allow bypass permissions mode" (the same as `claude --allow-dangerously-skip-permissions`) and not in bypass mode. Turn the option on; it applies when Claude Code starts again.'
          );
        if (this.#asks.mode === void 0 && this.#init.startMode)
          this.#asks.seedStartMode(await this.#init.startMode());
        this.#remember("mode", () => q.setPermissionMode(mode));
        await q.setPermissionMode(mode);
      },
      setModel: async (model) => {
        this.#remember("model", () => q.setModel(model));
        await q.setModel(model);
      },
      setEffort: async (effortId) => {
        const apply2 = () => q.applyFlagSettings.call(q, effortFlags(effortId));
        this.#remember("effort", apply2);
        await apply2();
      },
      // D37: the terminal app's `/effort ultracode on|off` (and Tab in its effort slider): on or
      // off for this session, effort unchanged. The CLI refuses it when unavailable.
      setUltracode: async (on) => {
        const apply2 = () => q.applyFlagSettings.call(q, { ultracode: on });
        this.#remember("ultracode", apply2);
        await apply2();
      },
      // The CLI's own report (`getSettings().applied`, undeclared fields, D9). Read-only.
      effortState: async () => {
        const r = await optionalControl(q, "getSettings");
        if (r === void 0) throw new Error("this Claude Code version cannot report its settings");
        const applied = r.applied ?? {};
        const state = { ultracode: applied.ultracode === true };
        if (typeof applied.effort === "string") state.effort = applied.effort;
        if (typeof applied.ultracodeRequested === "boolean") state.ultracodeRequested = applied.ultracodeRequested;
        if (typeof applied.ultracodeAvailable === "boolean") state.ultracodeAvailable = applied.ultracodeAvailable;
        return state;
      },
      models: async () => {
        const list = await q.supportedModels();
        return list.map((m) => {
          const info = {
            value: m.value,
            displayName: m.displayName
          };
          if (m.description) info.description = m.description;
          const efforts = m.supportedEffortLevels;
          if (Array.isArray(efforts)) info.efforts = efforts.map(String);
          const auto = m.supportsAutoMode;
          if (typeof auto === "boolean") info.supportsAutoMode = auto;
          return info;
        });
      },
      agents: async () => {
        const list = await q.supportedAgents();
        return list.map((a) => {
          const info = { name: a.name };
          if (a.description) info.description = a.description;
          if (typeof a.model === "string" && a.model !== "") info.model = a.model;
          return info;
        });
      },
      // R7.1, D52: the CLI's own list (the latest `commands_changed` push, SDK/sdk.mjs), with
      // the `init` skill and terminal-only names marked. Names are kept byte for byte.
      commands: async () => this.#mapper.commands.rows(await q.supportedCommands()),
      // R7.5: the `init` skill names (or the `/context` skill rows before `init`) with their
      // command rows. The context read is 'summary': no token-count calls, no model turn (M5).
      skills: async () => {
        const catalog = this.#mapper.commands;
        const commands = catalog.rows(await q.supportedCommands());
        let fromContext;
        try {
          const r = await optionalControl(q, "getContextUsage", { detail: "summary" });
          if (r !== void 0) fromContext = parseContextUsage(r).details;
        } catch (e) {
          this.#init.debug?.("skills: getContextUsage failed", String(e?.message ?? e));
        }
        return skillList(catalog, commands, fromContext?.skills);
      },
      // The end of a background shell or Monitor output, as the TUI's /tasks view reads it
      // (undeclared `getTaskOutput`, D9; live M3 probe B). Read-only, no model turn.
      taskOutput: async (taskId) => {
        if (this.#mapper.workflows.isRun(taskId) || this.#mapper.workflows.isAgent(taskId))
          throw new Error(
            "Claude Code keeps task output only for background shells and monitors; a workflow shows its agents instead"
          );
        const r = await optionalControl(q, "getTaskOutput", taskId);
        if (r === void 0) throw new Error("this Claude Code version cannot read task output");
        const out = {
          output: typeof r.output === "string" ? r.output : "",
          totalBytes: typeof r.total_bytes === "number" ? r.total_bytes : 0,
          truncated: r.truncated === true
        };
        return out;
      },
      // D59: Claude's own breakdown (`/context`). 'summary' makes no token-count calls.
      contextUsage: async (detail) => {
        const r = await optionalControl(q, "getContextUsage", { detail });
        if (r === void 0) throw new Error("this Claude Code version cannot report its context usage");
        const out = parseContextUsage(r);
        this.#mapper.usage.contextReport(out);
        return out;
      },
      // D58, D60: totals, cost label, auth and plan limits. The usage control is experimental
      // (its name says so); without it the snapshot holds what the stream reported.
      usageSnapshot: async () => {
        const usage = this.#mapper.usage;
        const r = await optionalControl(q, USAGE_CONTROL, { skipBehaviors: true });
        if (r !== void 0 && !this.#exited) for (const e of usage.usageControl(r)) this.#events.push(e);
        return usage.snapshot();
      }
    };
  }
};
var newRequestId = () => randomUUID();

// packages/backend-claude/src/spawn.ts
import { spawn as nodeSpawn2 } from "node:child_process";

// packages/backend-claude/src/orphan-guard.ts
import { spawn as nodeSpawn } from "node:child_process";
var ORPHAN_GUARD_SCRIPT = `
const c = JSON.parse(process.env.DSH_RAW_AGENT_GUARD || '{}');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
let done = false;
const quit = () => { if (done) return; done = true; process.exit(0); };
const target = () => (c.group ? -c.cli : c.cli);
const endCli = () => {
  if (done) return;
  done = true;
  if (!alive(c.cli)) process.exit(0);
  try {
    if (c.win) require('child_process').spawnSync('taskkill', ['/PID', String(c.cli), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(target(), 'SIGTERM');
  } catch (e) {}
  if (c.win) process.exit(0);
  setTimeout(() => { try { process.kill(target(), 'SIGKILL'); } catch (e) {} process.exit(0); }, c.grace);
};
process.stdin.on('data', (d) => { if (String(d).indexOf('stop') >= 0) quit(); });
process.stdin.on('end', endCli);
process.stdin.on('error', endCli);
process.stdin.resume();
setInterval(() => {
  if (!alive(c.cli)) quit();
  else if (!c.win && process.ppid !== c.host) endCli();
  else if (!alive(c.host)) endCli();
}, c.poll);
`;
function guardSettings(o) {
  const platform = o.platform ?? process.platform;
  return {
    cli: o.cliPid,
    host: process.pid,
    group: platform !== "win32",
    win: platform === "win32",
    poll: o.pollMs ?? 2e3,
    grace: o.graceMs ?? 3e3
  };
}
function startOrphanGuard(o) {
  const settings = guardSettings(o);
  const env = { DSH_RAW_AGENT_GUARD: JSON.stringify(settings) };
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR"])
    if (process.env[k] !== void 0) env[k] = process.env[k];
  let child;
  try {
    child = (o.spawn ?? nodeSpawn)(o.execPath ?? process.execPath, ["-e", ORPHAN_GUARD_SCRIPT], {
      stdio: ["pipe", "ignore", "ignore"],
      env,
      // Its own group on POSIX, so a signal to DSH's group does not take the watcher with it.
      detached: !settings.win,
      windowsHide: true
    });
  } catch (error) {
    o.onError?.(error);
    return { pid: void 0, stop() {
    } };
  }
  child.on("error", (error) => o.onError?.(error));
  child.stdin?.on("error", () => {
  });
  child.unref();
  child.stdin?.unref?.();
  let stopped = false;
  return {
    get pid() {
      return child.pid;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.stdin?.end("stop\n");
      } catch {
      }
    }
  };
}

// packages/backend-claude/src/spawn.ts
var STDERR_KEEP_BYTES = 16 * 1024;
function createSpawner(ourEnv, platform = process.platform, options = {}) {
  let record;
  let current2;
  const spawnFn = (o) => {
    const env = restoreSdkDeletedVars(o.env, ourEnv);
    const child = (options.spawn ?? nodeSpawn2)(o.command, o.args, {
      cwd: o.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: o.signal,
      windowsHide: true,
      // Own process group on POSIX (D8). The SDK closes stdin to end the CLI; we do not unref.
      detached: platform !== "win32"
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > STDERR_KEEP_BYTES * 2) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });
    record = { pid: child.pid, command: o.command, args: [...o.args], env };
    let guard2;
    if (options.orphanGuard !== false && child.pid !== void 0) {
      const g = { ...options.guard, cliPid: child.pid, platform };
      guard2 = startOrphanGuard(g);
    }
    let settle;
    const own = { exit: new Promise((resolve) => settle = resolve) };
    {
      let done = false;
      const finish = (code, signal) => {
        if (done) return;
        done = true;
        guard2?.stop();
        const info = { code, signal, stderr: stderr.slice(-STDERR_KEEP_BYTES) };
        own.exited = info;
        settle(info);
      };
      child.once("close", (code, signal) => finish(code, signal));
      child.once("exit", (code, signal) => setTimeout(() => finish(code, signal), 200));
      child.once("error", () => finish(child.exitCode, child.signalCode));
    }
    current2 = own;
    return child;
  };
  return {
    spawn: spawnFn,
    get record() {
      return record;
    },
    expectNew() {
      current2 = void 0;
    },
    async exitInfo(waitMs2 = 1e3) {
      const c = current2;
      if (!c) return void 0;
      if (c.exited) return c.exited;
      const exit = c.exit;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(void 0), waitMs2);
      });
      try {
        return await Promise.race([exit, timeout]);
      } finally {
        if (timer !== void 0) clearTimeout(timer);
      }
    },
    killGroup(signal = "SIGTERM") {
      const pid = record?.pid;
      if (pid === void 0) return;
      try {
        if (platform === "win32") process.kill(pid, signal);
        else process.kill(-pid, signal);
      } catch {
      }
    }
  };
}

// packages/backend-claude/src/start-options.ts
var ALLOW_BYPASS_OPTION = "allowDangerouslySkipPermissions";
function hasEnv(env, name2) {
  const upper = name2.toUpperCase();
  return Object.keys(env).some((k) => k.toUpperCase() === upper);
}
function buildStartOptions(input) {
  const o = {
    pathToClaudeCodeExecutable: input.executablePath,
    cwd: input.cwd,
    env: input.env,
    // Omitting systemPrompt sends an empty prompt; the preset with no append is the CLI's own (rule 3).
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    canUseTool: input.canUseTool,
    onElicitation: input.onElicitation,
    includePartialMessages: true,
    perTaskStopAffordance: true,
    forwardSubagentText: true,
    spawnClaudeCodeProcess: input.spawn,
    abortController: input.abortController
  };
  if (!hasEnv(input.env, "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT")) {
    o.toolConfig = { askUserQuestion: { previewFormat: "markdown" } };
  }
  if (input.fileCheckpointing) o.enableFileCheckpointing = true;
  if (input.userOptions[ALLOW_BYPASS_OPTION] === true) o.allowDangerouslySkipPermissions = true;
  if (input.trustAccepted) o.workspaceTrust = { accepted: true, directory: input.trustAccepted.directory };
  const start = input.start;
  switch (start.kind) {
    case "new":
      if (start.sessionId !== void 0) o.sessionId = start.sessionId;
      if (start.mainAgent !== void 0) o.agent = start.mainAgent;
      break;
    case "resume":
      o.resume = start.sessionId;
      if (start.mainAgent !== void 0) o.agent = start.mainAgent;
      break;
    case "fork":
      o.resume = start.fromSessionId;
      o.forkSession = true;
      if (start.newSessionId !== void 0) o.sessionId = start.newSessionId;
      if (start.atChainId !== void 0) o.resumeSessionAt = start.atChainId;
      if (start.mainAgent !== void 0) o.agent = start.mainAgent;
      if (start.atChainId !== void 0 && input.resumeDropsTurn !== void 0)
        o.resumeDropsTurn = input.resumeDropsTurn;
      break;
  }
  return o;
}

// packages/backend-claude/src/settings-defaults.ts
function parseSettingsText(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else out += text[i++];
  }
  try {
    const v = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
  } catch {
    return void 0;
  }
}
var str2 = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : void 0;
var obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
function readSettingsDefaults(files, readText, env) {
  const order = ["local", "project", "user"];
  const parsed = order.map((scope) => files.find((f) => f.scope === scope)).filter((f) => f !== void 0).map((f) => {
    const text = readText(f.path);
    return { scope: f.scope, json: text === void 0 ? void 0 : parseSettingsText(text) };
  });
  const out = { sources: {} };
  const fromEnv = (name2) => {
    const direct = str2(env[name2]);
    if (direct !== void 0) return { value: direct, source: "env" };
    for (const p of parsed) {
      const v = str2(obj(p.json?.env)?.[name2]);
      if (v !== void 0) return { value: v, source: `${p.scope} env` };
    }
    return void 0;
  };
  const fromFiles = (pick) => {
    for (const p of parsed) {
      const v = p.json ? str2(pick(p.json)) : void 0;
      if (v !== void 0) return { value: v, source: p.scope };
    }
    return void 0;
  };
  const model = fromEnv("ANTHROPIC_MODEL") ?? fromFiles((j) => j.model);
  if (model) {
    out.model = model.value;
    out.sources.model = model.source;
  }
  const effort = fromEnv("CLAUDE_CODE_EFFORT_LEVEL") ?? fromFiles((j) => j.effortLevel);
  if (effort) {
    out.effort = effort.value;
    out.sources.effort = effort.source;
  }
  const mode = fromFiles((j) => obj(j.permissions)?.defaultMode);
  if (mode) {
    out.permissionMode = mode.value;
    out.sources.permissionMode = mode.source;
  }
  const keys = settingsKeySources(parsed);
  if (keys.length > 0) out.keys = keys;
  return out;
}
function settingsKeySources(parsed) {
  const map = /* @__PURE__ */ new Map();
  for (const p of parsed) {
    if (!p.json) continue;
    for (const [key, value] of Object.entries(p.json)) {
      if (key === "$schema") continue;
      const e = map.get(key) ?? { scopes: [], objects: 0 };
      e.scopes.push(p.scope);
      if (value !== null && typeof value === "object") e.objects++;
      map.set(key, e);
    }
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, e]) => {
    const k = { key, scopes: e.scopes };
    if (e.scopes.length > 1 && e.objects > 1) k.merged = true;
    return k;
  });
}

// packages/backend-claude/src/trust.ts
import * as path5 from "node:path";
var TRUST_QUESTION = Object.freeze({
  title: "Accessing workspace:",
  body: "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here.",
  acceptLabel: "Yes, I trust this folder",
  declineLabel: "No, exit"
});
var UNTRUSTED_EFFECT = "the project's permission rules (.claude/settings.json `permissions`) are ignored";
function repositoryRoot(dir, deps) {
  const p = deps.platform === "win32" ? path5.win32 : path5.posix;
  let d = dir;
  for (; ; ) {
    if (deps.exists(p.join(d, ".git"))) return d;
    const up = p.dirname(d);
    if (up === d) return void 0;
    d = up;
  }
}
function readTrustState(cwd, deps) {
  const p = deps.platform === "win32" ? path5.win32 : path5.posix;
  const directory = deps.realpath(cwd);
  const root = repositoryRoot(directory, deps);
  const base = { state: "unknown", directory };
  if (root !== void 0) base.root = root;
  if (deps.env.CLAUDE_CODE_SANDBOXED) return { ...base, state: "trusted", trustedBy: "env:CLAUDE_CODE_SANDBOXED" };
  const configPath = claudeGlobalConfigPath(deps.env, deps.homedir, deps.platform);
  const text = deps.readText(configPath);
  if (text === void 0 && !deps.exists(configPath))
    return { ...base, state: "untrusted", question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  if (text === void 0) return { ...base, question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  let projects;
  try {
    const json3 = JSON.parse(text);
    projects = json3.projects !== null && typeof json3.projects === "object" ? json3.projects : {};
  } catch {
    return { ...base, question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  }
  const norm2 = (d2) => deps.platform === "win32" ? d2.replace(/\\/g, "/") : d2;
  const accepted = (d2) => projects[d2]?.hasTrustDialogAccepted === true || projects[norm2(d2)]?.hasTrustDialogAccepted === true;
  let d = directory;
  for (; ; ) {
    if (accepted(d)) return { ...base, state: "trusted", trustedBy: d };
    if (root !== void 0 && d === root) break;
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { ...base, state: "untrusted", question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
}

// packages/backend-claude/src/transcripts.ts
import * as path6 from "node:path";
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
var SLUG_LIMIT = 200;
var MAIN_AGENT_SCAN_BYTES = 4 * 1024 * 1024;
function transcriptPaths(sessionId, cwd, deps) {
  const p = deps.platform === "win32" ? path6.win32 : path6.posix;
  const projects = p.join(claudeConfigDir(deps.env, deps.homedir, deps.platform), "projects");
  const out = [];
  for (const dir of /* @__PURE__ */ new Set([cwd, deps.realpath(cwd)])) {
    const slug = projectSlug(dir);
    if (slug.length <= SLUG_LIMIT) out.push(p.join(projects, slug, `${sessionId}.jsonl`));
    else {
      const prefix = `${slug.slice(0, SLUG_LIMIT)}-`;
      for (const name2 of deps.listDir(projects))
        if (name2.startsWith(prefix)) out.push(p.join(projects, name2, `${sessionId}.jsonl`));
    }
  }
  return out;
}
function firstAgentSetting(text) {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.type === "agent-setting") {
      const name2 = str(entry.agentSetting);
      if (name2 !== void 0 && name2 !== "") return name2;
      continue;
    }
    if (entry.type === "user" || entry.type === "assistant") return void 0;
  }
  return void 0;
}
function readSessionMainAgent(sessionId, cwd, deps) {
  for (const file of transcriptPaths(sessionId, cwd, deps)) {
    const head = deps.readHead(file, MAIN_AGENT_SCAN_BYTES);
    if (head !== void 0) return firstAgentSetting(head);
  }
  return void 0;
}
function transcriptEvents(ref, messages, at) {
  const kids = new ChildAgents();
  kids.adopt(ref.id, ref.id);
  const out = [];
  for (const m of messages) {
    const wire = {
      type: m.type,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id ?? `transcript:${ref.id}`,
      agent_id: ref.id
    };
    if (m.uuid !== void 0) wire.uuid = m.uuid;
    if (m.type === "assistant") kids.assistant(wire, at, out);
    else if (m.type === "user") kids.user(wire, at, out);
  }
  return out.filter(
    (e) => e.type !== "agent-start" && e.type !== "agent-end" && e.type !== "team-message" && (!("agent" in e) || e.agent === void 0 || e.agent.kind === "child" && e.agent.id === ref.id)
  );
}

// packages/backend-claude/src/session-tail.ts
var MAIN4 = Object.freeze({ kind: "main" });
function userText3(entry) {
  const msg = entry.message;
  if (!isObject(msg)) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
function isReminder(text) {
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}
function notificationSummary(text) {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  const s = m?.[1]?.trim();
  return s ? s.slice(0, 200) : void 0;
}
function sessionTail(transcript, afterUuid, at) {
  const out = {
    found: false,
    events: [],
    prompts: [],
    notes: [],
    orphanResults: 0
  };
  const chain = /* @__PURE__ */ new Set();
  const advertised = /* @__PURE__ */ new Set();
  let pending;
  const flush = () => {
    if (!pending) return;
    if (pending.blocks.length > 0) {
      out.events.push({ type: "step-start", agent: MAIN4, stepId: pending.stepId, at });
      out.events.push(pending);
      for (const b of pending.blocks) if (b.type === "tool-call") advertised.add(b.id);
    }
    pending = void 0;
  };
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(e)) continue;
    const uuid = str(e.uuid);
    if (!out.found) {
      if (uuid !== void 0 && uuid === afterUuid) {
        out.found = true;
        chain.add(uuid);
        out.lastChainId = uuid;
      }
      continue;
    }
    if (uuid === void 0 || e.isSidechain === true) continue;
    const parent = str(e.parentUuid) ?? (e.subtype === "compact_boundary" ? str(e.logicalParentUuid) : void 0);
    if (parent === void 0 || !chain.has(parent)) continue;
    chain.add(uuid);
    out.lastChainId = uuid;
    if (e.type === "assistant") {
      const message2 = isObject(e.message) ? e.message : {};
      const stepId = str(message2.id) ?? uuid;
      if (pending && pending.stepId !== stepId) flush();
      const model = canonicalModel(str(message2.model));
      if (!pending) {
        pending = { type: "step-message", agent: MAIN4, stepId, blocks: [], final: true };
        if (model === "<synthetic>") pending.synthetic = true;
        else if (model !== void 0) pending.model = model;
      }
      const content = Array.isArray(message2.content) ? message2.content : [];
      for (const raw of content) {
        const b = convertBlock(raw);
        if (b === void 0) continue;
        if (b.type === "reasoning" && b.text === "") continue;
        if (b.type === "tool-call" && (advertised.has(b.id) || pending.blocks.some((x) => x.type === "tool-call" && x.id === b.id)))
          continue;
        pending.blocks.push(b);
      }
      pending.lastChainId = uuid;
      continue;
    }
    if (e.type === "attachment") {
      const a = e.attachment;
      if (isObject(a) && a.type === "queued_command") out.notes.push("a message queued in the agent");
      continue;
    }
    if (e.type !== "user") continue;
    flush();
    const message = isObject(e.message) ? e.message : {};
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (!isObject(b) || b.type !== "tool_result") continue;
        const callId = str(b.tool_use_id);
        if (callId === void 0) continue;
        if (!advertised.has(callId)) {
          out.orphanResults++;
          continue;
        }
        out.events.push({
          type: "tool-result",
          agent: MAIN4,
          callId,
          isError: b.is_error === true,
          content: convertToolResultContent(b.content),
          chainId: uuid
        });
      }
    }
    const text = userText3(e);
    if (text.trim() === "" || e.isMeta === true || isReminder(text) || text.startsWith("[Request interrupted"))
      continue;
    if (e.queueTranscriptOnly === true) continue;
    const origin = isObject(e.origin) ? str(e.origin.kind) : void 0;
    if (origin === "task-notification" || text.trimStart().startsWith("<task-notification>")) {
      const s = notificationSummary(text);
      out.notes.push(s ? `a report from a background task (${s})` : "a report from a background task");
      continue;
    }
    if (origin !== void 0 && origin !== "human") {
      out.notes.push(`a ${origin} message`);
      continue;
    }
    out.prompts.push(text);
  }
  flush();
  return out;
}

// packages/backend-claude/src/input-scan.ts
import { open, readdir, readFile, stat } from "node:fs/promises";
import * as path7 from "node:path";
var INPUT_SCAN_FILES = 32;
var INPUT_HEAD_BYTES = 128 * 1024;
var nodeInputScanDeps = {
  async readText(p) {
    try {
      return await readFile(p, "utf8");
    } catch {
      return void 0;
    }
  },
  async readHead(p, maxBytes) {
    let fh;
    try {
      fh = await open(p, "r");
      const buf = Buffer.alloc(Math.max(0, maxBytes));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      return void 0;
    } finally {
      await fh?.close().catch(() => void 0);
    }
  },
  async listDir(p) {
    try {
      return await readdir(p);
    } catch {
      return [];
    }
  },
  async mtime(p) {
    try {
      return (await stat(p)).mtimeMs;
    } catch {
      return 0;
    }
  },
  async size(p) {
    try {
      return (await stat(p)).size;
    } catch {
      return void 0;
    }
  }
};
function sessionOfInput(text, inputId, file) {
  const needle = `"uuid":"${inputId}"`;
  if (!text.includes(needle)) return void 0;
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "user" && d.uuid === inputId)
        return typeof d.sessionId === "string" ? d.sessionId : path7.basename(file, ".jsonl");
    } catch {
    }
  }
  return void 0;
}
async function findSessionHoldingInput(inputId, preferred, dirs, deps) {
  if (preferred !== void 0) {
    const size = await deps.size(preferred);
    if (size === void 0 || size <= FORK_SCAN_LIMIT_BYTES) {
      const text = await deps.readText(preferred);
      const hit = text === void 0 ? void 0 : sessionOfInput(text, inputId, preferred);
      if (hit !== void 0) return hit;
    }
  }
  for (const dir of dirs) {
    const files = (await deps.listDir(dir)).filter((n) => n.endsWith(".jsonl")).map((n) => path7.join(dir, n)).filter((p) => p !== preferred);
    const dated = await Promise.all(files.map(async (p) => ({ p, at: await deps.mtime(p) })));
    dated.sort((a, b) => b.at - a.at);
    for (const { p } of dated.slice(0, INPUT_SCAN_FILES)) {
      const head = await deps.readHead(p, INPUT_HEAD_BYTES);
      const hit = head === void 0 ? void 0 : sessionOfInput(head, inputId, p);
      if (hit !== void 0) return hit;
    }
  }
  return void 0;
}

// packages/backend-claude/src/factory.ts
var CLAUDE_KIND = "claude-code";
var ID_NAMESPACE = "5f0c3b9e-6f1d-5a8e-9c42-7d2e1a4b8c60";
var CLAUDE_STATIC_CAPABILITIES = Object.freeze({
  ids: "host-chosen",
  resume: true,
  fork: "at-chain-point",
  userOptions: [
    {
      key: ALLOW_BYPASS_OPTION,
      type: "boolean",
      label: "Allow bypass permissions mode (same as `claude --allow-dangerously-skip-permissions`)",
      description: "Off by default. Lets you switch a session to bypass permissions (no further prompts). As with the terminal flag, plan mode then no longer asks before edits. Applies when Claude Code starts.",
      default: false
    }
  ],
  needsProcess: ["agents", "commands", "side-question", "mcp", "context", "usage", "task-actions"],
  sideQuestionCommand: "btw",
  mcpCommand: "mcp",
  rewindCommand: "rewind",
  // Labels are ours (short picker names); descriptions are the CLI's own (MODE_DESCRIPTIONS).
  // Risk (chip colour): dontAsk is `caution` like auto: it never stops to ask, so a pre-approved
  // tool runs at once (the rest is denied, not asked).
  permissionModes: [
    {
      id: "default",
      label: "Ask before edits",
      shortLabel: "Default",
      risk: "neutral",
      description: MODE_DESCRIPTIONS.default
    },
    { id: "acceptEdits", label: "Accept edits", risk: "caution", description: MODE_DESCRIPTIONS.acceptEdits },
    { id: "plan", label: "Plan mode", shortLabel: "Plan", risk: "plan", description: MODE_DESCRIPTIONS.plan },
    { id: "auto", label: "Auto", risk: "caution", description: MODE_DESCRIPTIONS.auto },
    { id: "dontAsk", label: "Don't ask", risk: "caution", description: MODE_DESCRIPTIONS.dontAsk },
    {
      id: "bypassPermissions",
      label: "Bypass permissions",
      shortLabel: "Bypass",
      risk: "danger",
      description: MODE_DESCRIPTIONS.bypassPermissions,
      requiresOption: ALLOW_BYPASS_OPTION,
      requiresNote: "as the CLI needs --dangerously-skip-permissions"
    }
  ],
  // The TUI's Shift+Tab ring (CLI 2.1.318 binary fn `uhn`): default → acceptEdits → plan →
  // bypassPermissions (when available) → auto (when available) → default; dontAsk → default.
  permissionModeCycle: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
  mainAgentPicker: "new-session-only",
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
    { id: "max", label: "Max" },
    // D37: the TUI's `/effort ultracode`: a session mode at any effort level (CLI 2.1.318 binary:
    // "Ultracode (any effort level, this session only)", "Enable ultracode for the session:
    // standing dynamic-workflow orchestration at any effort level").
    {
      id: "ultracode",
      label: "Ultracode",
      kind: "mode",
      description: "Standing dynamic-workflow orchestration, at any effort level. This session only."
    }
  ],
  steer: "native"
});
function questionPreviewFormat(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT");
  return key !== void 0 && env[key]?.trim().toLowerCase() === "html" ? "html" : "markdown";
}
var nodeBinaryDeps = (env) => ({
  env,
  platform: process.platform,
  homedir: homedir(),
  isExecutable(p) {
    try {
      if (!statSync2(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText(p) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return void 0;
    }
  }
});
function readFileHead(p, maxBytes) {
  let fd;
  try {
    fd = openSync2(p, "r");
    const buf = Buffer.alloc(Math.max(0, maxBytes));
    const n = readSync2(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return void 0;
  } finally {
    if (fd !== void 0) closeSync2(fd);
  }
}
function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
var nodeFs = {
  readText(p) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return void 0;
    }
  },
  realpath(p) {
    try {
      return realpathSync2(p);
    } catch {
      return p;
    }
  },
  exists(p) {
    return existsSync(p);
  },
  size(p) {
    try {
      return statSync2(p).size;
    } catch {
      return void 0;
    }
  }
};
function createClaudeFactory(factoryOptions = {}) {
  const readEnv = () => buildClaudeEnv(factoryOptions.env ? factoryOptions.env() : process.env).env;
  const fs = factoryOptions.fs ?? nodeFs;
  const home = () => factoryOptions.homedir ?? homedir();
  const readDefaults = async (cwd) => {
    const env = readEnv();
    const files = claudeConfigFiles(cwd, { env, platform: process.platform, homedir: home() });
    return readSettingsDefaults(files, (p) => fs.readText(p), env);
  };
  const seam = factoryOptions.fs;
  const inputScanDeps = seam ? {
    ...nodeInputScanDeps,
    readText: async (p) => seam.readText(p),
    readHead: async (p, n) => seam.readHead ? seam.readHead(p, n) : seam.readText(p)?.slice(0, n),
    ...seam.listDir ? { listDir: async (p) => seam.listDir(p) } : {},
    ...seam.size ? { size: async (p) => seam.size(p) } : {}
  } : nodeInputScanDeps;
  const transcriptDeps = (env = readEnv()) => ({
    env,
    platform: process.platform,
    homedir: home(),
    realpath: (p) => fs.realpath(p),
    exists: (p) => fs.exists(p),
    readHead: fs.readHead ?? readFileHead,
    listDir: fs.listDir ?? listDir
  });
  const transcriptFile = (sessionId, cwd, env) => transcriptPaths(sessionId, cwd, transcriptDeps(env)).find((p) => fs.exists(p));
  const validatedDropsTurn = (start, cwd, env) => {
    const hint = start.dropsTurnHint;
    if (start.atChainId === void 0 || hint === void 0) return void 0;
    const file = transcriptFile(start.fromSessionId, cwd, env);
    if (file === void 0) return void 0;
    const size = (fs.size ?? nodeFs.size)(file);
    if (size !== void 0 && size > FORK_SCAN_LIMIT_BYTES) return void 0;
    const text = fs.readText(file);
    if (text === void 0) return void 0;
    const check = checkDropsTurn(text, start.atChainId, hint);
    factoryOptions.debug?.("fork cut check", check);
    return check.validated ? hint : void 0;
  };
  return {
    kind: CLAUDE_KIND,
    displayName: "Claude Code",
    staticCapabilities: CLAUDE_STATIC_CAPABILITIES,
    sessionIdFor: (hostSessionId) => uuidv5(ID_NAMESPACE, `session:${hostSessionId}`),
    inputIdFor: (hostMessageId) => uuidv5(ID_NAMESPACE, `input:${hostMessageId}`),
    // No-process reads (D83). None starts a process or writes a file.
    async configFiles(cwd) {
      return claudeConfigFiles(cwd, { env: readEnv(), platform: process.platform, homedir: home() });
    },
    maskConfig(file, text) {
      return maskClaudeSettings(file, text);
    },
    async settingsDefaults(cwd) {
      return readDefaults(cwd);
    },
    async trustState(cwd) {
      return readTrustState(cwd, { env: readEnv(), platform: process.platform, homedir: home(), ...fs });
    },
    // D15 (r4): the agent the session was started with, so a resume passes the same `agent`.
    async sessionMainAgent(sessionId, cwd) {
      return readSessionMainAgent(sessionId, cwd, transcriptDeps());
    },
    // D28 (r3): a resume candidate is real only when the CLI wrote its transcript (D5 derived
    // ids, a /clear id after a restart, D70). A plain file check, as `getSessionInfo` does.
    async sessionExists(sessionId, cwd) {
      return transcriptFile(sessionId, cwd) !== void 0;
    },
    // D28, D70 (M7 live): after `/clear` the CLI runs under a new id whose transcript starts with
    // the typed command (its `uuid` is our input id); the host has no step to bind that id to.
    // A file read: the preferred transcript first, then the newest ones in the same folder.
    async sessionHoldingInput(inputId, cwd, prefer) {
      const deps = transcriptDeps();
      const preferred = prefer === void 0 ? void 0 : transcriptFile(prefer, cwd);
      const dirs = [...new Set(transcriptPaths(prefer ?? inputId, cwd, deps).map((p) => path8.dirname(p)))];
      return findSessionHoldingInput(inputId, preferred, dirs, inputScanDeps);
    },
    // M7 (R3.6): the main-thread entries past the host log's chain point, from the CLI's own
    // transcript (a file read, no process). The host shows what it never got.
    async readSessionTail(sessionId, cwd, afterChainId) {
      const empty = { events: [], prompts: [], notes: [], orphanResults: 0 };
      const file = transcriptFile(sessionId, cwd);
      if (file === void 0) return { status: "no-record", ...empty };
      const size = (fs.size ?? nodeFs.size)(file);
      if (size !== void 0 && size > FORK_SCAN_LIMIT_BYTES) return { status: "too-large", ...empty };
      const text = fs.readText(file);
      if (text === void 0) return { status: "no-record", ...empty };
      const { found, ...rest } = sessionTail(text, afterChainId, Date.now());
      return found ? { status: "found", ...rest } : { status: "no-cut", ...empty };
    },
    // D16, D30: what `open()` would decide for checkpoints, for the rewind dialog.
    async fileRewindAvailable(cwd) {
      const env = readEnv();
      return decideFileCheckpointing({
        env,
        platform: process.platform,
        homedir: home(),
        cwd,
        readText: (p) => fs.readText(p)
      }).enabled;
    },
    // D49, D50: a child's transcript (SDK `getSubagentMessages`, a file read; no process).
    async readAgentTranscript(sessionId, ref, cwd) {
      if (ref.kind !== "child") return [];
      const read = factoryOptions.subagentMessages ?? (async (sid, agentId, dir) => await (await loadSdk()).getSubagentMessages(sid, agentId, { dir }));
      return transcriptEvents(ref, await read(sessionId, ref.id, cwd), Date.now());
    },
    async open(o) {
      const bin = resolveClaudeBinary(o.userConfig.executablePath, nodeBinaryDeps(o.env));
      const { env } = buildClaudeEnv(o.env);
      const deps = nodeBinaryDeps(o.env);
      const checkpoint = decideFileCheckpointing({
        env,
        platform: process.platform,
        homedir: deps.homedir,
        cwd: o.cwd,
        readText: deps.readText
      });
      const spawner = createSpawner(env, process.platform, factoryOptions.spawner);
      const abortController = new AbortController();
      o.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      const queryFn = factoryOptions.queryFn ?? (await loadSdk()).query;
      const ref = {};
      const bypassOption = o.userConfig.options[ALLOW_BYPASS_OPTION] === true;
      const adapter = {
        handler: o.interactions,
        cliVersion: () => ref.session?.cliVersion,
        // The option, or a process that started in bypass (the user's settings), D14.
        canBypass: () => ref.session?.canBypass ?? bypassOption,
        newId: newRequestId,
        prePlanMode: () => ref.session?.asks.prePlanMode,
        agentLabel: (id) => ref.session?.agentLabel(id),
        elicitationAgent: (server) => ref.session?.asks.elicitationAgent(server),
        rememberElicitation: (eid, id) => ref.session?.asks.rememberElicitation(eid, id),
        forgetElicitation: (eid) => ref.session?.asks.forgetElicitation(eid),
        previewFormat: () => questionPreviewFormat(env),
        onInterruptingDeny: () => ref.session?.noteInterruptRequested()
      };
      if (factoryOptions.debug) {
        const debug = factoryOptions.debug;
        adapter.warn = (text) => debug("interaction", text);
      }
      const startInput = {
        executablePath: bin.path,
        cwd: o.cwd,
        env,
        start: o.start,
        userOptions: o.userConfig.options,
        fileCheckpointing: checkpoint.enabled,
        canUseTool: createCanUseTool(adapter),
        onElicitation: createOnElicitation(adapter),
        spawn: spawner.spawn,
        abortController
      };
      if (o.trustAccepted) startInput.trustAccepted = o.trustAccepted;
      let start = o.start;
      if (start.kind === "resume" && transcriptFile(start.sessionId, o.cwd, env) === void 0) {
        const fresh = { kind: "new", sessionId: start.sessionId };
        if (start.mainAgent !== void 0) fresh.mainAgent = start.mainAgent;
        factoryOptions.debug?.("resume candidate has no transcript; starting new under its id", start.sessionId);
        start = fresh;
      }
      startInput.start = start;
      let fallbackOptions;
      if (start.kind === "fork") {
        const drops = validatedDropsTurn(start, o.cwd, env);
        if (drops !== void 0) {
          const fallbackAbort = new AbortController();
          o.signal.addEventListener("abort", () => fallbackAbort.abort(), { once: true });
          fallbackOptions = buildStartOptions({ ...startInput, abortController: fallbackAbort });
          startInput.resumeDropsTurn = drops;
        }
      }
      const options = buildStartOptions(startInput);
      const sessionId = start.kind === "new" ? start.sessionId ?? newRequestId() : start.kind === "resume" ? start.sessionId : start.newSessionId ?? newRequestId();
      for (const opts of fallbackOptions ? [options, fallbackOptions] : [options]) {
        if (start.kind === "new" && start.sessionId === void 0) opts.sessionId = sessionId;
        if (start.kind === "fork" && start.newSessionId === void 0) opts.sessionId = sessionId;
      }
      const init = {
        kind: CLAUDE_KIND,
        sessionId,
        startedAs: start.kind === "new" ? "new" : start.kind === "resume" ? "resumed" : "forked",
        options,
        queryFn,
        bypassOption,
        modeIds: CLAUDE_STATIC_CAPABILITIES.permissionModes.map((m) => m.id),
        // The mode the process starts in: we pass none, so the user's settings `defaultMode`
        // (else the CLI's default). Read only when a mode is set before the CLI reported one.
        startMode: async () => {
          if (typeof options.permissionMode === "string") return options.permissionMode;
          try {
            return (await readDefaults(o.cwd)).permissionMode ?? "default";
          } catch {
            return void 0;
          }
        },
        // D8: when the CLI dies, end what is left of its process group.
        onExit: () => spawner.killGroup("SIGTERM"),
        killGroup: () => spawner.killGroup("SIGKILL"),
        // R3.6: the exit code, signal and the end of stderr for a clear exit reason.
        exitInfo: () => spawner.exitInfo(),
        newProcess: () => spawner.expectNew()
      };
      if (fallbackOptions) init.fallbackOptions = fallbackOptions;
      if (start.kind === "fork" && start.restoreFilesAt !== void 0) init.restoreFilesAt = start.restoreFilesAt;
      if (factoryOptions.debug) init.debug = factoryOptions.debug;
      init.projectsDir = path8.join(claudeConfigDir(env, deps.homedir, process.platform), "projects");
      ref.session = new ClaudeBackendSession(init);
      return ref.session;
    }
  };
}

// packages/dsh-host/src/registry.ts
var SESSIONS_SERVICE = "rawAgentSessions";
var REAP_CHECK_MS = 3e4;
var PLUGIN_MESSAGES_KEPT = 500;
var SessionRegistry = class {
  apiVersion = 1;
  #runtimes = /* @__PURE__ */ new Map();
  #pluginMessages = /* @__PURE__ */ new Map();
  #grantCheck;
  #added = /* @__PURE__ */ new Set();
  #drafts = /* @__PURE__ */ new Map();
  #opts;
  #timer;
  constructor(opts = {}) {
    this.#opts = opts;
  }
  /** The Host entry's user config getter, if it has one (D87). */
  get userConfig() {
    return this.#opts.userConfig;
  }
  get size() {
    return this.#runtimes.size;
  }
  /** The runtime of one host session, if its backend kind matches. */
  get(hostSessionId, kind) {
    const e = this.#runtimes.get(hostSessionId);
    if (!e || kind !== void 0 && e.kind !== kind) return void 0;
    return e.runtime;
  }
  set(hostSessionId, kind, runtime) {
    this.#runtimes.set(hostSessionId, { kind, runtime });
    for (const l of [...this.#added]) {
      try {
        l(hostSessionId);
      } catch {
      }
    }
  }
  /** Called with the host session id each time a runtime is registered (the services' `onEvent`). */
  onRuntime(listener) {
    this.#added.add(listener);
    return () => this.#added.delete(listener);
  }
  /**
   * D66: the Host service admitted this host message after its grant check. The agent mount (in
   * another bundle) forwards a `raw-agent-plugin` message only when it was admitted here, so a
   * message another plugin put into the inbox by itself is dropped like any DSH notice (D22).
   * In memory only: after a host restart an unsent plugin message is dropped (known gap).
   */
  admitPluginMessage(messageId, sender) {
    this.#pluginMessages.delete(messageId);
    this.#pluginMessages.set(messageId, { ...sender });
    while (this.#pluginMessages.size > PLUGIN_MESSAGES_KEPT) {
      const oldest = this.#pluginMessages.keys().next().value;
      if (oldest === void 0) break;
      this.#pluginMessages.delete(oldest);
    }
  }
  /**
   * The grant a plugin message was admitted under, if it was and that grant is still live. A
   * message whose grant the user revoked (or that left the entry config) is no longer forwarded.
   */
  pluginSender(messageId) {
    const s = this.#pluginMessages.get(messageId);
    if (!s) return void 0;
    if (!this.#grantLive(s.grantId)) {
      this.#pluginMessages.delete(messageId);
      return void 0;
    }
    return { ...s };
  }
  /**
   * Consume one admission: the message was forwarded (claimed by a turn, or claimed as a steer).
   * A later message that reuses the id (for example copied from the log) is not admitted.
   */
  takePluginMessage(messageId) {
    const s = this.pluginSender(messageId);
    this.#pluginMessages.delete(messageId);
    return s;
  }
  /** Drop one admission without forwarding it (DSH refused the message). */
  forgetPluginMessage(messageId) {
    this.#pluginMessages.delete(messageId);
  }
  /** The Host service tells the registry how to see whether a grant is still live (D66). */
  setPluginGrantCheck(check) {
    this.#grantCheck = check;
  }
  #grantLive(grantId) {
    if (!this.#grantCheck) return true;
    try {
      return this.#grantCheck(grantId) === true;
    } catch {
      return false;
    }
  }
  /** Remove and end one runtime. */
  async delete(hostSessionId) {
    const e = this.#runtimes.get(hostSessionId);
    this.#runtimes.delete(hostSessionId);
    this.#drafts.delete(hostSessionId);
    await e?.runtime.dispose();
  }
  /** The kind of one registered session (its backend factory, D80). */
  kindOf(hostSessionId) {
    return this.#runtimes.get(hostSessionId)?.kind;
  }
  /** D34: the last model list any process of this kind reported in this host run. */
  lastModels(kind) {
    let found;
    for (const e of this.#runtimes.values()) {
      if (e.kind !== kind) continue;
      const m = e.runtime.view().models;
      if (m && m.length > 0) found = m;
    }
    return found;
  }
  /**
   * D51: the last agent list a process of this kind reported for the same folder (project agents
   * differ per folder), so the main-agent picker can list agents before this session's spawn.
   */
  lastAgents(kind, cwd) {
    let found;
    for (const e of this.#runtimes.values()) {
      if (e.kind !== kind) continue;
      const v = e.runtime.view();
      if (v.cwd === cwd && v.agents && v.agents.length > 0) found = v.agents;
    }
    return found;
  }
  /**
   * The parent session and child id of one host child session (D45), so a child's own view can
   * show its row, its Stop and its asks. Only children of registry sessions are found.
   */
  findChild(childHostSessionId) {
    for (const [id, e] of this.#runtimes) {
      const child = e.runtime.view().children?.find((c) => c.hostSessionId === childHostSessionId);
      if (child) return { parentSession: id, childId: child.id };
    }
    return void 0;
  }
  state(hostSessionId) {
    return this.#runtimes.get(hostSessionId)?.runtime.state();
  }
  noteDraft(hostSessionId, draft) {
    const list = this.#drafts.get(hostSessionId) ?? [];
    list.push(draft);
    this.#drafts.set(hostSessionId, list.slice(-20));
  }
  /** Hand the returned drafts to the composer once. */
  takeDrafts(hostSessionId) {
    const list = this.#drafts.get(hostSessionId) ?? [];
    this.#drafts.delete(hostSessionId);
    return list;
  }
  /** End every idle process past the timeout (D6). Returns the host session ids it reaped. */
  async reapIdle(now = (this.#opts.now ?? Date.now)()) {
    const idleMs = this.#opts.idleReapMs?.() ?? 0;
    if (!(idleMs > 0)) return [];
    const out = [];
    for (const [id, e] of this.#runtimes) {
      if (!e.runtime.isReapable(now, idleMs)) continue;
      if (await e.runtime.reap()) out.push(id);
    }
    return out;
  }
  /** Start the periodic reaper. Returns its stop function. A check costs nothing when reaping is off. */
  startReaper() {
    this.stopReaper();
    const t = setInterval(() => void this.reapIdle().catch(() => {
    }), this.#opts.checkEveryMs ?? REAP_CHECK_MS);
    t.unref?.();
    this.#timer = t;
    return () => this.stopReaper();
  }
  stopReaper() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = void 0;
  }
  /** The Host entry goes away (DSH shutdown, plugin disable): every process ends (D75, D87). */
  async disposeAll() {
    this.stopReaper();
    const all = [...this.#runtimes.values()];
    this.#runtimes.clear();
    this.#drafts.clear();
    await Promise.all(all.map((e) => e.runtime.dispose().catch(() => {
    })));
  }
};
function isSessionRegistry(v) {
  if (v === null || typeof v !== "object") return false;
  const r = v;
  return r.apiVersion === 1 && typeof r.get === "function" && typeof r.set === "function";
}

// packages/dsh-host/src/asks.ts
var MAX_DETAIL = 600;
var MAX_TEXT = 2e4;
var MAX_INPUT_JSON = 512 * 1024;
function clip(text) {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\u2026` : text;
}
function inputSummary(input) {
  if (input === void 0 || input === null) return void 0;
  if (typeof input === "string") return clip(input);
  if (typeof input === "object") {
    const o = input;
    for (const k of ["command", "file_path", "path", "url", "pattern", "description"])
      if (typeof o[k] === "string" && o[k] !== "") return clip(o[k]);
    try {
      return clip(JSON.stringify(input));
    } catch {
      return void 0;
    }
  }
  return clip(String(input));
}
function jsonCopy(value, limit = MAX_INPUT_JSON) {
  if (value === void 0) return {};
  try {
    const text = JSON.stringify(value);
    if (text === void 0) return {};
    if (text.length > limit) return { tooLarge: true };
    return { value: JSON.parse(text) };
  } catch {
    return {};
  }
}
var DECLINE = "decline";
var KEEP_PLANNING = "keep-planning";
var TRUST_ACCEPT = "trust-accept";
var TRUST_DECLINE = "trust-decline";
var SUBMIT = "submit";
var CHAT = "chat";
var ACCEPT = "accept";
var CANCEL = "cancel";
var DISMISS = "dismiss";
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var okText = (v) => typeof v === "string" && v.trim() !== "" && v.length <= MAX_TEXT;
function feedbackError(reply, allowed) {
  if (reply.feedback === void 0) return void 0;
  if (typeof reply.feedback !== "string" || reply.feedback.length > MAX_TEXT) return "feedback must be text";
  if (!allowed && reply.feedback.trim() !== "") return "this choice takes no feedback";
  return void 0;
}
function checkQuestionReply(questions, reply, allowEmpty = false) {
  if (allowEmpty && reply.answers === void 0) reply = { ...reply, answers: {} };
  if (!isRecord(reply.answers)) return "answers must be an object keyed by question text";
  const byText = new Map(questions.map((q) => [q.question, q]));
  const answers = {};
  for (const [text, value] of Object.entries(reply.answers)) {
    const q = byText.get(text);
    if (!q) return `not a question of this ask: ${text}`;
    const labels = new Set(q.options.map((o) => o.label));
    const known = (v) => labels.has(v) || q.allowsOther;
    if (typeof value === "string") {
      if (!okText(value)) return `the answer to "${text}" is empty or too long`;
      if (!known(value)) return `"${value}" is not an option of "${text}"`;
      answers[text] = value;
    } else if (Array.isArray(value)) {
      if (!q.multiSelect) return `"${text}" takes one answer`;
      if (value.length === 0 || !value.every(okText)) return `the answers to "${text}" must be non-empty texts`;
      const unknown = value.find((v) => !known(v));
      if (unknown !== void 0) return `"${unknown}" is not an option of "${text}"`;
      answers[text] = [...value];
    } else return `the answer to "${text}" must be text or a list of texts`;
  }
  if (Object.keys(answers).length === 0 && !allowEmpty) return "answer at least one question";
  const out = { answers };
  if (reply.notes !== void 0) {
    if (!isRecord(reply.notes)) return "notes must be an object keyed by question text";
    const notes = {};
    for (const [text, note] of Object.entries(reply.notes)) {
      if (!byText.has(text)) return `not a question of this ask: ${text}`;
      if (typeof note !== "string" || note.length > MAX_TEXT) return "a note must be text";
      if (note.trim() !== "") notes[text] = note;
    }
    if (Object.keys(notes).length > 0) out.notes = notes;
  }
  return out;
}
function checkElicitationContent(schema, content) {
  if (!isRecord(content)) return "content must be an object";
  const copy = jsonCopy(content, 256 * 1024);
  if (copy.tooLarge) return "content is too large";
  if (!isRecord(copy.value)) return "content must be JSON";
  const value = copy.value;
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : void 0;
  for (const [k, v] of Object.entries(value)) {
    if (props && !Object.hasOwn(props, k)) return `not a field of this form: ${k}`;
    const plain = ["string", "number", "boolean"].includes(typeof v);
    const texts = Array.isArray(v) && v.every((x) => typeof x === "string");
    if (!plain && !texts) return `the value of ${k} must be text, a number, true/false, or a list of texts`;
  }
  const required = isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
  for (const k of required) if (typeof k === "string" && !Object.hasOwn(value, k)) return `${k} is required`;
  return value;
}
var AskDesk = class {
  #open = /* @__PURE__ */ new Map();
  #onChange;
  #now;
  #hooks;
  #seq = 0;
  constructor(onChange, now = Date.now, hooks = {}) {
    this.#onChange = onChange;
    this.#now = now;
    this.#hooks = hooks;
  }
  get size() {
    return this.#open.size;
  }
  list() {
    return [...this.#open.values()].map((e) => structuredClone(e.view));
  }
  /** The user's answer: a bare choice id (no feedback or form). */
  answer(id, choiceId) {
    return this.respond(id, { choice: choiceId }).ok;
  }
  /** The user's answer from the UI. The first answer wins; a later one gets `gone`. */
  respond(id, reply) {
    const e = this.#open.get(id);
    if (!e) return { ok: false, code: "gone", error: "that question is no longer open" };
    if (typeof reply.choice !== "string" || !e.view.choices.some((c) => c.id === reply.choice))
      return { ok: false, code: "invalid", error: "that choice is not offered" };
    const error = e.settle(reply);
    return error === void 0 ? { ok: true } : { ok: false, code: "invalid", error };
  }
  /**
   * The user pressed Stop: open asks get their Esc answer (reject / decline), as in the agent's
   * terminal app. `kinds` limits it (the trust question while the process starts); `agents`
   * limits whose asks (Stop passes `['main']`). A subagent's ask is not the turn's: Stop
   * interrupts only the main turn (rule 6), and a background agent keeps running, so its ask stays
   * open for the user. A foreground subagent's ask is dropped when the agent cancels it.
   */
  stop(kinds, agents) {
    let n = 0;
    for (const [, e] of [...this.#open]) {
      if (e.view.state === "waiting") continue;
      if (kinds && !kinds.includes(e.view.kind)) continue;
      if (agents && !agents.includes(e.view.agent)) continue;
      if (e.settle({ choice: e.view.stopChoice }) === void 0) n++;
    }
    return n;
  }
  /** The agent finished one interaction (D43: a URL elicitation completed). */
  done(id) {
    const e = this.#open.get(id);
    if (!e) return false;
    e.drop("the agent finished it");
    return true;
  }
  /** The agent withdrew one interaction (its abort signal fires too). */
  cancel(id) {
    const e = this.#open.get(id);
    if (!e) return false;
    e.drop("the ask was cancelled");
    return true;
  }
  /** The process ended: nobody waits for these answers any more. */
  dropAll() {
    for (const [, e] of [...this.#open]) e.drop("the session ended");
  }
  #remove(id, outcome) {
    const e = this.#open.get(id);
    if (!e) return;
    this.#open.delete(id);
    if (e.audited && outcome !== void 0) this.#safe(() => this.#hooks.closed?.(id, outcome));
    this.#onChange();
  }
  #safe(fn) {
    try {
      fn();
    } catch {
    }
  }
  #newId(wanted) {
    if (wanted !== void 0 && wanted !== "" && !this.#open.has(wanted)) return wanted;
    let id;
    do
      id = `ask-${++this.#seq}`;
    while (this.#open.has(id));
    return id;
  }
  /**
   * Hold one ask until the user answers or the signal aborts. `map` turns a valid reply into the
   * agent's answer, or returns `{error}`; `outcome` names the audit outcome of a reply.
   */
  #hold(view, map, signal, audit, after) {
    const id = this.#newId(view.id);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("the ask was cancelled"));
        return;
      }
      const onAbort = () => entry.drop("the ask was cancelled");
      const entry = {
        view: { ...view, id, at: this.#now() },
        audited: false,
        settle: (reply) => {
          if (this.#open.get(id) !== entry) return "that question is no longer open";
          const r = map(reply);
          if ("error" in r) return r.error;
          signal?.removeEventListener("abort", onAbort);
          this.#remove(id, audit?.outcome(reply));
          resolve(r.value);
          after?.(reply, id);
          return void 0;
        },
        drop: (reason) => {
          if (this.#open.get(id) !== entry) return;
          signal?.removeEventListener("abort", onAbort);
          this.#remove(id, "cancelled");
          reject(new Error(reason));
        }
      };
      this.#open.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (audit) {
        entry.audited = true;
        this.#safe(() => this.#hooks.opened?.(structuredClone(entry.view), audit.info));
      }
      this.#onChange();
    });
  }
  /** D43: an accepted URL elicitation stays as a waiting card until the agent reports it done. */
  #wait(view) {
    const id = view.id;
    const entry = {
      view: { ...view, state: "waiting", choices: [{ id: DISMISS, label: "Close" }], stopChoice: DISMISS },
      audited: false,
      settle: () => {
        this.#remove(id);
        return void 0;
      },
      drop: () => this.#remove(id)
    };
    if (this.#open.has(id)) return;
    this.#open.set(id, entry);
    this.#onChange();
  }
  /** The workspace-trust question (D73). Resolves true only on the user's accept click. */
  trust(q, directory, signal) {
    return this.#hold(
      {
        kind: "trust",
        agent: "main",
        title: `${q.title} ${directory}`,
        detail: q.body,
        choices: [
          { id: TRUST_ACCEPT, label: q.acceptLabel },
          { id: TRUST_DECLINE, label: q.declineLabel }
        ],
        stopChoice: TRUST_DECLINE,
        form: { type: "trust", directory, body: q.body }
      },
      (r) => r.feedback ? { error: "this choice takes no feedback" } : { value: r.choice === TRUST_ACCEPT },
      signal
    );
  }
  /** The handler the backend calls. Every answer comes from a user click or Stop. */
  handler() {
    const who = (agent, label) => {
      const out = {
        agent: agent?.kind === "child" ? "child" : "main"
      };
      if (agent?.kind === "child") out.agentId = agent.id;
      if (label !== void 0) out.agentLabel = label;
      return out;
    };
    return {
      permission: (req, signal) => {
        const reject = req.options.find((o) => o.kind === "reject-once") ?? req.options.find((o) => o.kind.startsWith("reject"));
        const title = req.title ?? `${req.displayName ?? req.toolName} ${fallbackVerb(req.input)}`;
        const what = inputSummary(req.input) ?? req.blockedPath;
        const detail = what !== void 0 && req.description !== void 0 && req.description !== what ? `${what} \u2014 ${req.description}` : what ?? req.description;
        const form = { type: "permission", toolName: req.toolName };
        const input = jsonCopy(req.input);
        if (input.value !== void 0) form.input = input.value;
        if (input.tooLarge) form.inputTruncated = true;
        if (req.displayName !== void 0) form.displayName = req.displayName;
        if (req.description !== void 0) form.description = req.description;
        if (req.reason !== void 0) form.reason = req.reason;
        if (req.blockedPath !== void 0) form.blockedPath = req.blockedPath;
        if (req.defaultToNo === true) form.defaultToNo = true;
        if (req.mcpServer !== void 0) form.mcpServer = { ...req.mcpServer };
        const view = {
          id: req.id,
          kind: "permission",
          ...who(req.agent, req.agentLabel),
          title: req.agentLabel ? `${req.agentLabel}: ${title}` : title,
          choices: req.options.map(permissionChoice),
          stopChoice: reject?.id ?? req.options.at(-1)?.id ?? "reject",
          form
        };
        if (req.callId !== void 0) view.callId = req.callId;
        if (detail !== void 0) view.detail = detail;
        const kindOf = (id) => req.options.find((o) => o.id === id)?.kind ?? "";
        const info = { toolName: req.toolName };
        if (req.callId !== void 0) info.callId = req.callId;
        if (req.reason !== void 0) info.reason = req.reason;
        return this.#hold(
          view,
          (r) => {
            const option = req.options.find((o) => o.id === r.choice);
            const bad = feedbackError(r, option?.acceptsFeedback === true);
            if (bad) return { error: bad };
            const a = { optionId: r.choice };
            if (r.feedback !== void 0 && r.feedback.trim() !== "") a.feedback = r.feedback;
            if (r.rule !== void 0) {
              if (!option?.editableRule) return { error: "this choice saves no editable rule" };
              const rule = typeof r.rule === "string" ? r.rule.trim() : "";
              if (rule === "" || rule.length > 1e3 || /[\r\n]/.test(rule))
                return { error: "the rule must be one line of text" };
              if (rule !== option.editableRule.ruleContent) a.ruleContent = rule;
            }
            return { value: a };
          },
          signal,
          { info, outcome: (r) => kindOf(r.choice).startsWith("allow") ? "allowed-once" : "rejected" }
        );
      },
      question: (req, signal) => {
        const only = req.questions.length === 1 ? req.questions[0] : void 0;
        const text = only?.question;
        const single = only !== void 0 && !only.multiSelect;
        const labels = single ? only.options.map((o) => o.label).filter(Boolean) : [];
        const choices = labels.map((label, i) => ({ id: `option-${i}`, label }));
        choices.push({ id: SUBMIT, label: "Submit answers", submits: "answers" });
        if (req.chatLabel !== void 0)
          choices.push({ id: CHAT, label: req.chatLabel, submits: "answers", partial: true });
        choices.push({ id: DECLINE, label: "Decline" });
        const titles = req.questions.map((q) => q.question);
        const questions = jsonCopy(req.questions).value;
        const view = {
          id: req.id,
          kind: "question",
          ...who(req.agent, req.agentLabel),
          title: titles.join(" / ") || "A question for you",
          choices,
          stopChoice: DECLINE,
          form: {
            type: "question",
            questions: questions ?? [],
            previewFormat: req.previewFormat,
            otherLabel: req.otherLabel
          }
        };
        if (req.callId !== void 0) view.callId = req.callId;
        const info = { toolName: "AskUserQuestion" };
        if (req.callId !== void 0) info.callId = req.callId;
        return this.#hold(
          view,
          (r) => {
            const bad = feedbackError(r, false);
            if (bad) return { error: bad };
            if (r.choice === DECLINE) return { value: null };
            if (r.choice === SUBMIT) {
              const checked = checkQuestionReply(req.questions, r);
              return typeof checked === "string" ? { error: checked } : { value: checked };
            }
            if (r.choice === CHAT && req.chatLabel !== void 0) {
              const checked = checkQuestionReply(req.questions, r, true);
              return typeof checked === "string" ? { error: checked } : { value: { ...checked, chat: true } };
            }
            const m = /^option-(\d+)$/.exec(r.choice);
            const label = m ? labels[Number(m[1])] : void 0;
            return label !== void 0 && text !== void 0 ? { value: { answers: { [text]: label } } } : { error: "that choice is not offered" };
          },
          signal,
          { info, outcome: (r) => r.choice === DECLINE || r.choice === CHAT ? "rejected" : "allowed-once" }
        );
      },
      plan: (req, signal) => {
        const form = { type: "plan", plan: req.plan };
        if (req.planFilePath !== void 0) form.planFilePath = req.planFilePath;
        const keep2 = { id: KEEP_PLANNING, label: req.keepPlanning.label, feedback: true };
        if (req.keepPlanning.feedbackPlaceholder !== void 0)
          keep2.feedbackPlaceholder = req.keepPlanning.feedbackPlaceholder;
        const view = {
          id: req.id,
          kind: "plan",
          ...who(req.agent, req.agentLabel),
          title: "Ready to code? Here is the plan",
          detail: clip(req.plan),
          choices: [...req.choices.map((c) => ({ id: c.id, label: c.label })), keep2],
          stopChoice: KEEP_PLANNING,
          form
        };
        if (req.callId !== void 0) view.callId = req.callId;
        const info = { toolName: "ExitPlanMode" };
        if (req.callId !== void 0) info.callId = req.callId;
        return this.#hold(
          view,
          (r) => {
            const bad = feedbackError(r, r.choice === KEEP_PLANNING);
            if (bad) return { error: bad };
            if (r.choice !== KEEP_PLANNING) return { value: { kind: "approve", choiceId: r.choice } };
            const a = { kind: "keep-planning" };
            if (r.feedback !== void 0 && r.feedback.trim() !== "") a.feedback = r.feedback;
            return { value: a };
          },
          signal,
          { info, outcome: (r) => r.choice === KEEP_PLANNING ? "rejected" : "allowed-once" }
        );
      },
      elicitation: (req, signal) => {
        const mode = req.mode ?? (req.url !== void 0 ? "url" : "form");
        const form = {
          type: "elicitation",
          serverName: req.serverName,
          message: req.message,
          mode
        };
        if (req.url !== void 0) form.url = req.url;
        const schema = jsonCopy(req.requestedSchema, 256 * 1024).value;
        if (schema !== void 0) form.requestedSchema = schema;
        if (req.title !== void 0) form.title = req.title;
        if (req.displayName !== void 0) form.displayName = req.displayName;
        if (req.description !== void 0) form.description = req.description;
        const view = {
          id: req.id,
          kind: "elicitation",
          // The backend's best guess (D44); unknown counts as the main thread for the UI only.
          // Stop never answers an elicitation: the agent cancels the ones its interrupt ends.
          ...who(req.agent, req.agentLabel),
          title: `${req.displayName ?? req.serverName}: ${req.message}`,
          choices: [
            mode === "url" ? { id: ACCEPT, label: "Open and continue" } : { id: ACCEPT, label: "Submit", submits: "content" },
            { id: DECLINE, label: "Decline" },
            { id: CANCEL, label: "Cancel" }
          ],
          stopChoice: DECLINE,
          form
        };
        if (req.url !== void 0) view.detail = req.url;
        return this.#hold(
          view,
          (r) => {
            const bad = feedbackError(r, false);
            if (bad) return { error: bad };
            if (r.content !== void 0 && (mode === "url" || r.choice !== ACCEPT))
              return { error: "content is only sent with a form" };
            if (r.choice === DECLINE) return { value: { action: "decline" } };
            if (r.choice === CANCEL) return { value: { action: "cancel" } };
            if (r.content === void 0) {
              const needs = isRecord(schema) && Array.isArray(schema.required) && schema.required.length > 0;
              return mode === "url" || !needs ? { value: { action: "accept" } } : { error: "the form is not filled in" };
            }
            const content = checkElicitationContent(schema, r.content);
            return typeof content === "string" ? { error: content } : { value: { action: "accept", content } };
          },
          signal,
          void 0,
          (r, id) => {
            if (mode === "url" && r.choice === ACCEPT) {
              const v = { ...structuredClone(view), id, at: this.#now() };
              this.#wait(v);
            }
          }
        );
      }
    };
  }
};
function fallbackVerb(input) {
  if (!isRecord(input)) return "wants to run";
  const hasPath = typeof input.file_path === "string" || typeof input.notebook_path === "string";
  if (hasPath && (typeof input.old_string === "string" || Array.isArray(input.edits) || "new_source" in input))
    return "wants to edit";
  if (hasPath && typeof input.content === "string") return "wants to write";
  if (typeof input.url === "string" && typeof input.command !== "string") return "wants to fetch";
  return "wants to run";
}
function permissionChoice(o) {
  const c = { id: o.id, label: o.label, kind: o.kind };
  if (o.destination !== void 0) c.destination = o.destination;
  if (o.effects !== void 0) c.effects = [...o.effects];
  if (o.acceptsFeedback === true) c.feedback = true;
  if (o.feedbackPlaceholder !== void 0) c.feedbackPlaceholder = o.feedbackPlaceholder;
  if (o.editableRule !== void 0)
    c.editable = {
      value: o.editableRule.ruleContent,
      toolName: o.editableRule.toolName,
      ...o.editableRule.placeholder !== void 0 ? { placeholder: o.editableRule.placeholder } : {}
    };
  return c;
}

// packages/dsh-host/src/children.ts
var CHILD_LAST_CHARS = 160;
function lastOutput(blocks, at) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "tool-call") return { kind: "tool", text: b.name.slice(0, CHILD_LAST_CHARS), at };
    const text = b.text.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const clipped = text.length > CHILD_LAST_CHARS ? `\u2026${text.slice(-(CHILD_LAST_CHARS - 1))}` : text;
    return { kind: b.type === "reasoning" ? "reasoning" : "text", text: clipped, at };
  }
  return void 0;
}
var CHILD_STOP_WAIT_MS = 2e3;
var TEAM_MESSAGES_KEPT = 200;
var ChildEntry = class {
  spec;
  parent;
  view;
  taskId;
  handle;
  ready = Promise.resolve(void 0);
  prompts = [];
  queue = [];
  #waiter;
  turnOpen = false;
  beginPending = false;
  /** The child turn was cut by the host (Stop in the child view); later events are not written. */
  detached = false;
  stopCause;
  sink;
  endWaiters = [];
  constructor(spec, parent, at) {
    this.spec = spec;
    this.parent = parent;
    this.view = {
      id: spec.ref,
      parent: parent.kind === "main" ? "main" : parent.id,
      label: spec.label,
      role: spec.role,
      status: "starting",
      background: spec.background,
      depth: spec.depth,
      startedAt: at,
      wakes: 0,
      inputs: 0
    };
    if (spec.agentType !== void 0) this.view.agentType = spec.agentType;
    if (spec.name !== void 0) this.view.name = spec.name;
    if (spec.team !== void 0) this.view.team = spec.team;
    if (spec.callId !== void 0) this.view.callId = spec.callId;
  }
  get live() {
    return this.view.status === "starting" || this.view.status === "running";
  }
  push(i) {
    if ((this.detached || this.view.noSession) && i.type !== "child-abort") return;
    const w = this.#waiter;
    if (w) {
      this.#waiter = void 0;
      w(i);
    } else this.queue.push(i);
  }
  next() {
    const i = this.queue.shift();
    if (i !== void 0) return Promise.resolve(i);
    return new Promise((r) => this.#waiter = r);
  }
};
var ChildHub = class {
  #deps;
  #entries = /* @__PURE__ */ new Map();
  #messages = [];
  #disposed = false;
  #creating = Promise.resolve();
  constructor(deps) {
    this.#deps = deps;
  }
  get size() {
    return this.#entries.size;
  }
  /** Is this a child of this session (by its agent id)? */
  has(id) {
    return this.#entries.has(id);
  }
  /** Route one child event (D45). Returns false when the event is not a child event. */
  handle(e) {
    switch (e.type) {
      case "agent-start":
        this.#start(e);
        return true;
      case "agent-end": {
        const entry = this.#entries.get(refId(e.ref));
        if (entry) this.#end(entry, e.status, e.summary);
        return true;
      }
      case "agent-input": {
        const entry = this.#entries.get(refId(e.ref));
        if (entry) entry.view.inputs++;
        return true;
      }
      case "team-message": {
        const m = {
          from: e.from,
          to: e.to,
          text: e.text,
          sender: refId(e.agent),
          at: this.#deps.now()
        };
        if (e.summary !== void 0) m.summary = e.summary;
        this.#messages.push(m);
        if (this.#messages.length > TEAM_MESSAGES_KEPT)
          this.#messages.splice(0, this.#messages.length - TEAM_MESSAGES_KEPT);
        return true;
      }
      case "step-start":
      case "delta":
      case "step-message":
      case "tool-result": {
        if (e.agent.kind !== "child") return false;
        const entry = this.#entries.get(e.agent.id);
        if (!entry) {
          this.#deps.warn("dropped an event of an unknown child agent", e.agent.id);
          return true;
        }
        if (e.type === "step-message") {
          const last = lastOutput(e.blocks, this.#deps.now());
          if (last) {
            entry.view.last = last;
            this.#deps.notify();
          }
        }
        if (e.type !== "delta") entry.push(e);
        return true;
      }
      default:
        return false;
    }
  }
  /** Task progress of a child's task: tokens and tool count for its row (D46, D68). */
  progress(taskId, usage) {
    for (const entry of this.#entries.values()) {
      if (entry.taskId !== taskId && entry.spec.ref !== taskId) continue;
      if (usage?.tokens !== void 0) entry.view.tokens = usage.tokens;
      if (usage?.toolUses !== void 0) entry.view.toolUses = usage.toolUses;
      if (usage?.durationMs !== void 0) entry.view.durationMs = usage.durationMs;
      return true;
    }
    return false;
  }
  #start(e) {
    const id = refId(e.ref);
    const known = this.#entries.get(id);
    if (known) {
      if (e.taskId !== void 0) known.taskId = e.taskId;
      if (!known.live) {
        known.view.status = "running";
        delete known.view.endedAt;
        delete known.view.stopping;
        known.detached = false;
        known.stopCause = void 0;
      }
      if (e.resumed === true) known.view.wakes++;
      if (e.wokenBy !== void 0) known.view.wokenBy = e.wokenBy;
      known.prompts.push(e.taskPrompt);
      this.#beginNext(known);
      this.#deps.notify();
      return;
    }
    const spec = { ref: id, label: e.label, role: e.role, background: e.background, depth: e.depth ?? 1 };
    if (e.agentType !== void 0) spec.agentType = e.agentType;
    if (e.name !== void 0) spec.name = e.name;
    if (e.team !== void 0) spec.team = e.team;
    if (e.parentCallId !== void 0) spec.callId = e.parentCallId;
    const entry = new ChildEntry(spec, e.parent, this.#deps.now());
    entry.taskId = e.taskId;
    entry.view.status = "running";
    entry.prompts.push(e.taskPrompt);
    this.#entries.set(id, entry);
    const parent = e.parent.kind === "child" ? this.#entries.get(e.parent.id) : void 0;
    if (parent) spec.depth = Math.max(spec.depth, parent.spec.depth + 1);
    const runner = (sink, signal) => this.#run(entry, sink, signal);
    const previous = this.#creating;
    entry.ready = (async () => {
      await previous;
      let handle;
      if (parent) {
        const ph = await parent.ready;
        if (ph) handle = await ph.createChild(spec, runner);
      } else if (this.#deps.createRootChild) handle = await this.#deps.createRootChild(spec, runner);
      if (!handle) throw new Error("the host has no child sessions here");
      if (this.#disposed) {
        await handle.dispose().catch(() => {
        });
        throw new Error("the session is closed");
      }
      entry.handle = handle;
      entry.view.hostSessionId = handle.hostSessionId;
      this.#beginNext(entry);
      this.#deps.notify();
      return handle;
    })().catch((error) => {
      entry.view.noSession = true;
      entry.queue = [];
      this.#deps.warn(`could not create a child session for ${spec.label}`, String(error?.message ?? error));
      this.#deps.notify();
      return void 0;
    });
    this.#creating = entry.ready.then(
      () => void 0,
      () => void 0
    );
  }
  #beginNext(entry) {
    if (!entry.handle || entry.turnOpen || entry.beginPending || this.#disposed) return;
    const prompt = entry.prompts.shift();
    if (prompt === void 0) return;
    entry.beginPending = true;
    try {
      entry.handle.begin(prompt);
    } catch (error) {
      entry.beginPending = false;
      this.#deps.warn("could not open a child turn", String(error?.message ?? error));
    }
  }
  #end(entry, status, summary) {
    if (!entry.live) return;
    entry.view.status = status;
    entry.view.endedAt = this.#deps.now();
    delete entry.view.stopping;
    if (summary !== void 0) entry.view.summary = summary;
    if (status === "stopped") entry.stopCause ??= "parent";
    const item = { type: "child-end", status };
    if (summary !== void 0) item.summary = summary;
    entry.push(item);
    for (const w of entry.endWaiters.splice(0)) w();
    this.#deps.notify();
  }
  /**
   * D74: the process died, was force-stopped or disposed: every live child ends now, so each child
   * writer closes its open step (repair results, `assistant/attempt`) and ends its turn.
   */
  endAll(status, summary) {
    for (const entry of this.#entries.values()) if (entry.live) this.#end(entry, status, summary);
  }
  /**
   * D74: an interrupted main turn ends its foreground children (the agent may send no end for
   * them). Background children and teammates keep running (rule 6).
   */
  endForeground() {
    for (const entry of this.#entries.values())
      if (entry.live && !entry.spec.background && entry.spec.role !== "teammate") this.#end(entry, "stopped");
  }
  /** Resolve once no child turn is open or about to open, or after `ms`. */
  async quiesce(ms) {
    const end = this.#deps.now() + ms;
    const busy = () => [...this.#entries.values()].some((e) => e.turnOpen || e.beginPending && e.handle !== void 0);
    while (busy() && this.#deps.now() < end) await new Promise((r) => setTimeout(r, 10));
  }
  /**
   * D46: stop one child: the agent's per-task stop, then wait up to 2 s for the agent's own end.
   * The other children keep running.
   */
  async stop(id, waitMs2 = CHILD_STOP_WAIT_MS) {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, status: "unknown", error: "no such child agent in this session" };
    if (!entry.live) return { ok: true, status: entry.view.status };
    if (!this.#deps.stopTask) return { ok: false, status: entry.view.status, error: "this agent cannot stop one task" };
    entry.view.stopping = true;
    entry.stopCause = "user";
    this.#deps.notify();
    try {
      await this.#deps.stopTask(entry.taskId ?? entry.spec.ref);
    } catch (error) {
      delete entry.view.stopping;
      entry.stopCause = void 0;
      this.#deps.notify();
      return { ok: false, status: entry.view.status, error: String(error?.message ?? error) };
    }
    if (entry.live) {
      let timer;
      await new Promise((resolve) => {
        entry.endWaiters.push(resolve);
        timer = setTimeout(resolve, waitMs2);
      });
      clearTimeout(timer);
    }
    return { ok: true, status: entry.live ? "stopping" : entry.view.status };
  }
  /**
   * The host child session of one child, once it is made (D48: a workflow member record names
   * it). Undefined when the child is unknown or has no host session.
   */
  async session(id) {
    const entry = this.#entries.get(id);
    if (!entry) return void 0;
    const handle = await entry.ready;
    return handle?.hostSessionId;
  }
  /** The role of one child, if it is known. */
  role(id) {
    return this.#entries.get(id)?.spec.role;
  }
  /** The open turn's writer of one child, for its D44 audit pair. */
  openSink(id) {
    const entry = this.#entries.get(id);
    return entry?.turnOpen ? entry.sink : void 0;
  }
  label(id) {
    return this.#entries.get(id)?.view.label;
  }
  views() {
    return [...this.#entries.values()].map((e) => ({ ...e.view }));
  }
  team() {
    const teams = /* @__PURE__ */ new Map();
    for (const e of this.#entries.values()) {
      if (e.spec.role !== "teammate") continue;
      const name2 = e.spec.team ?? "";
      teams.set(name2, [...teams.get(name2) ?? [], e.spec.ref]);
    }
    if (teams.size === 0 && this.#messages.length === 0) return void 0;
    return {
      teams: [...teams].map(([name2, members]) => ({ name: name2, members })),
      messages: this.#messages.map((m) => ({ ...m })),
      messaging: this.#deps.teamMessaging?.() === true
    };
  }
  /** The runtime ends for good: end every child turn and dispose the host child sessions. */
  async dispose() {
    this.endAll("stopped");
    await this.quiesce(1e3);
    this.#disposed = true;
    const handles = [...this.#entries.values()].map((e) => e.handle).filter((h) => h !== void 0);
    await Promise.all(handles.map((h) => h.dispose().catch(() => {
    })));
  }
  /**
   * The child writer (D68): one step per agent message id, one `assistant/message` per frame, the
   * `tool/call`s, then results. A new step waits until every call of the open step has its result
   * (its events are held back); when the child ends, open calls get the exact repair result (D74).
   */
  async #run(entry, sink, signal) {
    entry.turnOpen = true;
    entry.beginPending = false;
    entry.sink = sink;
    const onAbort = () => entry.push({ type: "child-abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    let held;
    const binding = { backend: "child", agentId: entry.spec.ref };
    try {
      for (; ; ) {
        const item = await entry.next();
        if (item.type === "child-abort") {
          const reason = signal.reason;
          const byUser = reason?.kind === "user";
          entry.detached = true;
          entry.queue = [];
          if (byUser && entry.live) void this.stop(entry.spec.ref, 0);
          return { kind: "stopped", cause: byUser ? "user" : "parent" };
        }
        if (item.type === "child-end") {
          const rest = held ?? [];
          held = void 0;
          for (const h of rest) {
            try {
              this.#write(sink, h, binding, entry, () => {
                sink.closeStep();
                sink.openStep();
              });
            } catch (error) {
              this.#deps.warn(`refused a child ${h.type}`, String(error?.message ?? error));
            }
          }
          if (item.status === "completed") return { kind: "completed" };
          if (item.status === "stopped") return { kind: "stopped", cause: entry.stopCause ?? "parent" };
          return { kind: "error", message: item.summary ?? `${entry.spec.label} failed` };
        }
        if (held) {
          const r = item.type === "tool-result" && sink.stepOpen && sink.openCallIds.includes(item.callId);
          if (!r) {
            held.push(item);
            continue;
          }
        }
        try {
          this.#write(sink, item, binding, entry, (h) => held = h);
        } catch (error) {
          this.#deps.warn(`refused a child ${item.type}`, String(error?.message ?? error));
        }
        if (held && sink.openCallIds.length === 0) {
          sink.closeStep();
          entry.queue.unshift(...held);
          held = void 0;
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        sink.closeStep();
      } catch (error) {
        this.#deps.warn("closing a child step failed", String(error));
      }
      entry.turnOpen = false;
      entry.sink = void 0;
      entry.queue = entry.queue.filter((i) => i.type !== "child-abort");
      this.#beginNext(entry);
      this.#deps.notify();
    }
  }
  #write(sink, item, binding, entry, hold) {
    switch (item.type) {
      case "step-start":
        if (sink.stepOpen) {
          if (sink.openCallIds.length > 0) {
            hold([item]);
            return;
          }
          sink.closeStep();
        }
        sink.openStep();
        return;
      case "step-message": {
        if (!sink.stepOpen) sink.openStep();
        const m = { blocks: item.blocks, binding };
        if (item.model) m.model = item.model;
        if (sink.hasMessage) m.continued = true;
        sink.commit(m);
        return;
      }
      case "tool-result": {
        if (!sink.stepOpen || !sink.hasCall(item.callId) || !sink.openCallIds.includes(item.callId)) {
          this.#deps.warn(`dropped a child tool result with no open call (${entry.spec.label})`, item.callId);
          return;
        }
        const content = item.content.map(
          (c) => c.type === "image" ? { type: "text", text: this.#deps.imageText(c.mediaType) } : c
        );
        sink.result(item.callId, content, item.isError, item.chainId);
        return;
      }
      default:
        return;
    }
  }
};
function refId(ref) {
  return ref.kind === "main" ? "main" : ref.id;
}

// packages/dsh-host/src/usage.ts
var USAGE_TURNS_KEPT = 50;
var USAGE_EVENTS_KEPT = 20;
var percentOf = (used, window) => window > 0 ? Math.round(used / window * 1e3) / 10 : 0;
var keep = (list, n) => list.length > n ? list.slice(-n) : list;
var UsageBoard = class {
  #now;
  #totals;
  #costLabel;
  #auth;
  #limits;
  #turns = [];
  #context;
  #compacting = false;
  #compactions = [];
  #retries = [];
  #resets = [];
  #at;
  constructor(now = Date.now) {
    this.#now = now;
  }
  /** The event types this board takes. */
  static handles(e) {
    switch (e.type) {
      case "usage":
      case "context":
      case "compaction":
      case "limits":
      case "retry":
      case "auth":
      case "conversation-reset":
        return true;
      default:
        return false;
    }
  }
  /** Take one backend event. `hostTurn`: the open host turn, if any. Returns true when it changed. */
  apply(e, hostTurn) {
    const at = this.#now();
    switch (e.type) {
      case "usage":
        return this.#usage(e, hostTurn, at);
      case "context": {
        if (!(e.window > 0) || !(e.used >= 0)) return false;
        const prior = this.#context;
        const c = {
          used: e.used,
          window: e.window,
          percent: percentOf(e.used, e.window),
          source: "call",
          at
        };
        const compactAt = e.autoCompactAt ?? prior?.autoCompactAt;
        if (compactAt !== void 0) c.autoCompactAt = compactAt;
        if (prior?.autoCompactEnabled !== void 0) c.autoCompactEnabled = prior.autoCompactEnabled;
        if (prior?.model !== void 0) c.model = prior.model;
        this.#context = c;
        this.#retries = [];
        break;
      }
      case "compaction": {
        const row = { phase: e.phase, at };
        if (e.trigger !== void 0) row.trigger = e.trigger;
        if (e.preTokens !== void 0) row.preTokens = e.preTokens;
        if (e.postTokens !== void 0) row.postTokens = e.postTokens;
        if (e.error !== void 0) row.error = e.error;
        this.#compactions = keep([...this.#compactions, row], USAGE_EVENTS_KEPT);
        this.#compacting = e.phase === "start";
        if (e.phase === "end" && e.error === void 0 && e.postTokens !== void 0 && this.#context) {
          const c = this.#context;
          this.#context = {
            ...c,
            used: e.postTokens,
            percent: percentOf(e.postTokens, c.window),
            source: "compaction",
            at
          };
          delete this.#context.categories;
        }
        break;
      }
      case "limits":
        this.#limits = structuredClone(e.limits);
        break;
      case "retry": {
        const row = { attempt: e.attempt, error: e.error, at };
        if (e.maxRetries !== void 0) row.maxRetries = e.maxRetries;
        if (e.delayMs !== void 0) row.delayMs = e.delayMs;
        if (e.httpStatus !== void 0) row.httpStatus = e.httpStatus;
        if (hostTurn !== void 0) row.hostTurn = hostTurn;
        this.#retries = keep([...this.#retries, row], USAGE_EVENTS_KEPT);
        break;
      }
      case "auth":
        this.#auth = structuredClone(e.auth);
        this.#costLabel = structuredClone(e.costLabel);
        break;
      case "conversation-reset": {
        const row = { at };
        if (e.trigger !== void 0) row.trigger = e.trigger;
        if (hostTurn !== void 0) row.hostTurn = hostTurn;
        this.#resets = keep([...this.#resets, row], USAGE_EVENTS_KEPT);
        this.#context = void 0;
        this.#compacting = false;
        break;
      }
      default:
        return false;
    }
    this.#at = at;
    return true;
  }
  #usage(e, hostTurn, at) {
    this.#totals = structuredClone(e.cumulative);
    this.#costLabel = structuredClone(e.costLabel);
    if (e.turn !== void 0) {
      const row = { usage: structuredClone(e.turn), at };
      if (hostTurn !== void 0) row.hostTurn = hostTurn;
      this.#turns = keep([...this.#turns, row], USAGE_TURNS_KEPT);
    }
    this.#at = at;
    return true;
  }
  /** The agent's own context report (Claude: `getContextUsage`). */
  report(r) {
    if (!(r.window > 0) || !(r.used >= 0)) return this.#context;
    const at = this.#now();
    const c = {
      used: r.used,
      window: r.window,
      percent: r.percent !== void 0 && Number.isFinite(r.percent) ? r.percent : percentOf(r.used, r.window),
      source: "report",
      at
    };
    if (r.autoCompactAt !== void 0) c.autoCompactAt = r.autoCompactAt;
    if (r.autoCompactEnabled !== void 0) c.autoCompactEnabled = r.autoCompactEnabled;
    if (r.categories !== void 0) c.categories = structuredClone(r.categories);
    else if (this.#context?.categories !== void 0 && this.#context.used === r.used)
      c.categories = this.#context.categories;
    if (r.model !== void 0) c.model = r.model;
    this.#context = c;
    this.#at = at;
    return c;
  }
  /** The agent's usage control answer (D58, D60): totals, label, auth and limits. */
  snapshot(s) {
    this.#totals = structuredClone(s.totals);
    this.#costLabel = structuredClone(s.costLabel);
    if (s.auth !== void 0) this.#auth = structuredClone(s.auth);
    this.#limits = structuredClone(s.limits);
    this.#at = this.#now();
  }
  /** A turn ended: retries of its calls are over. */
  turnEnded() {
    if (this.#retries.length === 0) return false;
    this.#retries = [];
    return true;
  }
  get context() {
    return this.#context === void 0 ? void 0 : structuredClone(this.#context);
  }
  view() {
    const v = {
      turns: structuredClone(this.#turns),
      compacting: this.#compacting,
      compactions: structuredClone(this.#compactions),
      retries: structuredClone(this.#retries),
      resets: structuredClone(this.#resets)
    };
    if (this.#totals !== void 0) v.totals = structuredClone(this.#totals);
    if (this.#costLabel !== void 0) v.costLabel = structuredClone(this.#costLabel);
    if (this.#auth !== void 0) v.auth = structuredClone(this.#auth);
    if (this.#limits !== void 0) v.limits = structuredClone(this.#limits);
    const last = this.#turns.at(-1);
    if (last !== void 0) v.lastTurn = structuredClone(last);
    if (this.#context !== void 0) v.context = structuredClone(this.#context);
    if (this.#at !== void 0) v.at = this.#at;
    return v;
  }
  /** The small part the session view carries, or undefined when nothing is known yet. */
  summary() {
    if (this.#at === void 0) return void 0;
    const s = { compacting: this.#compacting, at: this.#at };
    const c = this.#context;
    if (c !== void 0) {
      s.context = { used: c.used, window: c.window, percent: c.percent, source: c.source, at: c.at };
      if (c.autoCompactAt !== void 0) s.context.autoCompactAt = c.autoCompactAt;
    }
    const t = this.#totals;
    if (t !== void 0) {
      s.tokens = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
      s.costUsd = t.costUsd;
    }
    if (this.#costLabel !== void 0) s.costLabel = structuredClone(this.#costLabel);
    if (this.#limits?.available !== void 0) s.limitsAvailable = this.#limits.available;
    if (this.#limits?.blocked !== void 0) s.blocked = true;
    if (this.#limits?.available === true) {
      let top;
      for (const l of this.#limits.limits)
        if (l.percent !== void 0 && Number.isFinite(l.percent) && (top?.percent ?? -1) < l.percent) top = l;
      if (top !== void 0) {
        s.limit = { id: top.id, label: top.label, percent: top.percent };
        if (top.resetsAt !== void 0) s.limit.resetsAt = top.resetsAt;
        if (top.status !== void 0) s.limit.status = top.status;
      }
    }
    if (this.#auth !== void 0) s.auth = { kind: this.#auth.kind, label: this.#auth.label };
    const r = this.#retries.at(-1);
    if (r !== void 0) {
      s.retry = { attempt: r.attempt, error: r.error, at: r.at };
      if (r.maxRetries !== void 0) s.retry.maxRetries = r.maxRetries;
    }
    return s;
  }
};

// packages/dsh-host/src/workflows.ts
var WORKFLOW_RUNS_KEPT = 20;
var WORKFLOW_CHILD_WAIT_MS = 1e4;
var Run = class {
  taskId;
  runId;
  name;
  label;
  callId;
  status = "starting";
  stopping = false;
  /** `workflow-start` was seen (or the run was started late, at its end). */
  started = false;
  phases = [];
  agents = [];
  usage;
  summary;
  startedAt;
  endedAt;
  members = /* @__PURE__ */ new Map();
  seqs = /* @__PURE__ */ new Set();
  /** Writes wait here until the run starts, then run in order. */
  waiting = [];
  chain = Promise.resolve();
  /** The run-start record could not be written: nothing else of this run is. */
  broken = false;
  written = false;
  constructor(taskId, at) {
    this.taskId = taskId;
    this.runId = taskId;
    this.name = taskId;
    this.startedAt = at;
  }
  get live() {
    return this.status === "starting" || this.status === "running";
  }
};
function memberOutcomeOfStatus(status) {
  return status === "completed" ? "completed" : status === "stopped" ? "cancelled" : "failed";
}
function memberOutcomeOfState(state, runStopped) {
  if (state === "done") return "completed";
  if (state === "stopped") return "cancelled";
  return runStopped ? "cancelled" : "failed";
}
var WorkflowRecorder = class {
  #deps;
  #runs = /* @__PURE__ */ new Map();
  /** Agent id → run task id (from snapshot rows). */
  #agentRuns = /* @__PURE__ */ new Map();
  /** Workflow agents that started before any snapshot named them. */
  #orphans = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.#deps = deps;
  }
  get size() {
    return this.#runs.size;
  }
  has(taskId) {
    return this.#runs.has(taskId);
  }
  isLive(taskId) {
    return this.#runs.get(taskId)?.live === true;
  }
  /** The run's job started (D47): a row in the view from the first moment. */
  taskStarted(taskId, label) {
    const run = this.#run(taskId);
    run.label ??= label;
    if (!run.started) run.name = label;
  }
  /** The run started (after its launching call's result): open its native record. */
  start(e) {
    const run = this.#run(e.taskId);
    if (run.started || !run.live) return;
    if (e.runId !== void 0 && e.runId !== "") run.runId = e.runId;
    run.name = e.name || e.label || run.name;
    if (e.label !== void 0) run.label = e.label;
    if (e.callId !== void 0) run.callId = e.callId;
    run.status = "running";
    this.#open(run);
    for (const [agentId, a] of [...this.#orphans])
      if (a.parentCallId !== void 0 && a.parentCallId === run.callId) {
        this.#orphans.delete(agentId);
        this.#agentRuns.set(agentId, run.taskId);
        this.#announce(run, a);
      }
  }
  /** The run's merged snapshot (D48): the plugin view, member names and settled rows. */
  snapshot(e) {
    const run = this.#run(e.taskId);
    if (!run.live) return;
    run.phases = e.phases.map((p) => ({ ...p }));
    run.agents = e.agents.map((a) => ({ ...a }));
    if (e.usage !== void 0) run.usage = { ...e.usage };
    for (const row of e.agents) {
      if (row.agentId === void 0) continue;
      this.#agentRuns.set(row.agentId, run.taskId);
      const m = this.#member(run, row.agentId, row);
      if (!m.startWritten) {
        m.label = row.label || m.label;
        const phase = phaseName(row);
        if (phase !== void 0) m.phase = phase;
      }
      const orphan = this.#orphans.get(row.agentId);
      if (orphan) {
        this.#orphans.delete(row.agentId);
        this.#announce(run, orphan);
      }
      if (m.announced && isSettledWorkflowAgent(row.state))
        this.#endMember(run, m, memberOutcomeOfState(row.state, run.stopping));
    }
  }
  /** A workflow agent's child agent started (its child session is being made, D45). */
  agentStarted(e) {
    if (e.role !== "workflow-agent" || e.ref.kind !== "child") return;
    const agentId = e.ref.id;
    let taskId = this.#agentRuns.get(agentId);
    if (taskId === void 0 && e.parentCallId !== void 0)
      taskId = [...this.#runs.values()].find((r) => r.live && r.callId === e.parentCallId)?.taskId;
    const run = taskId === void 0 ? void 0 : this.#runs.get(taskId);
    if (!run || !run.live) {
      this.#orphans.set(agentId, e);
      return;
    }
    this.#agentRuns.set(agentId, run.taskId);
    this.#announce(run, e);
  }
  /** A workflow agent's child agent ended. */
  agentEnded(e) {
    if (e.ref.kind !== "child") return;
    this.#orphans.delete(e.ref.id);
    const taskId = this.#agentRuns.get(e.ref.id);
    const run = taskId === void 0 ? void 0 : this.#runs.get(taskId);
    const m = run?.members.get(e.ref.id);
    if (!run || !m || !m.announced) return;
    this.#endMember(run, m, run.stopping && e.status !== "completed" ? "cancelled" : memberOutcomeOfStatus(e.status));
  }
  /** "Stop entire workflow" was pressed (or its job was killed). */
  noteStop(taskId) {
    const run = this.#runs.get(taskId);
    if (!run || !run.live) return;
    run.stopping = true;
    this.#deps.notify();
  }
  /** The stop failed: the run keeps running. */
  clearStop(taskId) {
    const run = this.#runs.get(taskId);
    if (!run || !run.stopping) return;
    run.stopping = false;
    this.#deps.notify();
  }
  /** The run ended: its open members end, then its record closes. */
  ended(e) {
    this.#finish(this.#run(e.taskId), e.stopReason, e.summary, e.usage);
  }
  /** D74: the process exited or the session goes away: every live run ends now. */
  closeAll(stopReason, summary) {
    for (const run of this.#runs.values()) if (run.live) this.#finish(run, stopReason, summary);
    this.#orphans.clear();
  }
  /**
   * Records a gone process left open in the host log (a host restart ends the process with it):
   * each open member and each run is closed. Runs this recorder holds live are left alone.
   */
  closeStale(open2) {
    const live = new Set([...this.#runs.values()].filter((r) => r.live).map((r) => r.runId));
    for (const o of open2) {
      if (live.has(o.runId)) continue;
      try {
        for (const seq of o.openSeqs) this.#deps.write({ kind: "agent-end", runId: o.runId, seq, outcome: "failed" });
        this.#deps.write({ kind: "run-end", runId: o.runId, stopReason: "error" });
      } catch (error) {
        this.#deps.warn("could not close a stale workflow record", String(error?.message ?? error));
      }
    }
  }
  /** Resolves once every queued record is written (or after `ms`). */
  async flush(ms = 5e3) {
    let timer;
    const chains = Promise.all([...this.#runs.values()].map((r) => r.chain)).then(() => void 0);
    await Promise.race([chains, new Promise((r) => timer = setTimeout(r, ms))]);
    clearTimeout(timer);
  }
  views() {
    return [...this.#runs.values()].map((run) => {
      const v = {
        taskId: run.taskId,
        runId: run.runId,
        name: run.name,
        status: run.status,
        phases: run.phases.map((p) => ({ ...p })),
        agents: run.agents.map((a) => {
          const row = { ...a };
          const child = a.agentId === void 0 ? void 0 : run.members.get(a.agentId)?.childId;
          if (child !== void 0) row.childSessionId = child;
          return row;
        }),
        startedAt: run.startedAt
      };
      if (run.label !== void 0) v.label = run.label;
      if (run.stopping && run.live) v.stopping = true;
      if (run.usage !== void 0) v.usage = { ...run.usage };
      if (run.callId !== void 0) v.callId = run.callId;
      if (run.endedAt !== void 0) v.endedAt = run.endedAt;
      if (run.summary !== void 0) v.summary = run.summary;
      return v;
    });
  }
  // ---- internals ----
  #run(taskId) {
    let run = this.#runs.get(taskId);
    if (!run) {
      run = new Run(taskId, this.#deps.now());
      this.#runs.set(taskId, run);
      this.#prune();
    }
    return run;
  }
  #prune() {
    const ended = [...this.#runs.values()].filter((r) => !r.live);
    for (const r of ended.slice(0, Math.max(0, ended.length - WORKFLOW_RUNS_KEPT))) {
      this.#runs.delete(r.taskId);
      for (const id of r.members.keys()) this.#agentRuns.delete(id);
    }
  }
  #member(run, agentId, row) {
    let m = run.members.get(agentId);
    if (m) return m;
    let seq = row?.index ?? 1;
    if (run.seqs.has(seq)) seq = Math.max(...run.seqs) + 1;
    run.seqs.add(seq);
    m = { agentId, seq, label: row?.label ?? agentId, announced: false, startWritten: false, endQueued: false };
    const phase = row === void 0 ? void 0 : phaseName(row);
    if (phase !== void 0) m.phase = phase;
    run.members.set(agentId, m);
    return m;
  }
  /** Queue one write of this run; before the run starts, it waits. */
  #enqueue(run, op) {
    if (!run.started) {
      run.waiting.push(op);
      return;
    }
    run.chain = run.chain.then(() => run.broken ? void 0 : op()).catch(
      (error) => this.#deps.warn("a workflow record failed", String(error?.message ?? error))
    );
  }
  #write(run, record) {
    try {
      this.#deps.write(record);
      return true;
    } catch (error) {
      this.#deps.warn(`could not record workflow ${record.kind}`, String(error?.message ?? error));
      return false;
    }
  }
  #open(run) {
    run.started = true;
    this.#enqueue(run, () => {
      run.written = this.#write(run, { kind: "run-start", runId: run.runId, name: run.name });
      if (!run.written) run.broken = true;
    });
    const waiting = run.waiting;
    run.waiting = [];
    for (const op of waiting) this.#enqueue(run, op);
    this.#deps.notify();
  }
  #announce(run, e) {
    if (e.ref.kind !== "child") return;
    const m = this.#member(run, e.ref.id);
    if (m.announced) return;
    m.announced = true;
    if (m.label === m.agentId) m.label = e.label;
    this.#enqueue(run, async () => {
      const childId = await this.#childSession(m.agentId);
      if (childId === void 0) {
        this.#deps.warn("a workflow agent has no child session; its member is not recorded", m.label);
        return;
      }
      const r = { kind: "agent-start", runId: run.runId, seq: m.seq, label: m.label, childId };
      if (m.phase !== void 0) r.phase = m.phase;
      if (this.#write(run, r)) {
        m.startWritten = true;
        m.childId = childId;
        this.#deps.notify();
      }
    });
    this.#deps.notify();
  }
  async #childSession(agentId) {
    let timer;
    try {
      return await Promise.race([
        this.#deps.childSession(agentId),
        new Promise((r) => timer = setTimeout(() => r(void 0), WORKFLOW_CHILD_WAIT_MS))
      ]);
    } catch {
      return void 0;
    } finally {
      clearTimeout(timer);
    }
  }
  #endMember(run, m, outcome) {
    if (m.endQueued) return;
    m.endQueued = true;
    this.#enqueue(run, () => {
      if (!m.startWritten) return;
      this.#write(run, { kind: "agent-end", runId: run.runId, seq: m.seq, outcome });
    });
  }
  #finish(run, stopReason, summary, usage) {
    if (!run.live) return;
    if (!run.started) this.#open(run);
    const stopped = run.stopping || stopReason === "cancelled";
    for (const m of run.members.values()) {
      if (!m.announced) continue;
      const row = run.agents.find((a) => a.agentId === m.agentId);
      const outcome = row !== void 0 && isSettledWorkflowAgent(row.state) ? memberOutcomeOfState(row.state, stopped) : stopReason === "completed" ? "completed" : stopReason === "cancelled" ? "cancelled" : "failed";
      this.#endMember(run, m, outcome);
    }
    run.status = stopReason;
    run.endedAt = this.#deps.now();
    if (summary !== void 0) run.summary = summary;
    if (usage !== void 0) run.usage = { ...usage };
    this.#enqueue(run, () => {
      if (run.written) this.#write(run, { kind: "run-end", runId: run.runId, stopReason });
    });
    this.#prune();
    this.#deps.notify();
  }
};
function phaseName(row) {
  if (row.phaseTitle !== void 0 && row.phaseTitle !== "") return row.phaseTitle;
  if (row.phaseIndex !== void 0) return `Phase ${row.phaseIndex}`;
  return void 0;
}

// packages/dsh-host/src/agent-commands.ts
var DSH_KEPT_COMMANDS = Object.freeze([
  "model",
  "file",
  "permission",
  "feedback",
  "export"
]);
var TAKEN_NOTE = "taken by DSH in this session";
function planCommandMenu(list, opts) {
  const taken = /* @__PURE__ */ new Set([...DSH_KEPT_COMMANDS, ...opts.taken ?? []]);
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (const c of list) {
    if (typeof c?.name !== "string" || c.name === "" || seen.has(c.name)) continue;
    seen.add(c.name);
    const row = { ...c, menu: "listed" };
    if (c.name === opts.sideQuestionCommand) row.menu = "side-question";
    else if (taken.has(c.name)) {
      row.menu = "taken";
      row.note = TAKEN_NOTE;
    } else if (c.name === opts.rewindCommand) row.menu = "rewind-panel";
    else if (c.terminalOnly) row.menu = "terminal-only";
    else if (c.name === opts.mcpCommand) row.menu = "mcp-panel";
    rows.push(row);
  }
  return { rows };
}
var SIDE_ENTRIES_KEPT = 20;
var SIDE_QUESTION_MAX = 2e4;
var SideQuestionDesk = class {
  #deps;
  #now;
  #history = new SideQuestionHistory();
  #entries = [];
  #aborts = /* @__PURE__ */ new Map();
  #seq = 0;
  constructor(deps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }
  view() {
    return { entries: this.#entries.map((e) => ({ ...e })), historySize: this.#history.size };
  }
  get busy() {
    return this.#entries.some((e) => e.status === "asking");
  }
  /**
   * Ask now, or keep the question for the start. Resolves when the agent answered (or failed);
   * a waiting question resolves at once with status 'waiting'.
   */
  async ask(question, signal) {
    const q = question.trim();
    if (q === "") return { ok: false, code: "empty", error: "Type a question first." };
    if (q.length > SIDE_QUESTION_MAX)
      return { ok: false, code: "too-long", error: `The question is longer than ${SIDE_QUESTION_MAX} characters.` };
    const control = this.#deps.control();
    if (control.kind === "unsupported")
      return {
        ok: false,
        code: "unsupported",
        error: `This ${this.#deps.displayName} version cannot answer side questions.`
      };
    if (this.busy || this.#entries.some((e) => e.status === "waiting"))
      return { ok: false, code: "busy", error: "Another side question is still open. Wait for its answer first." };
    const entry = { id: `side-${++this.#seq}`, question: q, status: "waiting", at: this.#now() };
    this.#push(entry);
    if (control.kind === "not-running") {
      this.#deps.notify();
      return { ok: true, entry: { ...entry } };
    }
    return this.#run(entry, control.ask, signal);
  }
  /** The agent started: ask the waiting question, if any (D54: kept until the user's Start). */
  resume() {
    const entry = this.#entries.find((e) => e.status === "waiting");
    if (!entry) return;
    const control = this.#deps.control();
    if (control.kind === "ready") void this.#run(entry, control.ask);
    else if (control.kind === "unsupported") {
      entry.status = "failed";
      entry.error = `This ${this.#deps.displayName} version cannot answer side questions.`;
      this.#deps.notify();
    }
  }
  /**
   * The user's Start failed: a waiting question fails with the reason, so it does not block
   * every later question as "busy" until the user cancels it.
   */
  startFailed(reason) {
    const entry = this.#entries.find((e) => e.status === "waiting");
    if (!entry) return;
    entry.status = "failed";
    entry.error = `${this.#deps.displayName} did not start: ${reason}`;
    this.#deps.notify();
  }
  /** Cancel one open question (asking or waiting). */
  cancel(id) {
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry || entry.status !== "asking" && entry.status !== "waiting") return false;
    this.#aborts.get(id)?.abort();
    this.#aborts.delete(id);
    entry.status = "cancelled";
    this.#deps.notify();
    return true;
  }
  /** D70: the conversation was reset; earlier exchanges no longer belong to it. */
  clear() {
    for (const e of this.#entries) if (e.status === "asking" || e.status === "waiting") e.status = "cancelled";
    for (const a of this.#aborts.values()) a.abort();
    this.#aborts.clear();
    this.#history.clear();
    this.#entries = [];
    this.#deps.notify();
  }
  #push(entry) {
    this.#entries = [...this.#entries, entry].slice(-SIDE_ENTRIES_KEPT);
  }
  async #run(entry, ask, signal) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#aborts.set(entry.id, abort);
    entry.status = "asking";
    this.#deps.notify();
    try {
      const answer = await ask(entry.question, this.#history.list(), abort.signal);
      if (entry.status !== "asking") return { ok: true, entry: { ...entry } };
      if (answer === null) entry.status = "cancelled";
      else {
        entry.status = "answered";
        entry.answer = answer.text;
        if (answer.synthetic) entry.synthetic = true;
        if (answer.fallback) entry.fallback = { ...answer.fallback };
        this.#history.record(entry.question, answer);
      }
    } catch (error) {
      if (entry.status === "asking") {
        entry.status = abort.signal.aborted ? "cancelled" : "failed";
        if (!abort.signal.aborted) entry.error = String(error?.message ?? error);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#aborts.delete(entry.id);
      this.#deps.notify();
    }
    return { ok: true, entry: { ...entry } };
  }
};
var LOCAL_OUTPUTS_KEPT = 20;
var LocalOutputs = class {
  #items = /* @__PURE__ */ new Map();
  #seq = 0;
  add(structured) {
    const id = `local-${Date.now().toString(36)}-${++this.#seq}`;
    this.#items.set(id, structured);
    while (this.#items.size > LOCAL_OUTPUTS_KEPT) {
      const first = this.#items.keys().next().value;
      if (first === void 0) break;
      this.#items.delete(first);
    }
    return id;
  }
  get(id) {
    return this.#items.get(id);
  }
  /** The last `/context` report, if any (for tests and the panel). */
  lastContext() {
    const all = [...this.#items.values()];
    for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === "context") return all[i].context;
    return void 0;
  }
};

// packages/dsh-host/src/driver.ts
function imageUnavailableText(mediaType, reason) {
  return `[image unavailable: ${mediaType || "unknown media type"}; ${reason}]`;
}
var JOB_LIMIT_CONFIG_KEY = "maxConcurrentJobsPerOwner";
var CONTEXT_REPORT_MIN_MS = 1e3;
var WORKFLOW_STOP_WAIT_MS = 2e3;
var TASK_OUTPUT_MAX_CHARS = 256 * 1024;
var TASK_KINDS_KEPT = 200;
var ENDED_TASKS_KEPT = 10;
var EventBox = class {
  #items = [];
  #waiter;
  push(i) {
    const w = this.#waiter;
    if (w) {
      this.#waiter = void 0;
      w(i);
    } else this.#items.push(i);
  }
  next() {
    const i = this.#items.shift();
    if (i !== void 0) return Promise.resolve(i);
    return new Promise((r) => this.#waiter = r);
  }
  drain() {
    return this.#items.splice(0);
  }
};
var TURN_EVENTS = /* @__PURE__ */ new Set(["turn-start", "request-start", "step-start", "delta", "step-message", "tool-result"]);
function isChildEvent(e) {
  if (e.type === "agent-start" || e.type === "agent-end" || e.type === "agent-input" || e.type === "team-message")
    return true;
  return TURN_EVENTS.has(e.type) && "agent" in e && e.agent?.kind === "child";
}
var STOP_GRACE_MS = 1e4;
function crashMessage(displayName, error) {
  const why = error ? `: ${error}` : "";
  return `${displayName} stopped unexpectedly${why}. Its open steps were closed. Send a message to start it again; the conversation resumes where it was.`;
}
function recoveryTrigger(displayName, why) {
  const when = why === "restart" ? "while DSH was not running or before it stopped" : "before its process ended";
  return `Read back from ${displayName}'s own record of this conversation: ${displayName} wrote this ${when}, and this session had not shown it yet.`;
}
function recoveryItems(tail) {
  const out = [];
  for (const p of tail.prompts) {
    const t = p.replace(/\s+/g, " ").trim();
    out.push(`it took your message "${t.length > 80 ? `${t.slice(0, 80)}\u2026` : t}"`);
  }
  for (const n of tail.notes) out.push(`it took in ${n}`);
  if (tail.orphanResults > 0)
    out.push(
      `${tail.orphanResults} tool ${tail.orphanResults === 1 ? "result" : "results"} came back for calls shown above as interrupted; ${tail.orphanResults === 1 ? "it is" : "they are"} in the agent's memory`
    );
  return out.slice(0, 20);
}
function endedByStopNotice(displayName, labels) {
  const shown = labels.slice(0, 3).map((l) => `"${l}"`).join(", ");
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : "";
  const what = labels.length === 1 ? "background task" : "background tasks";
  return `When DSH last stopped, ${displayName} stopped with it, and its ${what} ${shown}${more} ended too. ${displayName} was not told; ask it to run ${labels.length === 1 ? "it" : "them"} again if you need ${labels.length === 1 ? "it" : "them"}.`;
}
function childForkNotice(displayName) {
  return `This branch was made from a child agent's session. ${displayName} cannot continue a child agent's conversation as its own, so it starts a new conversation here with no memory of the kept turns.`;
}
var SETTINGS_CHOICE = "settings";
var SessionRuntime = class {
  #factory;
  #port;
  #opts;
  #now;
  #backend;
  #backendAbort;
  #starting;
  /** Backends we end on purpose (reap, dispose, force stop): their exit is not a crash. */
  #ending = /* @__PURE__ */ new WeakSet();
  #forced = false;
  #disposed = false;
  #box;
  #turnActive = false;
  #wakeBuffer;
  #wakePending = false;
  /**
   * Stop's grace time ran out and the driver closed the turn itself: the agent's late events of
   * that stopped turn are dropped until its own turn end, rather than opening a "continued on its
   * own" turn with a result whose call was never written.
   */
  #lateStopped = false;
  #jobs = /* @__PURE__ */ new Map();
  #tasks = /* @__PURE__ */ new Set();
  /** What each background task is, for the plugin task list and for re-linking jobs (D47). */
  #taskInfo = /* @__PURE__ */ new Map();
  /**
   * Ended shells and monitors of this process (R6.2): their rows stay, so their output stays
   * readable after they end. At most ENDED_TASKS_KEPT, cleared at each spawn.
   */
  #endedTasks = /* @__PURE__ */ new Map();
  /** Live child agents (D45). */
  #hub;
  /** Dynamic workflow runs and their native records (D48). */
  #workflows;
  /** Workflow records made while no host agent was attached (D87); written at the next attach. */
  #workflowBacklog = [];
  /** Records a gone process left open in the log were closed once (at the first spawn). */
  #staleChecked = false;
  /** The kind of every task this runtime saw (output route: own shells and monitors only). */
  #taskKinds = /* @__PURE__ */ new Map();
  /** Background work that ended since the last turn: named by the next wake trigger (D26). */
  #wakeNotes = [];
  /** The trigger text of the wake turn waiting to open (D26). */
  #wakeText;
  /** The wake notes the waiting wake text was built from (the trigger card's list, D26). */
  #wakeItems;
  /** The open wake turn still needs its visible trigger, written in its first step. */
  #triggerPending;
  #triggerItems = [];
  /** D15, D51: the main-thread agent picked for a new session, passed at the next spawn. */
  #agentChoice;
  /** The main-thread agent the live process was started with. */
  #mainAgent;
  /** D51: the agent list the live process reported. */
  #agents;
  /** This runtime ran a turn (the main agent is fixed from then on, D15). */
  #hadTurn = false;
  #sent = /* @__PURE__ */ new Map();
  #earlySteers = [];
  #chain = [];
  #superseded = /* @__PURE__ */ new Set();
  #appliedModel;
  #refusedModel;
  #appliedEffort;
  /** D37: the last effort state the live process reported (see LiveInfo.ultracode). */
  #ultracode;
  /** R1.4: the effort level the live process last reported. */
  #effort;
  #effortChoice;
  #pendingMode;
  /** The user picked a mode in this session (D38): a new process of this session keeps it. */
  #modeChosen = false;
  #resetPending = false;
  #live = {};
  #models;
  #idleSince;
  #lastExit;
  /** Asks held until the user answers (rules 3, 4): nothing is ever answered for the user. */
  #desk;
  /** The writer of the open host turn, for the D44 audit pair. */
  #sink;
  /** Audited asks: ask id → audit id and the writer of the turn it is in (D44; root or child). */
  #audits = /* @__PURE__ */ new Map();
  /** The mode choice was read back from the host log once (D24). */
  #modeRestored = false;
  #listeners = /* @__PURE__ */ new Set();
  /** M5: what the agent reported about usage, context, limits and auth (never written to the log). */
  #usage;
  /** The open step was opened by a request and no response has joined it yet (R8.4). */
  #requestStep = false;
  #contextRead;
  /** Told once when the runtime is disposed, so open channels close (D39). */
  #endListeners = /* @__PURE__ */ new Set();
  /** R7.3, D54: side questions and their history (in memory only, D24). */
  #side;
  /** R7.1: the agent's command list (kept after the process ends; it still names what typing runs). */
  #commandList;
  #commandsFull = false;
  #commandsVersion = 0;
  /** The menu placements the port computed last (D52: `taken` needs the host's registry). */
  #menuRows;
  /** R7.4, D55: the MCP servers as last reported or read. Reset at each spawn. */
  #mcp;
  #mcpFrom = "none";
  /** R7.2: structured local-command outputs (display-only path). */
  #local = new LocalOutputs();
  /** M7: the facts the lifecycle view shows. */
  #lifecycle = {};
  /** M7 (D30): "restore code" at this fork's first start. */
  #restoreCode = false;
  /** M7 (R3.6): the read of the agent's own record that runs now, if any. */
  #recovery;
  /** The chain point the last recovery read started from (never read twice from one point). */
  #recoveredFrom;
  /** A recovery found while a turn ran; it opens its own turn after that one. */
  #pendingRecovery;
  /** The wake buffer holds recovered steps (its turn needs no process). */
  #wakeRecovery = false;
  /** The running turn shows only recovered steps. */
  #recoveryTurn = false;
  /** The backend session id recovered steps are bound to while no process runs. */
  #recoverySession;
  /** The open check (`#checkOnOpen`) ran; it runs once, at the latest before the first spawn. */
  #openChecked = false;
  constructor(factory, port, opts) {
    this.#factory = factory;
    this.#port = port;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#usage = new UsageBoard(this.#now);
    this.#desk = new AskDesk(() => this.#notify(), this.#now, {
      opened: (view, info) => this.#auditOpened(view, info),
      closed: (id, outcome) => this.#auditClosed(id, outcome)
    });
    this.#hub = new ChildHub({
      now: this.#now,
      warn: (n, d) => this.#warn(n, d),
      notify: () => this.#notify(),
      createRootChild: (spec, runner) => {
        const create = this.#port?.createChild;
        if (!create) return Promise.reject(new Error("the host session cannot hold child sessions"));
        return create(spec, runner);
      },
      stopTask: (taskId) => {
        const stop = this.#backend?.controls.stopTask;
        if (!stop) return Promise.reject(new Error(`${factory.displayName} is not running`));
        return stop(taskId);
      },
      teamMessaging: () => this.#backend?.capabilities.teamMessaging === true,
      imageText: (mediaType) => imageUnavailableText(mediaType, "child result images are not stored")
    });
    this.#side = new SideQuestionDesk({
      displayName: factory.displayName,
      now: this.#now,
      notify: () => this.#notify(),
      control: () => this.#sideControl()
    });
    this.#workflows = new WorkflowRecorder({
      now: this.#now,
      warn: (n, d) => this.#warn(n, d),
      notify: () => this.#notify(),
      write: (r) => this.#writeWorkflow(r),
      childSession: (id) => this.#hub.session(id)
    });
    queueMicrotask(() => this.#checkOnOpen());
  }
  /**
   * M7: once per runtime, before any process of it runs: background tasks that ended with the last
   * host stop (D75), a branch of a child's session, and replies the agent wrote that the log does
   * not hold (R3.6). No process starts (rule 9); the record read is a file read.
   */
  #checkOnOpen(beforeSpawn = false) {
    const port = this.#port;
    if (this.#openChecked || !port || this.#disposed) return;
    this.#openChecked = true;
    const name2 = this.#factory.displayName;
    try {
      const ended = port.tasksEndedByStop?.() ?? [];
      if (ended.length > 0) {
        this.#lifecycle.endedByStop = ended;
        this.showNotice("warning", endedByStopNotice(name2, ended), "lifecycle");
      }
    } catch (error) {
      this.#warn("could not read the jobs of the last run", String(error?.message ?? error));
    }
    try {
      if (port.forkedFromChild?.() === true) {
        this.#lifecycle.forkedFromChild = true;
        this.showNotice("info", childForkNotice(name2), "lifecycle");
      }
    } catch (error) {
      this.#warn("could not read the fork prefix", String(error?.message ?? error));
    }
    if (!this.#backend && (beforeSpawn || !this.#starting)) this.#recovery = this.#recoverTail("restart");
  }
  /**
   * M7 (R3.6): read what the agent wrote past the log's chain point from its own record. Only the
   * session's own binding counts: past a fork's inherited point lie the source's turns the fork
   * dropped. Found steps open a log-only turn of their own (no process), or join the next turn.
   */
  async #recoverTail(why) {
    const f = this.#factory;
    const port = this.#port;
    if (!f.readSessionTail || !port || this.#disposed) return;
    let binding;
    try {
      binding = port.latestBinding();
    } catch {
      return;
    }
    if (!binding || binding.chainId === void 0) return;
    if (binding.hostSessionId !== void 0 && binding.hostSessionId !== port.hostSessionId) return;
    const from = `${binding.sessionId}:${binding.chainId}`;
    if (this.#recoveredFrom === from) return;
    this.#recoveredFrom = from;
    let tail;
    try {
      tail = await f.readSessionTail(binding.sessionId, port.cwd, binding.chainId);
    } catch (error) {
      this.#warn("could not read the agent record", String(error?.message ?? error));
      return;
    }
    if (this.#disposed) return;
    const name2 = f.displayName;
    if (tail.status === "too-large") {
      this.#lifecycle.recoveryProblem = `${name2}'s record of this conversation is too large to compare, so replies it wrote while this session was not looking may be missing here.`;
      this.#notify();
      return;
    }
    if (tail.status !== "found") {
      this.#warn(`no recovery read (${tail.status})`, binding.chainId);
      return;
    }
    const steps = tail.events.filter((e) => e.type === "step-message").length;
    const list = recoveryItems(tail);
    if (steps === 0) {
      const unseen = tail.notes.length > 0 || tail.orphanResults > 0;
      if (unseen) {
        const note = `${name2} has more than this session shows: ${list.join("; ")}.`;
        this.#lifecycle.recovered = { at: this.#now(), why, steps: 0, note };
        this.showNotice("warning", note, why === "restart" ? "lifecycle" : void 0);
      }
      return;
    }
    this.#lifecycle.recovered = { at: this.#now(), why, steps };
    if (list.length > 0) this.#lifecycle.recovered.note = list.join("; ");
    this.#pendingRecovery = {
      items: [...tail.events, { type: "recovered-end" }],
      text: recoveryTrigger(name2, why),
      list,
      sessionId: binding.sessionId
    };
    this.#flushRecovery();
  }
  /**
   * Open the recovery turn once no turn runs or waits (its steps must not split another turn).
   * `join`: the turn that is starting takes the steps itself, before its input is sent, so the
   * newest turn's binding stays the last one in the log (no wake is asked for).
   */
  #flushRecovery(join4 = false) {
    const r = this.#pendingRecovery;
    if (!r || this.#wakeBuffer !== void 0 || this.#disposed) return;
    if (this.#turnActive && !join4) return;
    this.#pendingRecovery = void 0;
    this.#wakeBuffer = [...r.items];
    this.#wakeRecovery = true;
    this.#recoverySession = r.sessionId;
    this.#wakeText = r.text;
    this.#wakeItems = r.list;
    if (!join4) {
      const port = this.#port;
      if (port) port.wake(r.text);
      else this.#wakePending = true;
    }
    this.#notify();
  }
  /** D48: one native workflow record into the parent session; held while no host agent is attached. */
  #writeWorkflow(r) {
    const port = this.#port;
    if (!port) {
      this.#workflowBacklog.push(r);
      return;
    }
    port.recordWorkflow?.(r);
  }
  /**
   * D44: an ask of the main thread shown while its host turn is open gets the host's native
   * audit pair. An ask outside a turn writes nothing (the pair must be turn-enclosed); a
   * subagent's ask waits for child sessions (D45) and is not audited in the parent's log.
   */
  #auditOpened(view, info) {
    const sink = view.agent === "main" ? this.#turnActive ? this.#sink : void 0 : view.agentId !== void 0 ? this.#hub.openSink(view.agentId) : void 0;
    if (!sink?.approvalAsked) return;
    try {
      const id = sink.approvalAsked(info);
      if (id !== void 0) this.#audits.set(view.id, { id, sink });
    } catch (error) {
      this.#warn("could not record the approval audit", String(error?.message ?? error));
    }
  }
  #auditClosed(askId, outcome) {
    const a = this.#audits.get(askId);
    if (a === void 0) return;
    this.#audits.delete(askId);
    try {
      a.sink.approvalDecided?.(a.id, outcome);
    } catch (error) {
      this.#warn("could not record the approval outcome", String(error?.message ?? error));
    }
  }
  /** D74: an audited ask still open when the turn ends is `cancelled` in the host log. */
  #closeAudits() {
    const sink = this.#sink;
    for (const [id, a] of [...this.#audits]) if (a.sink === sink) this.#auditClosed(id, "cancelled");
  }
  /**
   * Live updates for the interaction channel (D39): the listener gets the whole view after every
   * change (asks, state). Returns the unsubscribe function.
   */
  /**
   * Show one line to the user outside the conversation (the plugin's status line), for example
   * the answer of our `/permission` command: DSH does not show a command's result in the chat.
   */
  showNotice(level, text, topic) {
    if (this.#disposed) return;
    this.#live.notice = { level, text, at: this.#now(), ...topic ? { topic } : {} };
    this.#notify();
  }
  subscribe(listener, onEnd) {
    if (this.#disposed) {
      onEnd?.();
      return () => {
      };
    }
    this.#listeners.add(listener);
    if (onEnd) this.#endListeners.add(onEnd);
    return () => {
      this.#listeners.delete(listener);
      if (onEnd) this.#endListeners.delete(onEnd);
    };
  }
  /**
   * D24, R1.4: after a host restart the user's mode choice is read back from the binding in the
   * host log (written only after a choice) and becomes a pending choice, applied right after the
   * next spawn (D4). Once per runtime; a choice made in this run wins. Only the session's own
   * binding counts: a DSH fork inherits the parent's binding, but the parent's choice was for the
   * parent, so a fork starts in the user's settings mode (rule 4). What the TUI does on a fork is **unverified**.
   */
  #restoreMode() {
    if (this.#modeRestored || !this.#port) return;
    this.#modeRestored = true;
    if (this.#modeChosen) return;
    let mode;
    try {
      const b = this.#port.latestBinding();
      const inherited = b?.hostSessionId !== void 0 && b.hostSessionId !== this.#port.hostSessionId;
      mode = inherited ? void 0 : b?.mode;
    } catch {
      mode = void 0;
    }
    if (mode === void 0 || !this.#factory.staticCapabilities.permissionModes.some((m) => m.id === mode)) return;
    this.#pendingMode = mode;
    this.#modeChosen = true;
  }
  get backend() {
    return this.#backend;
  }
  get runningJobs() {
    return this.#jobs.size;
  }
  get attached() {
    return this.#port !== void 0;
  }
  get turnActive() {
    return this.#turnActive;
  }
  state() {
    const s = {
      process: this.#backend ? "running" : this.#starting ? "starting" : "none",
      turn: this.#turnActive,
      backgroundTasks: Math.max(this.#tasks.size, this.#jobs.size)
    };
    if (this.#desk.size > 0) s.waiting = this.#desk.size;
    if (this.#lastExit) s.lastExit = { ...this.#lastExit };
    return s;
  }
  #warn(note, detail) {
    this.#port?.warn(note, detail);
  }
  #notify() {
    try {
      this.#port?.notify?.(this.state());
    } catch (error) {
      this.#warn("state listener failed", String(error));
    }
    if (this.#listeners.size === 0) return;
    const view = this.view();
    for (const listener of [...this.#listeners]) {
      try {
        listener(view);
      } catch (error) {
        this.#warn("interaction listener failed", String(error));
      }
    }
  }
  /** Bind a new host agent (D87: after an eviction). A turn the agent started meanwhile wakes now. */
  attach(port) {
    this.#port = port;
    const backlog = this.#workflowBacklog;
    this.#workflowBacklog = [];
    for (const r of backlog) {
      try {
        port.recordWorkflow?.(r);
      } catch (error) {
        this.#warn(`could not record workflow ${r.kind}`, String(error?.message ?? error));
      }
    }
    for (const taskId of this.#tasks) if (!this.#jobs.has(taskId)) this.#linkJob(taskId);
    if (this.#wakePending && this.#wakeBuffer !== void 0) {
      this.#wakePending = false;
      port.wake(this.#wakeText ?? this.#wakeSummary());
    }
    this.#notify();
  }
  /** D26: the wake trigger's text: what ended in the background since the last turn. */
  #wakeSummary() {
    const name2 = this.#factory.displayName;
    const notes = this.#wakeNotes;
    if (notes.length === 0) return `${name2} continued on its own`;
    const shown = notes.slice(-3).join("; ");
    const more = notes.length > 3 ? ` (and ${notes.length - 3} more)` : "";
    return `${name2} continued on its own after: ${shown}${more}`;
  }
  /** D47: mirror one running task as a host job, or give it a plugin-only row. */
  #linkJob(taskId) {
    const info = this.#taskInfo.get(taskId);
    const port = this.#port;
    if (!info || !port) return;
    const backend = this.#backend;
    const stop = () => {
      if (info.kind === "workflow") this.#workflows.noteStop(taskId);
      void backend?.controls.stopTask?.(taskId).catch((err) => {
        if (info.kind === "workflow") this.#workflows.clearStop(taskId);
        this.#warn("stopTask failed", String(err));
      });
    };
    let link;
    try {
      link = port.startJob({ taskId, kind: info.kind, label: info.label }, stop, () => {
        if (this.#jobs.get(taskId) === current2) this.#jobs.delete(taskId);
        const i = this.#taskInfo.get(taskId);
        if (i && i.status === "running") i.job = false;
      });
    } catch (error) {
      link = { refused: String(error?.message ?? error) };
    }
    const current2 = link !== void 0 && !("refused" in link) ? link : void 0;
    if (current2) {
      this.#jobs.set(taskId, current2);
      info.job = true;
      delete info.note;
      return;
    }
    info.job = false;
    if (link && "refused" in link && link.limit)
      info.note = `The host's background job limit is reached (${JOB_LIMIT_CONFIG_KEY} in the profile config), so this task shows only here.`;
    else if (link && "refused" in link) info.note = "The host did not take this task as a job, so it shows only here.";
  }
  /** The host agent went away; the process and its background tasks keep running (rules 6, 7). */
  detach() {
    this.#port = void 0;
  }
  /** D30: record a file restore (a fork's first start, or "Restore code" in place) for the UI. */
  #noteRewind(inputId, result) {
    if (result.dryRun) return;
    this.#lifecycle.rewind = { inputId, result, at: this.#now() };
    const name2 = this.#factory.displayName;
    if (result.ok) {
      const n = result.filesChanged.length;
      this.showNotice(
        "info",
        n === 0 ? "No file needed restoring." : `Restored ${n} ${n === 1 ? "file" : "files"}.`,
        "lifecycle"
      );
    } else
      this.showNotice(
        "warning",
        `${name2} did not restore the files: ${result.error ?? "no reason given"}`,
        "lifecycle"
      );
  }
  /** The session is a fork that has not started its own process yet (D29). */
  #unstartedFork() {
    const port = this.#port;
    if (!port || this.#backend || this.#starting) return false;
    if (this.#factory.staticCapabilities.fork !== "at-chain-point") return false;
    try {
      const b = port.latestBinding();
      return b?.hostSessionId !== void 0 && b.hostSessionId !== port.hostSessionId && b.chainId !== void 0;
    } catch {
      return false;
    }
  }
  /** D30, M7: what the rewind dialog may offer now. Never starts a process. */
  async rewindOptions() {
    const running = this.#backend !== void 0;
    let fileRewind = this.#backend?.capabilities.fileRewind === true;
    if (!running && this.#port && this.#factory.fileRewindAvailable) {
      try {
        fileRewind = await this.#factory.fileRewindAvailable(this.#port.cwd);
      } catch (error) {
        this.#warn("could not read the checkpoint setting", String(error?.message ?? error));
      }
    }
    let points = [];
    try {
      points = this.#port?.rewindPoints?.() ?? [];
    } catch (error) {
      this.#warn("could not read the rewind points", String(error?.message ?? error));
    }
    return {
      running,
      fileRewind,
      unstartedFork: this.#unstartedFork(),
      restoreCodePending: this.#restoreCode,
      displayName: this.#factory.displayName,
      points
    };
  }
  /**
   * D30 "restore code and conversation": the fork's first start also puts the files back as they
   * were before the first dropped turn. Only for a fork that has not started yet.
   */
  requestCodeRestore(on) {
    if (!on) {
      this.#restoreCode = false;
      this.#notify();
      return { ok: true };
    }
    if (!this.#unstartedFork())
      return { ok: false, error: "only a branch that has not started yet can restore code at its start" };
    this.#restoreCode = true;
    this.#notify();
    return { ok: true };
  }
  /**
   * D30 "Restore code" (in place): the files go back to before the turn of this host message ran;
   * the conversation stays. `dryRun` only reports what would change. Needs the live process; never
   * while a turn runs.
   */
  async rewindFiles(hostMessageId, dryRun) {
    const b = this.#backend;
    const control = b?.controls.rewindFiles;
    if (!b) return { ok: false, code: "not-running", error: `${this.#factory.displayName} is not running` };
    if (!control || !b.capabilities.fileRewind)
      return { ok: false, code: "unsupported", error: `${this.#factory.displayName} keeps no file checkpoints here` };
    if (this.#turnActive && !dryRun) return { ok: false, code: "busy", error: "wait until the turn ends" };
    const inputId = this.#factory.inputIdFor?.(hostMessageId) ?? hostMessageId;
    let result;
    try {
      result = await control(inputId, { dryRun });
    } catch (error) {
      return { ok: false, code: "failed", error: String(error?.message ?? error) };
    }
    this.#noteRewind(inputId, result);
    return result.ok ? { ok: true, result } : { ok: false, code: "failed", result, ...result.error ? { error: result.error } : {} };
  }
  /** "Start <displayName>" (D4): spawn without sending anything. */
  async start() {
    const backend = await this.#ensureBackend();
    await this.#applyChoices(backend);
  }
  /** What the plugin's session controls show (D35-D38, D4). */
  view() {
    this.#restoreMode();
    const choice = { applied: {}, resetPending: this.#resetPending, agentLocked: this.#agentLocked() };
    if (this.#agentChoice !== void 0) choice.agent = this.#agentChoice;
    const model = this.#port?.modelChoice?.();
    if (model !== void 0) choice.model = model;
    if (this.#effortChoice !== void 0) choice.effort = this.#effortChoice;
    if (this.#pendingMode !== void 0) choice.pendingMode = this.#pendingMode;
    if (this.#appliedModel !== void 0) choice.applied.model = this.#appliedModel;
    if (this.#refusedModel !== void 0) choice.refused = { model: this.#refusedModel };
    if (this.#appliedEffort !== void 0) choice.applied.effort = this.#appliedEffort;
    const v = { state: this.state(), live: { ...this.#live }, choice };
    if (this.#ultracode !== void 0) v.live.ultracode = { ...this.#ultracode };
    if (this.#effort !== void 0) v.live.effort = this.#effort;
    if (this.#models) v.models = this.#models.map((m) => ({ ...m }));
    if (this.#port) v.cwd = this.#port.cwd;
    if (this.#backend) v.backendSessionId = this.#backend.sessionId;
    const asks = this.#desk.list();
    if (asks.length > 0) v.asks = asks;
    if (this.#hub.size > 0) v.children = this.#hub.views();
    const team = this.#hub.team();
    if (team) v.team = team;
    if (this.#taskInfo.size > 0 || this.#endedTasks.size > 0)
      v.tasks = [...this.#taskInfo.values(), ...this.#endedTasks.values()].map((t) => ({ ...t }));
    if (this.#agents) v.agents = this.#agents.map((a) => ({ ...a }));
    if (this.#workflows.size > 0) {
      v.workflows = this.#workflows.views();
      v.workflowAgentStop = this.#backend?.capabilities.workflowAgentStop === true;
    }
    const lifecycle = { ...this.#lifecycle };
    if (this.#restoreCode) lifecycle.restoreCodePending = true;
    if (!this.#backend && this.#unstartedFork()) lifecycle.unstartedFork = true;
    if (Object.keys(lifecycle).length > 0) v.lifecycle = lifecycle;
    const usage = this.#usage.summary();
    if (usage) v.usage = usage;
    const side = this.#side.view();
    if (side.entries.length > 0) v.side = side;
    if (this.#commandList)
      v.menu = { version: this.#commandsVersion, count: this.#commandList.length, full: this.#commandsFull };
    if (this.#mcp) v.mcp = this.#mcp.map((m) => ({ name: m.name, status: m.status }));
    return v;
  }
  // ---- M6: commands, side questions, MCP, local outputs (R7.1-R7.4) ----
  /** R7.1: the agent's command list as known now (the port builds the host menu from it). */
  commandList() {
    return {
      list: this.#commandList?.map((c) => ({ ...c })),
      full: this.#commandsFull,
      version: this.#commandsVersion
    };
  }
  /** The port's menu placements (D52), so the commands route can name the taken rows. */
  noteMenu(rows) {
    const changed = JSON.stringify(rows) !== JSON.stringify(this.#menuRows);
    this.#menuRows = rows.map((r) => ({ ...r }));
    if (changed) {
      this.#commandsVersion++;
      this.#notify();
    }
  }
  #setCommands(list, full) {
    this.#commandList = list.map((c) => ({ ...c }));
    this.#commandsFull = full;
    this.#commandsVersion++;
    this.#menuRows = void 0;
    try {
      this.#port?.commandsChanged?.();
    } catch (error) {
      this.#warn("could not update the / menu", String(error?.message ?? error));
    }
    this.#notify();
  }
  /** The agent sent names only: read the full rows (descriptions, hints) from the live process. */
  #loadCommands(backend) {
    const read = backend.controls.commands;
    if (!read) return;
    read.call(backend.controls).then(
      (list) => {
        if (backend !== this.#backend || !Array.isArray(list)) return;
        this.#setCommands(list, true);
      },
      (error) => this.#warn("reading the command list failed", String(error?.message ?? error))
    );
  }
  /**
   * R7.1: the commands route. With a process and only names known, the full rows are read once
   * (the agent's own command list, no model call). Never starts a process (rule 9, D4).
   */
  async commandsAnswer() {
    const backend = this.#backend;
    let reason;
    let from = this.#commandList ? "reported" : "none";
    if (backend && !this.#commandsFull && backend.controls.commands) {
      try {
        const list = await backend.controls.commands.call(backend.controls);
        if (backend === this.#backend && Array.isArray(list)) {
          this.#setCommands(list, true);
          from = "live";
        }
      } catch (e) {
        reason = String(e?.message ?? e);
      }
    }
    const { sideQuestionCommand, mcpCommand, rewindCommand } = this.#factory.staticCapabilities;
    const rows = this.#menuRows ?? planCommandMenu(this.#commandList ?? [], {
      displayName: this.#factory.displayName,
      ...sideQuestionCommand !== void 0 ? { sideQuestionCommand } : {},
      ...mcpCommand !== void 0 ? { mcpCommand } : {},
      ...rewindCommand !== void 0 ? { rewindCommand } : {}
    }).rows;
    const answer = {
      running: backend !== void 0,
      from,
      full: this.#commandsFull,
      rows: rows.map((r) => ({ ...r })),
      displayName: this.#factory.displayName
    };
    if (sideQuestionCommand !== void 0) answer.sideQuestionCommand = sideQuestionCommand;
    if (mcpCommand !== void 0) answer.mcpCommand = mcpCommand;
    if (rewindCommand !== void 0) answer.rewindCommand = rewindCommand;
    if (reason !== void 0) answer.reason = reason;
    return answer;
  }
  #sideControl() {
    const backend = this.#backend;
    if (!backend) return { kind: "not-running" };
    const ask = backend.controls.askSideQuestion;
    if (!ask || !backend.capabilities.sideQuestions) return { kind: "unsupported" };
    return { kind: "ready", ask: (q, history, signal) => ask.call(backend.controls, q, history, signal) };
  }
  /**
   * R7.3, D54: one side question. Full context, no tools, nothing written to either log. With no
   * process the question waits and is asked after the user starts the agent (D4).
   */
  askSideQuestion(question, signal) {
    if (this.#disposed) return Promise.resolve({ ok: false, code: "unsupported", error: "the session is closed" });
    return this.#side.ask(question, signal);
  }
  sideQuestions() {
    return this.#side.view();
  }
  cancelSideQuestion(id) {
    return this.#side.cancel(id);
  }
  /** R7.4, D55: the MCP servers, read from the live process when it can. Never spawns. */
  async mcp() {
    const backend = this.#backend;
    const answer = (reason) => {
      const a = {
        running: backend !== void 0,
        from: this.#mcpFrom,
        servers: (this.#mcp ?? []).map((m) => ({ ...m }))
      };
      if (reason !== void 0) a.reason = reason;
      return a;
    };
    if (!backend) return answer("not-running");
    const read = backend.controls.mcpStatus;
    if (!read) return answer("unsupported");
    try {
      const servers = await read.call(backend.controls);
      if (backend !== this.#backend) return answer("not-running");
      this.#mcp = Array.isArray(servers) ? servers.map((m) => ({ ...m })) : [];
      this.#mcpFrom = "live";
      this.#notify();
      return answer();
    } catch (e) {
      return answer(String(e?.message ?? e));
    }
  }
  /**
   * D55: reconnect, toggle or sign in one MCP server. The name must be one the agent listed (it is
   * untrusted text, passed back unchanged). The agent saves a toggle itself; its note is shown as
   * given. Never writes a settings file (rule 2) and never spawns.
   */
  async mcpAction(action, name2, arg) {
    const backend = this.#backend;
    const label = this.#factory.displayName;
    if (!backend) return { ok: false, code: "not-running", error: `${label} is not running. Start it first.` };
    const c = backend.controls;
    const fn = action === "reconnect" ? c.mcpReconnect : action === "toggle" ? c.mcpToggle : action === "authenticate" ? c.mcpAuthenticate : c.mcpSubmitAuthCallback;
    if (!fn) return { ok: false, code: "unsupported", error: `This ${label} version cannot do that.` };
    let known = this.#mcp;
    if (!known?.some((m) => m.name === name2)) known = (await this.mcp()).servers;
    if (!known.some((m) => m.name === name2))
      return { ok: false, code: "unknown-server", error: `${label} lists no MCP server with that name.` };
    try {
      let note;
      let auth;
      if (action === "reconnect") await c.mcpReconnect.call(c, name2);
      else if (action === "toggle") note = (await c.mcpToggle.call(c, name2, arg?.enabled === true))?.note;
      else if (action === "authenticate") auth = await c.mcpAuthenticate.call(c, name2);
      else await c.mcpSubmitAuthCallback.call(c, name2, arg?.callbackUrl ?? "");
      const mcp = await this.mcp();
      const r = { ok: true, mcp };
      if (note !== void 0) r.note = note;
      if (auth !== void 0) r.auth = auth;
      return r;
    } catch (e) {
      return { ok: false, code: "failed", error: String(e?.message ?? e), mcp: await this.mcp() };
    }
  }
  /** R7.2: one structured local-command output (display-only; the text is in the host log). */
  localOutput(id) {
    return this.#local.get(id);
  }
  /**
   * M5 usage panel (D58-D60): the board, refreshed from the live process's usage control when one
   * runs. Never starts a process (rule 9) and never makes a model call.
   */
  async usage() {
    const backend = this.#backend;
    const read = backend?.controls.usageSnapshot;
    let error;
    if (backend && read) {
      try {
        const snap = await read.call(backend.controls);
        if (backend === this.#backend) this.#usage.snapshot(snap);
      } catch (e) {
        error = String(e?.message ?? e);
      }
    }
    const answer = { running: backend !== void 0, usage: this.#usage.view() };
    if (error !== void 0) answer.error = error;
    return answer;
  }
  /**
   * M5 context pill and panel (D59): the agent's own report, read from the live process only
   * (Claude: `getContextUsage`). No process: the last known figure and `not-running`; the pill
   * offers "Start" (D4). Reports closer than CONTEXT_REPORT_MIN_MS share one read.
   */
  contextUsage(detail = "summary") {
    const backend = this.#backend;
    const last = (reason) => {
      const a = { running: backend !== void 0, reason };
      const c = this.#usage.context;
      if (c) a.context = c;
      return a;
    };
    if (!backend) return Promise.resolve(last("not-running"));
    const read = backend.controls.contextUsage;
    if (!read) return Promise.resolve(last("unsupported"));
    const now = this.#now();
    const prior = this.#contextRead;
    if (prior && now - prior.at < CONTEXT_REPORT_MIN_MS && (prior.detail === detail || detail === "summary"))
      return prior.promise;
    const promise = (async () => {
      try {
        const r = await read.call(backend.controls, detail);
        if (backend !== this.#backend) return last("not-running");
        const c = this.#usage.report(r);
        this.#notify();
        const a = { running: true };
        if (c) a.context = c;
        return a;
      } catch (e) {
        return last(String(e?.message ?? e));
      }
    })();
    this.#contextRead = { at: now, detail, promise };
    return promise;
  }
  /**
   * D15: the main-thread agent is fixed once the session had a turn (here, or before a restart:
   * the host log then holds a binding), and for a backend without the picker.
   */
  #agentLocked() {
    if (this.#factory.staticCapabilities.mainAgentPicker === "none") return true;
    if (this.#factory.staticCapabilities.mainAgentPicker === "any-time") return false;
    return this.#hadTurn || this.#turnActive || this.#port?.latestBinding() !== void 0;
  }
  /**
   * D46: stop one child agent (its task); the others and the main turn keep running. Waits up to
   * 2 s for the agent's own end, then reports "stopping".
   */
  stopChild(childId) {
    if (this.#hub.role(childId) === "workflow-agent" && this.#backend?.capabilities.workflowAgentStop !== true) {
      const status = this.#hub.views().find((c) => c.id === childId)?.status ?? "unknown";
      return Promise.resolve({ ok: false, status, error: this.#noAgentStopText() });
    }
    return this.#hub.stop(childId);
  }
  #noAgentStopText() {
    return `${this.#factory.displayName} cannot stop one agent of a workflow. Stop the whole workflow instead.`;
  }
  /**
   * D48: "Stop entire workflow": the backend's per-task stop on the run. Waits up to 2 s for the
   * run's own end, then reports "stopping". The process and other tasks keep running (rule 6).
   */
  async stopWorkflow(taskId, waitMs2 = WORKFLOW_STOP_WAIT_MS) {
    if (!this.#workflows.has(taskId))
      return { ok: false, status: "unknown", error: "no such workflow in this session" };
    const current2 = () => this.#workflows.views().find((w) => w.taskId === taskId)?.status ?? "unknown";
    if (!this.#workflows.isLive(taskId)) return { ok: true, status: current2() };
    const stop = this.#backend?.controls.stopTask;
    if (!stop) return { ok: false, status: current2(), error: `${this.#factory.displayName} cannot stop a workflow` };
    this.#workflows.noteStop(taskId);
    try {
      await stop(taskId);
    } catch (error) {
      this.#workflows.clearStop(taskId);
      return { ok: false, status: current2(), error: String(error?.message ?? error) };
    }
    const end = Date.now() + waitMs2;
    while (this.#workflows.isLive(taskId) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: this.#workflows.isLive(taskId) ? "stopping" : current2() };
  }
  /**
   * D48: stop one agent of a workflow. Only when the backend can (Claude Code cannot: the user
   * gets the plain reason and the "Stop entire workflow" path, nothing is sent to the agent).
   */
  async stopWorkflowAgent(taskId, agentId) {
    const run = this.#workflows.views().find((w) => w.taskId === taskId);
    if (!run || !run.agents.some((a) => a.agentId === agentId))
      return { ok: false, status: "unknown", error: "no such workflow agent in this session" };
    if (this.#backend?.capabilities.workflowAgentStop !== true)
      return { ok: false, status: "unknown", error: this.#noAgentStopText(), unsupported: true };
    return this.#hub.stop(agentId);
  }
  /**
   * The output of one background shell or monitor task of this session (R6.2, the client's
   * output view). Only tasks this session's own process started; never a workflow or an agent.
   */
  async taskOutput(taskId) {
    const kind = this.#taskKinds.get(taskId);
    if (kind === void 0) return { ok: false, code: "unknown", error: "no such task in this session" };
    if (kind !== "shell" && kind !== "monitor")
      return { ok: false, code: "unsupported", error: "only background shells and monitors have an output" };
    const read = this.#backend?.controls.taskOutput;
    if (!read)
      return { ok: false, code: "unsupported", error: `${this.#factory.displayName} cannot show task output now` };
    try {
      const o = await read(taskId);
      const text = typeof o.output === "string" ? o.output : "";
      if (text.length <= TASK_OUTPUT_MAX_CHARS)
        return { ok: true, output: text, totalBytes: o.totalBytes, truncated: o.truncated };
      return { ok: true, output: text.slice(-TASK_OUTPUT_MAX_CHARS), totalBytes: o.totalBytes, truncated: true };
    } catch (error) {
      return { ok: false, code: "failed", error: String(error?.message ?? error) };
    }
  }
  #noteTaskKind(taskId, kind) {
    this.#taskKinds.delete(taskId);
    this.#taskKinds.set(taskId, kind);
    if (this.#taskKinds.size > TASK_KINDS_KEPT) {
      const first = this.#taskKinds.keys().next().value;
      if (first !== void 0) this.#taskKinds.delete(first);
    }
  }
  /** D47: stop one background task from the plugin task list (a fallback row, or any task). */
  async stopTask(taskId) {
    const backend = this.#backend;
    if (!this.#tasks.has(taskId)) return { ok: false, error: "no such running task" };
    if (!backend?.controls.stopTask) return { ok: false, error: `${this.#factory.displayName} cannot stop one task` };
    try {
      await backend.controls.stopTask(taskId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  /** The user answered one ask in the UI. False when it is gone or the choice is not offered. */
  answer(askId, choiceId) {
    return this.#desk.answer(askId, choiceId);
  }
  /** The user's full answer (feedback, question form, elicitation content). First answer wins. */
  respond(askId, reply) {
    return this.#desk.respond(askId, reply);
  }
  /**
   * D73: before a spawn in a folder the agent does not trust yet, ask the user the agent's own
   * trust question. Returns the folder to trust only after the user's accept click; throws on a
   * decline (the agent's terminal app exits then). An unreadable record spawns without trust and
   * says what may not apply.
   */
  async #trustFor(cwd, setNotice) {
    const f = this.#factory;
    if (!f.trustState) return void 0;
    let t;
    try {
      t = await f.trustState(cwd);
    } catch (error) {
      this.#warn("reading the workspace trust failed", String(error));
      t = void 0;
    }
    if (t?.state === "trusted") return void 0;
    const effect = t?.untrustedEffect ?? "project settings may not apply";
    if (!t || t.state === "unknown" || !t.question) {
      setNotice(
        `${f.displayName} could not tell whether it trusts this folder: ${effect} until you trust it in the ${f.displayName} terminal app.`
      );
      return void 0;
    }
    const accepted = await this.#desk.trust(t.question, t.directory);
    if (!accepted)
      throw new Error(
        `you did not trust this folder, so ${f.displayName} was not started (its terminal app exits too). Send a message to be asked again.`
      );
    return { directory: t.directory };
  }
  /**
   * A session-only choice from the UI (D35-D38). Model choices are recorded in the host log
   * through the port (session-only, D36); effort and mode stay in memory (D24). A choice made
   * before the spawn is applied right after it (D4). Nothing is ever written to settings files.
   */
  async choose(req) {
    this.#restoreMode();
    const caps = this.#factory.staticCapabilities;
    const notes = [];
    const fail3 = (error) => ({ ok: false, error, view: this.view() });
    if (req.mode !== void 0 && !caps.permissionModes.some((m) => m.id === req.mode))
      return fail3(`unknown mode: ${req.mode}`);
    if (req.mode !== void 0 && !offeredPermissionModes(caps.permissionModes, this.#opts.userConfig?.().options, [
      this.#live.mode,
      // The same list the picker shows (routes): the settings mode is offered before a spawn too.
      await this.#settingsMode()
    ]).some((m) => m.id === req.mode))
      return fail3(`${req.mode} is not available in this session (it needs a ${this.#factory.displayName} option)`);
    const effortId = req.effort === null || req.effort === SETTINGS_CHOICE ? null : req.effort;
    if (typeof effortId === "string" && !(caps.efforts ?? []).some((e) => e.id === effortId))
      return fail3(`unknown effort: ${effortId}`);
    const agentId = req.agent === null || req.agent === SETTINGS_CHOICE ? null : req.agent;
    if (req.agent !== void 0 && this.#agentLocked())
      return fail3(
        caps.mainAgentPicker === "none" ? `${this.#factory.displayName} has no main-thread agent picker` : "the main-thread agent can only be picked before the first message of a new session"
      );
    if (req.model !== void 0) {
      if (!this.#port?.selectModel) return fail3("the session is not open");
      this.#port.selectModel(req.model);
      if (req.model === SETTINGS_CHOICE && this.#appliedModel !== void 0) this.#resetPending = true;
    }
    if (req.effort !== void 0) {
      this.#effortChoice = effortId ?? void 0;
      if (effortId === null && this.#appliedEffort !== void 0) this.#resetPending = true;
    }
    if (req.mode !== void 0) {
      this.#pendingMode = req.mode;
      this.#modeChosen = true;
    }
    let agentNote;
    if (req.agent !== void 0 && (agentId ?? void 0) !== this.#agentChoice) {
      this.#agentChoice = agentId ?? void 0;
      if (this.#backend && (agentId ?? void 0) !== this.#mainAgent) agentNote = await this.#restartForAgent();
      else agentNote = `applies when ${this.#factory.displayName} starts`;
    }
    const backend = this.#backend;
    if (agentNote !== void 0 && req.model === void 0 && req.effort === void 0 && req.mode === void 0) {
      this.#notify();
      return { ok: true, note: agentNote, view: this.view() };
    }
    if (agentNote !== void 0) notes.push(agentNote);
    if (this.#resetPending) notes.push(await this.#resetIfIdle());
    else if (backend) {
      const error = await this.#applyChoices(backend);
      if (error) return fail3(error);
      notes.push("applied");
    } else notes.push(`applies when ${this.#factory.displayName} starts`);
    this.#notify();
    return { ok: true, note: notes.filter(Boolean).join("; "), view: this.view() };
  }
  /** The mode the user's settings pick (display read, no process, D83); undefined when unknown. */
  async #settingsMode() {
    const cwd = this.#port?.cwd;
    if (cwd === void 0 || !this.#factory.settingsDefaults) return void 0;
    try {
      return (await this.#factory.settingsDefaults(cwd)).permissionMode;
    } catch {
      return void 0;
    }
  }
  /**
   * D15: a main-agent pick after "Start" and before the first message. The process has no turn yet;
   * it ends (nothing runs) and the next message starts it again with the agent as a start option.
   */
  async #restartForAgent() {
    const b = this.#backend;
    if (!b) return `applies when ${this.#factory.displayName} starts`;
    if (this.#starting !== void 0 || this.#tasks.size > 0 || this.#jobs.size > 0 || this.#turnActive)
      return `${this.#factory.displayName} is busy; the agent applies at its next start`;
    await this.#end(false);
    if (this.#backend === b) {
      this.#backend = void 0;
      this.#backendAbort = void 0;
    }
    this.#carryMode();
    this.#appliedModel = void 0;
    this.#refusedModel = void 0;
    this.#appliedEffort = void 0;
    this.#ultracode = void 0;
    this.#effort = void 0;
    this.#live = {};
    this.#mainAgent = void 0;
    return `${this.#factory.displayName} starts again with this agent at the next message`;
  }
  /** D35 exact reset: restart with resume and no choices, but only when nothing runs. */
  async #resetIfIdle(inTurn = false) {
    if (!this.#resetPending) return "";
    const b = this.#backend;
    if (!b) {
      this.#resetPending = false;
      return `your settings apply when ${this.#factory.displayName} starts`;
    }
    const busy = !inTurn && this.#turnActive || this.#starting !== void 0 || this.#wakeBuffer !== void 0;
    if (busy || this.#tasks.size > 0 || this.#jobs.size > 0)
      return `your settings apply after ${this.#factory.displayName} restarts; it restarts at the next message once no work runs`;
    await this.#end(false);
    if (this.#backend === b) {
      this.#backend = void 0;
      this.#backendAbort = void 0;
    }
    this.#carryMode();
    this.#appliedModel = void 0;
    this.#refusedModel = void 0;
    this.#appliedEffort = void 0;
    this.#ultracode = void 0;
    this.#effort = void 0;
    this.#live = {};
    this.#resetPending = false;
    return `${this.#factory.displayName} will start again with your settings at the next message`;
  }
  /**
   * D28, D70 (M7 live): the conversation the agent runs under now. A `/clear` (as the last
   * message before a restart) gives it a new id with no step to bind; the agent's own record of
   * the newest human messages says which conversation took them. Their own binding else.
   */
  async #conversationNow(bound) {
    const f = this.#factory;
    const port = this.#port;
    if (!f.sessionHoldingInput || !port?.rewindPoints) return bound;
    let points;
    try {
      points = port.rewindPoints().filter((p) => !p.inherited);
    } catch {
      return bound;
    }
    for (const p of points.slice(-2).reverse()) {
      try {
        const held = await f.sessionHoldingInput(f.inputIdFor?.(p.messageId) ?? p.messageId, port.cwd, bound);
        if (held === void 0) continue;
        if (held !== bound) this.#warn("resuming the conversation that took the last message", held);
        return held;
      } catch (error) {
        this.#warn("could not read the agent record", String(error?.message ?? error));
        return bound;
      }
    }
    return bound;
  }
  async #ensureBackend() {
    if (this.#disposed) throw new Error("the session is closed");
    if (this.#backend) return this.#backend;
    const port = this.#port;
    if (!port) throw new Error(`${this.#factory.displayName} cannot start: the session is not open`);
    this.#restoreMode();
    this.#starting ??= (async () => {
      const f = this.#factory;
      this.#checkOnOpen(true);
      await this.#recovery?.catch(() => void 0);
      const binding = port.latestBinding();
      const bound = binding?.sessionId;
      const derived = f.sessionIdFor?.(port.hostSessionId);
      const inherited = binding?.hostSessionId !== void 0 && binding.hostSessionId !== port.hostSessionId;
      let start;
      let startNotice;
      const forkRan = binding !== void 0 && inherited && derived !== void 0 && f.staticCapabilities.resume && await f.sessionExists?.(derived, port.cwd) === true;
      if (forkRan) {
        start = { kind: "resume", sessionId: derived };
        this.#restoreCode = false;
      } else if (binding && inherited && f.staticCapabilities.fork !== "none") {
        const fork = {
          kind: "fork",
          fromSessionId: binding.sessionId
        };
        if (derived !== void 0) fork.newSessionId = derived;
        if (binding.chainId !== void 0 && f.staticCapabilities.fork === "at-chain-point") {
          fork.atChainId = binding.chainId;
          let dropped;
          try {
            dropped = await port.forkDroppedMessage?.();
          } catch (error) {
            this.#warn("could not read the fork source", String(error?.message ?? error));
          }
          const hint = dropped === void 0 ? void 0 : f.inputIdFor?.(dropped) ?? dropped;
          if (hint !== void 0) fork.dropsTurnHint = hint;
          if (this.#restoreCode) {
            if (hint !== void 0) fork.restoreFilesAt = hint;
            else
              startNotice = "The files were not restored: the turn after the branch point has no message of yours to restore to.";
          }
        }
        this.#restoreCode = false;
        start = fork;
      } else if (bound !== void 0 && f.staticCapabilities.resume)
        start = { kind: "resume", sessionId: await this.#conversationNow(bound) };
      else if (derived !== void 0 && await f.sessionExists?.(derived, port.cwd) === true && f.staticCapabilities.resume)
        start = { kind: "resume", sessionId: derived };
      else start = derived !== void 0 ? { kind: "new", sessionId: derived } : { kind: "new" };
      let mainAgent;
      if (start.kind === "new" || start.kind === "resume" && !this.#agentLocked()) mainAgent = this.#agentChoice;
      else if (start.kind === "resume" && f.sessionMainAgent) {
        try {
          mainAgent = await f.sessionMainAgent(start.sessionId, port.cwd);
        } catch (error) {
          this.#warn("reading the main agent failed", String(error?.message ?? error));
        }
      }
      if (mainAgent !== void 0) start.mainAgent = mainAgent;
      let trustNotice;
      const trustAccepted = await this.#trustFor(port.cwd, (text) => trustNotice = text);
      const abort = new AbortController();
      const openOptions = {
        cwd: port.cwd,
        env: this.#opts.env,
        start,
        userConfig: this.#opts.userConfig?.() ?? { options: {} },
        interactions: this.#desk.handler(),
        signal: abort.signal
      };
      if (trustAccepted) openOptions.trustAccepted = trustAccepted;
      const backend = await f.open(openOptions);
      if (this.#disposed) {
        this.#ending.add(backend);
        abort.abort();
        await backend.dispose().catch(() => {
        });
        throw new Error("the session is closed");
      }
      this.#backend = backend;
      this.#backendAbort = abort;
      this.#forced = false;
      this.#appliedModel = void 0;
      this.#refusedModel = void 0;
      this.#appliedEffort = void 0;
      this.#ultracode = void 0;
      this.#effort = void 0;
      this.#resetPending = false;
      this.#live = {};
      this.#mainAgent = mainAgent;
      if (mainAgent !== void 0) this.#live.agent = mainAgent;
      this.#agents = void 0;
      this.#mcp = void 0;
      this.#mcpFrom = "none";
      if (trustNotice !== void 0) this.#live.notice = { level: "warning", text: trustNotice, at: this.#now() };
      else if (startNotice !== void 0) this.#live.notice = { level: "warning", text: startNotice, at: this.#now() };
      this.#lastExit = void 0;
      delete this.#lifecycle.restoreCodePending;
      this.#sent.clear();
      this.#tasks = /* @__PURE__ */ new Set();
      this.#taskInfo.clear();
      this.#endedTasks.clear();
      this.#taskKinds.clear();
      this.#closeStaleWorkflows();
      if (!this.#turnActive) this.#idleSince = this.#now();
      void this.#pump(backend);
      this.#loadModels(backend);
      this.#loadAgents(backend);
      queueMicrotask(() => {
        if (backend === this.#backend) this.#side.resume();
      });
      return backend;
    })();
    this.#notify();
    try {
      return await this.#starting;
    } catch (error) {
      this.#side.startFailed(String(error?.message ?? error));
      throw error;
    } finally {
      this.#starting = void 0;
      this.#notify();
    }
  }
  /**
   * D48, D74: workflow records left open in the log belong to a process that is gone (a host
   * restart ends it), so they are closed once, before the first process of this runtime runs.
   */
  #closeStaleWorkflows() {
    if (this.#staleChecked) return;
    this.#staleChecked = true;
    let open2;
    try {
      open2 = this.#port?.openWorkflowRuns?.() ?? [];
    } catch (error) {
      this.#warn("could not read the workflow records", String(error?.message ?? error));
      return;
    }
    if (open2.length > 0) this.#workflows.closeStale(open2);
  }
  async #pump(backend) {
    let exited = false;
    try {
      for await (const e of backend.events()) {
        if (e.type === "exit") exited = true;
        this.#route(e, backend);
      }
    } catch (error) {
      exited = true;
      this.#route({ type: "exit", error: String(error?.message ?? error) }, backend);
    }
    if (!exited) this.#route({ type: "exit", error: "the event stream ended" }, backend);
  }
  #route(e, from) {
    if (from !== this.#backend) return;
    if (isChildEvent(e)) {
      this.#hub.handle(e);
      if (e.type === "agent-start") this.#workflows.agentStarted(e);
      else if (e.type === "agent-end") this.#workflows.agentEnded(e);
      this.#notify();
      return;
    }
    if (e.type === "turn-end") this.#readEffortState(from);
    switch (e.type) {
      case "workflow-start":
        if (this.#box) break;
        this.#workflows.start(e);
        return;
      case "workflow-snapshot":
        this.#workflows.snapshot(e);
        this.#notify();
        return;
      case "workflow-end":
        this.#workflows.ended(e);
        return;
      case "task-start": {
        this.#tasks.add(e.taskId);
        this.#noteTaskKind(e.taskId, e.kind);
        if (e.kind === "workflow") this.#workflows.taskStarted(e.taskId, e.label);
        const info = { taskId: e.taskId, kind: e.kind, label: e.label, status: "running", job: false };
        if (e.agent?.kind === "child") info.agent = e.agent.id;
        this.#taskInfo.set(e.taskId, info);
        this.#linkJob(e.taskId);
        this.#notify();
        return;
      }
      case "task-progress": {
        if (e.summary) this.#jobs.get(e.taskId)?.progress(e.summary);
        const info = this.#taskInfo.get(e.taskId);
        if (info && e.summary) info.progress = e.summary;
        if (this.#hub.progress(e.taskId, e.usage) || info) this.#notify();
        return;
      }
      case "task-end": {
        this.#tasks.delete(e.taskId);
        this.#jobs.get(e.taskId)?.end(e.status, e.summary);
        this.#jobs.delete(e.taskId);
        const info = this.#taskInfo.get(e.taskId);
        if (info) {
          this.#taskInfo.delete(e.taskId);
          if (info.kind === "shell" || info.kind === "monitor") {
            this.#endedTasks.set(e.taskId, { ...info, status: e.status, job: false });
            if (this.#endedTasks.size > ENDED_TASKS_KEPT) {
              const first = this.#endedTasks.keys().next().value;
              if (first !== void 0) this.#endedTasks.delete(first);
            }
          }
          const word = e.status === "completed" ? "finished" : e.status;
          this.#wakeNotes.push(`background ${info.kind} "${info.label}" ${word}`);
          if (this.#wakeNotes.length > 20) this.#wakeNotes = this.#wakeNotes.slice(-20);
        }
        this.#touchIdle();
        this.#notify();
        return;
      }
      case "tasks-snapshot": {
        this.#tasks = new Set(e.taskIds);
        for (const id of [...this.#taskInfo.keys()]) if (!this.#tasks.has(id)) this.#taskInfo.delete(id);
        return;
      }
      case "exit":
        this.#exit(e, from);
        return;
      case "session-info":
        this.#live = this.#live.notice ? { notice: this.#live.notice } : {};
        if (this.#mainAgent !== void 0) this.#live.agent = this.#mainAgent;
        if (e.model !== void 0) this.#live.model = e.model;
        if (e.mode !== void 0) this.#live.mode = e.mode;
        if (e.version !== void 0) this.#live.version = e.version;
        this.#notify();
        return;
      case "mode":
        if (this.#live.mode !== e.mode) {
          this.#live.mode = e.mode;
          this.#notify();
        }
        return;
      case "commands":
        this.#setCommands(e.list, e.namesOnly !== true);
        if (e.namesOnly === true) this.#loadCommands(from);
        return;
      case "mcp-status":
        if (this.#mcpFrom !== "live" || !this.#mcp) {
          this.#mcp = e.servers.map((m) => ({ ...m }));
          this.#mcpFrom = "reported";
          this.#notify();
        }
        return;
      case "conversation-reset":
        this.#side.clear();
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : void 0)) this.#notify();
        return;
      case "context":
      case "compaction":
      case "limits":
      case "auth":
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : void 0)) this.#notify();
        return;
      case "retry":
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : void 0)) this.#notify();
        return;
      case "usage":
        if (e.turn !== void 0 && (this.#box || this.#wakeBuffer)) break;
        if (this.#usage.apply(e)) this.#notify();
        return;
      case "files-rewound":
        this.#noteRewind(e.inputId, e.result);
        return;
      case "interaction-done":
        this.#desk.done(e.id);
        return;
      case "interaction-cancel":
        this.#desk.cancel(e.id);
        return;
      case "notice":
        this.#live.notice = { level: e.level, text: e.text, at: this.#now() };
        this.#warn(`${this.#factory.displayName}: ${e.text}`);
        this.#notify();
        return;
      case "input-cancelled":
        this.#returnSteers([e.inputId]);
        return;
      case "input-consumed":
        if (!this.#box && !this.#wakeBuffer) {
          const entry = this.#sent.get(e.inputId);
          if (entry) entry.consumed = true;
          return;
        }
        break;
    }
    if (this.#box) this.#box.push(e);
    else if (this.#wakeBuffer) this.#wakeBuffer.push(e);
    else if (this.#lateStopped && (TURN_EVENTS.has(e.type) || e.type === "turn-end")) {
      if (e.type === "turn-end") this.#lateStopped = false;
      this.#warn(`dropped a late ${e.type} of a turn closed after Stop`);
    } else if (TURN_EVENTS.has(e.type)) {
      this.#wakeBuffer = [e];
      this.#wakeText = this.#wakeSummary();
      this.#wakeItems = [...this.#wakeNotes];
      const port = this.#port;
      if (port) port.wake(this.#wakeText);
      else this.#wakePending = true;
    }
  }
  /**
   * A process of this session ends while the user's own mode choice is in force (a model or
   * effort reset, a reap, a crash, force stop): the next process starts in the settings mode,
   * which can be more permissive. So the mode it last ran in (the CLI's own report, which follows
   * plan approvals) becomes a pending choice again and is applied right after the next spawn (D4).
   * Only after the user picked a mode in this session; otherwise the settings mode stays (rule 4).
   */
  #carryMode() {
    if (!this.#modeChosen || this.#pendingMode !== void 0) return;
    const mode = this.#live.mode;
    if (mode !== void 0) this.#pendingMode = mode;
  }
  #exit(e, from) {
    const intended = this.#ending.has(from) || e.reason === "disposed" || e.reason === "force-stopped";
    this.#lateStopped = false;
    this.#carryMode();
    this.#desk.dropAll();
    this.#backend = void 0;
    this.#backendAbort = void 0;
    for (const [, link] of this.#jobs) link.end("failed", e.error ?? `${this.#factory.displayName} ended`);
    this.#jobs.clear();
    this.#tasks = /* @__PURE__ */ new Set();
    this.#taskInfo.clear();
    if (intended) this.#hub.endAll("stopped", `${this.#factory.displayName} was stopped`);
    else this.#hub.endAll("failed", crashMessage(this.#factory.displayName, e.error));
    if (intended) this.#workflows.closeAll("cancelled", `${this.#factory.displayName} was stopped`);
    else this.#workflows.closeAll("error", crashMessage(this.#factory.displayName, e.error));
    this.#sent.clear();
    this.#earlySteers = [];
    this.#touchIdle();
    const duringTurn = this.#box !== void 0 || this.#wakeBuffer !== void 0;
    if (!intended) {
      this.#lastExit = { at: this.#now(), duringTurn };
      if (e.error !== void 0) this.#lastExit.error = e.error;
      if (e.reason !== void 0) this.#lastExit.reason = e.reason;
      if (e.code !== void 0) this.#lastExit.code = e.code;
      if (e.signal !== void 0) this.#lastExit.signal = e.signal;
      if (e.stderr !== void 0) this.#lastExit.stderr = e.stderr;
      this.#recovery = this.#recoverTail("crash");
    }
    const item = intended ? { type: "ended" } : e;
    if (this.#box) this.#box.push(item);
    else if (this.#wakeBuffer) this.#wakeBuffer.push(item);
    else if (!intended) this.#warn(`${this.#factory.displayName} ended while idle (D75)`, e.error ?? "no error text");
    this.#notify();
  }
  #touchIdle() {
    if (!this.#turnActive) this.#idleSince = this.#now();
  }
  /**
   * D35, D38: apply explicit choices after every spawn and before a send, once per value. Never
   * `setModel(undefined)`. A mode choice applies once; after that the agent's own mode is the
   * truth (a plan approval changes it). Returns the first error text, if any.
   */
  async #applyChoices(backend) {
    let firstError;
    const failed = (what, error) => {
      const text = `${what} failed: ${String(error?.message ?? error)}`;
      this.#warn(text);
      firstError ??= text;
    };
    const model = this.#port?.modelChoice?.();
    if (model !== void 0 && model !== this.#appliedModel && backend.controls.setModel) {
      try {
        await backend.controls.setModel(model);
        this.#appliedModel = model;
        this.#effort = void 0;
        this.#refusedModel = void 0;
      } catch (error) {
        this.#refusedModel = model;
        failed("setModel", error);
      }
    }
    const effort = this.#effortChoice;
    if (effort !== void 0 && effort !== this.#appliedEffort && backend.controls.setEffort) {
      try {
        await backend.controls.setEffort(effort);
        this.#appliedEffort = effort;
        this.#effort = void 0;
      } catch (error) {
        failed("setEffort", error);
      }
    }
    const mode = this.#pendingMode;
    if (mode !== void 0 && backend.controls.setPermissionMode) {
      try {
        await backend.controls.setPermissionMode(mode);
        this.#pendingMode = void 0;
      } catch (error) {
        this.#pendingMode = void 0;
        failed("setPermissionMode", error);
      }
    }
    this.#readEffortState(backend);
    return firstError;
  }
  /**
   * D37: read the agent's effort state (no process, the live session answers) without holding the
   * caller; the next view shows it. Ultracode can depend on the model, so this runs after every
   * applied choice, a model switch included.
   */
  #readEffortState(backend) {
    const read = backend.controls.effortState;
    if (!read) return;
    read.call(backend.controls).then(
      (state) => {
        if (backend !== this.#backend) return;
        const next = { on: state.ultracode === true };
        if (state.ultracodeRequested !== void 0) next.requested = state.ultracodeRequested;
        if (state.ultracodeAvailable !== void 0) next.available = state.ultracodeAvailable;
        const cur = this.#ultracode;
        const effort = state.effort;
        if (cur && cur.on === next.on && cur.requested === next.requested && cur.available === next.available && effort === this.#effort)
          return;
        this.#ultracode = next;
        this.#effort = effort;
        this.#notify();
      },
      (error) => this.#warn(`effortState failed: ${String(error?.message ?? error)}`)
    );
  }
  /** D34: the model list from this process (no extra process; the live session answers). */
  #loadModels(backend) {
    if (!backend.controls.models) return;
    backend.controls.models().then(
      (list) => {
        if (backend !== this.#backend) return;
        this.#models = list;
        this.#notify();
      },
      (error) => this.#warn("reading the model list failed", String(error))
    );
  }
  /** D51: the live process's agent list for the main-thread picker (no extra process, rule 9). */
  #loadAgents(backend) {
    if (!backend.controls.agents) return;
    backend.controls.agents().then(
      (list) => {
        if (backend !== this.#backend) return;
        this.#agents = list;
        this.#notify();
      },
      (error) => this.#warn("reading the agent list failed", String(error))
    );
  }
  get #lastChainId() {
    for (let i = this.#chain.length - 1; i >= 0; i--) if (!this.#superseded.has(this.#chain[i])) return this.#chain[i];
    return void 0;
  }
  #noteChain(id) {
    if (id === void 0 || this.#superseded.has(id)) return;
    this.#chain.push(id);
    if (this.#chain.length > 64) this.#chain = this.#chain.slice(-32);
  }
  /**
   * R7.2: a local command step names its command in the binding (a native field, D21), so it
   * survives reload and fork. The structured twin has no host event type: it is kept in memory
   * and the binding carries its id (display-only path).
   */
  #localCommandBinding(lc) {
    const out = {};
    if (lc.name !== void 0) out.name = lc.name;
    if (lc.args !== void 0 && lc.args !== "") out.args = lc.args;
    if (lc.unavailable) out.unavailable = true;
    if (lc.structured) {
      out.structured = lc.structured.kind;
      out.outputId = this.#local.add(lc.structured);
    }
    return out;
  }
  #binding() {
    const b = {
      backend: this.#factory.kind,
      sessionId: this.#backend?.sessionId ?? this.#recoverySession ?? "",
      hostSessionId: this.#port?.hostSessionId ?? ""
    };
    const chain = this.#lastChainId;
    if (chain !== void 0) b.lastChainId = chain;
    if (this.#modeChosen) {
      const mode = this.#live.mode ?? this.#pendingMode;
      if (mode !== void 0) b.mode = mode;
    }
    return b;
  }
  /**
   * D27: a human message the user typed into the running turn (DSH `nextStep`). It goes to the
   * agent at once with priority `next`; the driver claims it at the next step boundary after the
   * agent took it. Returns false when no turn of ours is running (DSH claims it at the next turn).
   */
  steer(hostMessageId, input) {
    if (!this.#turnActive || this.#disposed) return false;
    if (this.#sent.has(input.id)) return true;
    this.#sent.set(input.id, { hostMessageId, steer: true, consumed: false, claimed: false });
    const backend = this.#backend;
    if (backend && this.#box) this.#sendSteer(backend, input);
    else this.#earlySteers.push(input);
    return true;
  }
  #sendSteer(backend, input) {
    backend.send(input, "next").catch((err) => {
      this.#sent.delete(input.id);
      this.#warn("could not send a steer", String(err?.message ?? err));
    });
  }
  /** Claim every consumed, unclaimed steer. Only between steps. */
  #claimConsumed(sink) {
    if (sink.stepOpen) return;
    for (const entry of this.#sent.values()) {
      if (!entry.steer || !entry.consumed || entry.claimed || entry.hostMessageId === void 0) continue;
      entry.claimed = true;
      try {
        if (!sink.claim(entry.hostMessageId)) this.#warn("a consumed steer was no longer pending", entry.hostMessageId);
      } catch (error) {
        this.#warn("refused claim", String(error?.message ?? error));
      }
    }
  }
  /** D25: give the text of steers the agent will not run back to the user. */
  #returnSteers(ids) {
    for (const id of ids) {
      const entry = this.#sent.get(id);
      this.#sent.delete(id);
      if (entry?.steer && !entry.claimed && entry.hostMessageId !== void 0)
        this.#port?.returnDraft?.(entry.hostMessageId);
    }
  }
  /** Run one host turn. Returns when the agent has consumed every input sent in it (D27). */
  async runTurn(sink, input, signal) {
    const fresh = input.userInputs.filter((u) => !this.#sent.has(u.id));
    const waiting = input.userInputs.filter((u) => this.#sent.get(u.id)?.consumed === false);
    for (const u of input.userInputs) {
      const entry = this.#sent.get(u.id);
      if (entry) entry.claimed = true;
    }
    const wake = input.wake && this.#wakeBuffer !== void 0;
    if (fresh.length === 0 && waiting.length === 0 && !wake)
      return input.userInputs.length > 0 ? { kind: "completed" } : { kind: "nothing" };
    const recoveryOnly = wake && this.#wakeRecovery && fresh.length === 0 && waiting.length === 0;
    this.#turnActive = true;
    this.#hadTurn = true;
    this.#idleSince = void 0;
    let backend;
    const stopStart = () => this.#desk.stop(["trust"]);
    signal.addEventListener("abort", stopStart, { once: true });
    try {
      if (!recoveryOnly) {
        if (this.#resetPending) await this.#resetIfIdle(true);
        backend = await this.#ensureBackend();
        await this.#applyChoices(backend);
      }
    } catch (error) {
      this.#turnActive = false;
      this.#touchIdle();
      this.#notify();
      return {
        kind: "error",
        message: `${this.#factory.displayName} could not start: ${String(error?.message ?? error)}`
      };
    } finally {
      signal.removeEventListener("abort", stopStart);
    }
    const box = new EventBox();
    this.#box = box;
    this.#sink = sink;
    this.#requestStep = false;
    this.#lateStopped = false;
    if (this.#wakeBuffer === void 0 && this.#pendingRecovery) this.#flushRecovery(true);
    const recovering = this.#wakeRecovery && this.#wakeBuffer !== void 0;
    for (const e of this.#wakeBuffer ?? []) box.push(e);
    this.#wakeBuffer = void 0;
    this.#wakePending = false;
    this.#wakeRecovery = false;
    this.#recoveryTurn = recoveryOnly;
    const triggered = wake || recovering;
    this.#triggerPending = triggered ? this.#wakeText ?? this.#wakeSummary() : void 0;
    this.#triggerItems = triggered ? (this.#wakeItems ?? [...this.#wakeNotes]).slice(-20) : [];
    this.#wakeText = void 0;
    this.#wakeItems = void 0;
    this.#wakeNotes = [];
    this.#notify();
    let timer;
    const onAbort = () => {
      if (!backend) {
        box.push({ type: "ended" });
        return;
      }
      const queued = [...this.#sent.values()].some((s) => s.steer && !s.consumed);
      const cancelQueued = queued && backend.capabilities.cancelQueued;
      backend.interrupt(cancelQueued ? { cancelQueued: true } : void 0).then((r) => this.#returnSteers(r.cancelledInputIds)).catch((err) => this.#warn("interrupt failed", String(err)));
      this.#desk.stop(["permission", "question", "plan"], ["main"]);
      timer = setTimeout(() => box.push({ type: "stop-timeout" }), this.#opts.stopGraceMs ?? STOP_GRACE_MS);
    };
    let outcome;
    let sendError;
    try {
      let sent = 0;
      for (const u of fresh) {
        if (!backend) break;
        this.#sent.set(u.id, { steer: false, consumed: false, claimed: true });
        try {
          await backend.send(u, "next");
          sent++;
        } catch (error) {
          this.#sent.delete(u.id);
          sendError = `${this.#factory.displayName} was not sent a message: ${String(error?.message ?? error)}`;
          break;
        }
      }
      if (sendError !== void 0 && sent === 0 && waiting.length === 0 && !wake) throw new Error(sendError);
      if (backend) for (const u of this.#earlySteers.splice(0)) this.#sendSteer(backend, u);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      for (; ; ) {
        const e = await box.next();
        const prepared = e.type === "tool-result" ? await this.#prepareResult(sink, e) : void 0;
        const end = this.#handle(sink, e, prepared);
        if (end !== void 0) {
          outcome = end;
          break;
        }
      }
    } catch (error) {
      outcome = { kind: "error", message: String(error?.message ?? error) };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      this.#box = void 0;
      this.#closeAudits();
      this.#sink = void 0;
      try {
        sink.closeStep();
        this.#claimConsumed(sink);
      } catch (error) {
        this.#warn("closing the step failed", String(error));
      }
      this.#turnActive = false;
      this.#requestStep = false;
      this.#usage.turnEnded();
      this.#touchIdle();
      const rest = box.drain().filter(
        (i) => i.type !== "stop-timeout" && i.type !== "ended" && i.type !== "recovered-end"
      );
      const current2 = this.#backend;
      if (current2) for (const e of rest) this.#route(e, current2);
      this.#recoveryTurn = false;
      this.#flushRecovery();
      this.#notify();
    }
    this.#triggerPending = void 0;
    if (outcome.kind !== "completed") await this.#hub.quiesce(1500);
    if (sendError !== void 0 && outcome.kind === "completed") return { kind: "error", message: sendError };
    return outcome;
  }
  /**
   * D85: replace every result image with a stored host ref, or, when the host has no store or
   * refuses the batch, with a short placeholder. One refusal turns every image of that result into
   * a placeholder, as DSH's MCP client does. Base64 bytes never reach the sink.
   */
  async #prepareResult(sink, e) {
    const images = e.content.filter((c) => c.type === "image");
    if (images.length === 0) return e.content;
    if (!sink.stepOpen || !sink.hasCall(e.callId)) return e.content;
    let refs;
    let reason = "the host has no attachment store";
    if (sink.saveImages) {
      try {
        refs = await sink.saveImages(images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 })));
        if (refs.length !== images.length) {
          refs = void 0;
          reason = "the host returned the wrong number of attachment refs";
        }
      } catch (error) {
        reason = `it was not stored: ${String(error?.message ?? error)}`;
      }
    }
    if (refs === void 0) this.#warn("could not store tool result images", reason);
    let k = 0;
    return e.content.map((c) => {
      if (c.type !== "image") return c;
      const ref = refs?.[k++];
      return refs === void 0 ? { type: "text", text: imageUnavailableText(c.mediaType, reason) } : { type: "saved-image", mediaType: c.mediaType, ref };
    });
  }
  /** Open a step; the first step of a wake turn carries the turn's visible trigger (D26). */
  #openStep(sink, startedAt) {
    this.#requestStep = false;
    if (startedAt === void 0) sink.openStep();
    else sink.openStep(startedAt);
    const text = this.#triggerPending;
    if (text === void 0) return;
    this.#triggerPending = void 0;
    const items = this.#triggerItems;
    this.#triggerItems = [];
    try {
      sink.trigger?.(text, items);
    } catch (error) {
      this.#warn("could not write the wake trigger", String(error?.message ?? error));
    }
  }
  #handle(sink, e, prepared) {
    try {
      switch (e.type) {
        case "request-start":
          if (sink.stepOpen) {
            if (!sink.hasMessage && this.#requestStep) return void 0;
            if (sink.hasMessage && sink.openCallIds.length > 0) return void 0;
            sink.closeStep();
          }
          this.#claimConsumed(sink);
          this.#openStep(sink, e.at);
          this.#requestStep = true;
          return void 0;
        case "step-start":
          if (sink.stepOpen && !sink.hasMessage && this.#requestStep) {
            this.#requestStep = false;
            return void 0;
          }
          if (sink.stepOpen) sink.closeStep();
          this.#claimConsumed(sink);
          this.#openStep(sink, e.at);
          return void 0;
        case "delta": {
          const tool = e.kind === "tool-input" && e.toolCallId !== void 0 && e.toolName !== void 0 ? { id: e.toolCallId, name: e.toolName } : void 0;
          if (tool) sink.delta(e.kind, e.blockIndex, e.text, e.at, tool);
          else sink.delta(e.kind, e.blockIndex, e.text, e.at);
          return void 0;
        }
        case "usage":
          if (this.#usage.apply(e, sink.turn)) this.#notify();
          return void 0;
        case "step-message": {
          this.#noteChain(e.lastChainId);
          const continued = sink.stepOpen && sink.hasMessage;
          this.#requestStep = false;
          if (!sink.stepOpen) {
            this.#claimConsumed(sink);
            this.#openStep(sink);
          }
          const binding = this.#binding();
          if (e.localCommand) binding.localCommand = this.#localCommandBinding(e.localCommand);
          const m = { blocks: e.blocks, binding };
          if (e.usage) m.usage = e.usage;
          if (e.model) m.model = e.model;
          if (e.interrupted) m.interrupted = true;
          if (continued) m.continued = true;
          const { calls } = sink.commit(m);
          if (sink.openCallIds.length === 0 && (e.final || calls.length > 0)) sink.closeStep();
          return void 0;
        }
        case "tool-result":
          this.#noteChain(e.chainId);
          if (!sink.stepOpen || !sink.hasCall(e.callId)) {
            this.#warn("dropped a tool result with no written call", e.callId);
            return void 0;
          }
          sink.result(e.callId, prepared ?? e.content, e.isError, e.chainId);
          if (sink.openCallIds.length === 0) sink.closeStep();
          return void 0;
        case "workflow-start":
          this.#workflows.start(e);
          return void 0;
        case "superseded":
          for (const id of e.chainIds) this.#superseded.add(id);
          return void 0;
        case "input-consumed": {
          const entry = this.#sent.get(e.inputId);
          if (entry) entry.consumed = true;
          this.#claimConsumed(sink);
          return void 0;
        }
        case "turn-end":
          if (e.pendingInputs > 0) return void 0;
          sink.closeStep();
          for (const entry of this.#sent.values()) entry.consumed = true;
          this.#claimConsumed(sink);
          if (e.outcome === "error") return { kind: "error", message: e.error ?? "the agent reported an error" };
          if (e.outcome === "interrupted") {
            this.#hub.endForeground();
            return { kind: "interrupted" };
          }
          return { kind: "completed" };
        case "ended":
          return { kind: "interrupted" };
        case "recovered-end":
          if (!this.#recoveryTurn) return void 0;
          sink.closeStep();
          return { kind: "completed" };
        case "exit":
          if (this.#forced) return { kind: "interrupted" };
          return { kind: "error", message: crashMessage(this.#factory.displayName, e.error) };
        case "stop-timeout": {
          this.#warn("the agent did not end its turn after Stop; closing it here");
          this.#lateStopped = true;
          const unconsumed = [...this.#sent].filter(([, s]) => s.steer && !s.consumed).map(([id]) => id);
          this.#returnSteers(unconsumed);
          this.#hub.endForeground();
          return { kind: "interrupted" };
        }
        default:
          return void 0;
      }
    } catch (error) {
      this.#warn(`refused ${e.type}`, String(error?.message ?? error));
      return void 0;
    }
  }
  /**
   * D6: may idle reaping end this process now? Only when the user set a timeout, no turn runs,
   * nothing runs in the background, and nothing waits for a wake turn.
   */
  isReapable(now, idleMs) {
    if (!(idleMs > 0) || !this.#backend || this.#starting || this.#turnActive) return false;
    if (this.#tasks.size > 0 || this.#jobs.size > 0 || this.#wakeBuffer !== void 0) return false;
    return this.#idleSince !== void 0 && now - this.#idleSince >= idleMs;
  }
  /** End an idle process (D6). The session stays; the next message resumes it (D28). */
  async reap() {
    if (!this.isReapable(Number.POSITIVE_INFINITY, 1)) return false;
    await this.#end(false);
    return true;
  }
  /** "Force stop" (D25): the only user path that ends the process, background tasks included. */
  async forceStop() {
    await this.#end(true);
  }
  async #end(force) {
    const b = this.#backend;
    if (!b) return;
    this.#ending.add(b);
    this.#forced = force;
    this.#backendAbort?.abort();
    await (force ? b.forceStop() : b.dispose()).catch((err) => this.#warn("ending the process failed", String(err)));
  }
  /** Ends the process for good (the host session or the plugin goes away). Never called on Stop. */
  async dispose() {
    this.#disposed = true;
    this.#desk.dropAll();
    await this.#end(false);
    this.#box?.push({ type: "ended" });
    this.#workflows.closeAll("cancelled", `${this.#factory.displayName} was stopped`);
    await this.#workflows.flush(2e3);
    await this.#hub.dispose();
    this.#backend = void 0;
    this.#port = void 0;
    const ends = [...this.#endListeners];
    this.#endListeners.clear();
    this.#listeners.clear();
    for (const end of ends) {
      try {
        end();
      } catch (error) {
        this.#warn("interaction channel close failed", String(error));
      }
    }
  }
};

// packages/dsh-host/src/mode-command.ts
function modeCommandDescription(factory) {
  return `Show or switch the ${factory.displayName} permission mode for this session (DSH file access does not apply here)`;
}
var norm = (s) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
function findMode(modes, text) {
  const want = norm(text);
  if (want === "") return void 0;
  return modes.find((m) => norm(m.id) === want) ?? modes.find((m) => norm(m.label) === want);
}
var DSH_PRESETS = new Set(
  ["read-only", "workspace-write", "danger-full-access", "full-access", "full access", "workspace", "readonly"].map(
    norm
  )
);
function isDshPresetName(text) {
  return DSH_PRESETS.has(norm(text));
}
function labelOf(modes, id) {
  if (id === void 0) return "not known yet (it is reported once the agent starts)";
  const m = modes.find((x) => x.id === id);
  return m ? `${m.label} (${m.id})` : id;
}
function presetAnswer(factory, preset) {
  const name2 = factory.displayName;
  const modes = factory.staticCapabilities.permissionModes;
  const wide = [...modes.filter((m) => m.risk === "danger"), ...modes.filter((m) => m.id === "auto")];
  const optionFor = (m) => m.requiresOption !== void 0 ? ` (needs the plugin option ${m.requiresOption}${m.requiresNote ? `, ${m.requiresNote}` : ""})` : "";
  const ways = wide.map((m) => `${m.id}${optionFor(m)}`);
  const full = ways.length > 0 ? ` For full access use ${ways.join(", or ")}.` : "";
  return `DSH file access ("${preset}") does not apply to ${name2}, so nothing changed. ${name2} runs its own tools under its permission mode.${full} Modes: ${modes.map((m) => m.id).join(", ")}.`;
}
async function runModeCommand(runtime, factory, rawInput) {
  const r = await modeCommand(runtime, factory, rawInput);
  try {
    runtime?.showNotice?.(r.kind === "error" ? "warning" : "info", r.text, "mode");
  } catch {
  }
  return r;
}
async function modeCommand(runtime, factory, rawInput) {
  const name2 = factory.displayName;
  const modes = factory.staticCapabilities.permissionModes;
  const list = modes.map((m) => m.id).join(", ");
  if (!runtime) return { kind: "error", text: `${name2} is not attached to this session yet; try again in a moment.` };
  const view = runtime.view();
  const arg = rawInput.trim();
  if (arg === "") {
    const pending = view.choice.pendingMode;
    const now = `Permission mode: ${labelOf(modes, view.live.mode)}.`;
    const next = pending !== void 0 ? ` Chosen for the next start: ${labelOf(modes, pending)}.` : "";
    return {
      kind: "success",
      text: `${now}${next} DSH file access does not apply to ${name2}. Switch with /permission <mode> (${list}) or the mode chip.`
    };
  }
  const mode = findMode(modes, arg);
  if (!mode) {
    if (isDshPresetName(arg)) return { kind: "error", text: presetAnswer(factory, arg) };
    return {
      kind: "error",
      text: `"${arg}" is not a ${name2} permission mode, so nothing changed. Modes: ${list}.`
    };
  }
  const r = await runtime.choose({ mode: mode.id });
  if (!r.ok) return { kind: "error", text: r.error ?? `${name2} did not switch to ${mode.label}.` };
  const notes = (r.note ?? "").split("; ").filter((n) => n !== "" && n !== "applied").join("; ");
  return { kind: "success", text: `Permission mode: ${mode.label} (this session${notes ? `; ${notes}` : ""}).` };
}

// packages/dsh-host/src/port/commands.ts
var PERMISSION_COMMAND = "permission";
var disposeHandle = (handle) => {
  if (typeof handle === "function") handle();
  else handle?.dispose?.();
};
var errorText = (error) => String(error?.message ?? error);
var AgentCommandMenus = class {
  #o;
  #scopes = /* @__PURE__ */ new Map();
  constructor(o) {
    this.#o = o;
  }
  has(agentId) {
    return this.#scopes.has(agentId);
  }
  /** Register our rows in the agent's own scope (once per agent). */
  mount(agent) {
    if (this.#scopes.has(agent.id)) return;
    const actx = agent.ctx;
    if (typeof actx?.inject !== "function") return;
    const scope = { agent, handle: void 0, svc: void 0, fixed: /* @__PURE__ */ new Set() };
    this.#scopes.set(agent.id, scope);
    try {
      scope.handle = actx.inject(["commands"], (c) => {
        const svc = c.get("commands");
        if (typeof svc?.register !== "function") return;
        scope.svc = svc;
        c.effect(
          () => () => {
            if (scope.svc === svc) {
              scope.svc = void 0;
              scope.fixed.clear();
            }
          },
          "raw-agent: / menu"
        );
        this.#registerFixed(scope, svc);
        this.sync(agent.id);
      });
    } catch (error) {
      this.#o.warn("could not add our rows to the / menu", errorText(error));
    }
  }
  /** The agent left our preset: remove every row of ours. */
  unmount(agentId) {
    const scope = this.#scopes.get(agentId);
    this.#scopes.delete(agentId);
    if (!scope) return;
    try {
      disposeHandle(scope.handle);
    } catch (error) {
      this.#o.warn("could not remove our / menu rows", errorText(error));
    }
  }
  /** The agent was disposed: its own context disposes the rows with it. */
  forget(agentId) {
    this.#scopes.delete(agentId);
  }
  #registerFixed(scope, svc) {
    const { factory } = this.#o;
    if (this.#o.modeCommand !== false) {
      this.#fixed(scope, svc, {
        name: PERMISSION_COMMAND,
        description: modeCommandDescription(factory),
        input: { hint: "<mode>" },
        handler: ({ agent, rawInput }) => runModeCommand(this.#o.runtime(agent.id), factory, typeof rawInput === "string" ? rawInput : "")
      });
    }
  }
  #fixed(scope, svc, def) {
    try {
      svc.register(def);
      scope.fixed.add(def.name);
    } catch (error) {
      this.#o.warn(`could not add /${def.name} in this session`, errorText(error));
    }
  }
  /** R7.1: hand the runtime the placements of the agent's commands (taken names, D52). Idempotent. */
  sync(agentId) {
    const scope = this.#scopes.get(agentId);
    const svc = scope?.svc;
    if (!scope || !svc) return;
    const { factory } = this.#o;
    const runtime = this.#o.runtime(agentId);
    const known = runtime?.commandList().list;
    if (!known) return;
    let taken = [];
    try {
      taken = (svc.list?.(scope.agent) ?? []).map((d) => d.name);
    } catch (error) {
      this.#o.warn("could not read the / menu", errorText(error));
    }
    const { sideQuestionCommand, mcpCommand, rewindCommand } = factory.staticCapabilities;
    const plan = planCommandMenu(known, {
      taken,
      displayName: factory.displayName,
      ...sideQuestionCommand !== void 0 ? { sideQuestionCommand } : {},
      ...mcpCommand !== void 0 ? { mcpCommand } : {},
      ...rewindCommand !== void 0 ? { rewindCommand } : {}
    });
    runtime?.noteMenu(plan.rows);
  }
};

// packages/dsh-host/src/port/catalog.ts
var SETTINGS_MODEL = "settings";
function catalogAdapter(factory, seedModels2 = [], listed = false) {
  const seeds = (provider) => seedModels2.map((id) => ({ provider, id, name: id, inputModalities: ["text", "image"] }));
  const settingsRow = (provider) => ({
    provider,
    id: SETTINGS_MODEL,
    name: `Your ${factory.displayName} settings`,
    inputModalities: ["text", "image"]
  });
  const refuse = () => {
    throw new Error(`This model only works in ${factory.displayName} sessions`);
  };
  return {
    providerInfo: (provider) => ({ id: provider, name: factory.displayName }),
    providerRetryPolicy: () => void 0,
    imageRequestPricing: () => void 0,
    imageRequestTarget: (_p, _m, image) => ({
      width: image.width,
      height: image.height,
      maxBytes: image.bytes
    }),
    // S4 (a), K1: no row is listed in DSH's global model directory. The composer's native model
    // seat and `/model` choose through `session.selectModel`, which also saves the profile's
    // default model (`P/dsh-api-session-controller/lib/index.js:704-720`), so a pick there made
    // new Standard sessions route to this provider (Phase 3 spike). With no listed row,
    // `selectModel` refuses our provider before it saves anything (`requireModel`). Choices go
    // through the plugin's own control (D36). Rows are still resolved for the loop and for image
    // admission (`resolveModel`).
    listModels: async (_provider) => listed ? [settingsRow(_provider), ...seeds(_provider)] : [],
    resolveModel: async (provider, model) => ({
      ...settingsRow(provider),
      id: model,
      name: model === SETTINGS_MODEL ? settingsRow(provider).name : model,
      context: { contextWindow: 2e5 }
    }),
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: refuse };
    },
    stream: refuse
  };
}
function mountHost(ctx, factories, seedModels2 = []) {
  const register = (c) => {
    const llm = c.get("llm");
    if (!llm?.registerAdapter) return false;
    for (const f of factories) {
      const adapter = catalogAdapter(f, seedModels2);
      c.effect(() => {
        const handle = llm.registerAdapter([f.kind], adapter);
        return () => handle();
      }, `raw-agent: ${f.kind} catalog`);
    }
    return true;
  };
  if (ctx.inject) {
    ctx.inject(["llm"], (child) => void register(child));
    return { catalog: true };
  }
  return { catalog: register(ctx) };
}

// packages/dsh-host/src/port/jobs.ts
var JOB_WAIT_MS = 60 * 60 * 1e3;
var JOB_REWAIT_MS = 30 * 60 * 1e3;
var waitMs = JOB_WAIT_MS;
var rewaitMs = JOB_REWAIT_MS;
function setJobWaitForTests(ms) {
  const ok = ms !== void 0 && Number.isFinite(ms) && ms >= 50;
  waitMs = ok ? Math.floor(ms) : JOB_WAIT_MS;
  rewaitMs = ok ? Math.max(25, Math.floor(ms / 2)) : JOB_REWAIT_MS;
}
var JOB_KILL_GRACE_MS = 5e3;
var TEARDOWN_REASONS = Object.freeze(["owner disposed", "jobs service disposed"]);
function isJobLimitError(message) {
  return /job limit reached/i.test(message);
}
function jobKind(kind) {
  return `raw-agent-${kind}`;
}
function startJob(jobs, owner, task, stop, warn, onTeardown) {
  let finish;
  let settled = false;
  const done = new Promise((r) => {
    finish = (o) => {
      if (settled) return;
      settled = true;
      clearInterval(rewait);
      r(o);
    };
  });
  let handle;
  let id;
  try {
    id = jobs.start({
      kind: jobKind(task.kind),
      label: task.label,
      owner,
      run(job) {
        handle = job;
        return {
          cancel(reason) {
            if (reason !== void 0 && TEARDOWN_REASONS.includes(reason)) {
              finish({ status: "killed", detail: reason });
              try {
                onTeardown?.();
              } catch (error) {
                warn("job teardown hook failed", String(error));
              }
              return;
            }
            stop();
            const t = setTimeout(
              () => finish(reason ? { status: "killed", detail: reason } : { status: "killed" }),
              JOB_KILL_GRACE_MS
            );
            t.unref?.();
          },
          done
        };
      }
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    warn("could not start a job for a background task", message);
    return isJobLimitError(message) ? { refused: message, limit: true } : { refused: message };
  }
  const wait = () => {
    if (settled) return;
    jobs.wait(id, waitMs, owner).catch(() => {
    });
  };
  wait();
  const rewait = setInterval(wait, rewaitMs);
  rewait.unref?.();
  return {
    progress(line) {
      handle?.updateProgress(line);
      handle?.append(`${line}
`, { channel: "log" });
    },
    end(status, summary) {
      const s = status === "completed" ? "completed" : status === "stopped" ? "killed" : "failed";
      if (summary) handle?.append(`${summary}
`, { channel: "log" });
      finish(summary ? { status: s, detail: summary } : { status: s });
    }
  };
}

// packages/dsh-host/src/port/lifecycle.ts
function forkCut(events) {
  let marker = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "session/end-seed" && e.data.inherited === true) {
      marker = i;
      break;
    }
  }
  if (marker <= 0) return void 0;
  let midTurn = false;
  for (let i = marker + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "turn/start") break;
    const reason = e.data.reason;
    if (e.type === "turn/end" && reason?.kind === "forked") midTurn = true;
  }
  let childPrefix = false;
  for (let i = 0; i < marker; i++) if (events[i].type === "subagent/descriptor") childPrefix = true;
  return { boundarySeq: events[marker - 1].seq, midTurn, childPrefix };
}
function droppedHumanMessage(source, cut) {
  if (cut.midTurn) return void 0;
  let inTurn = false;
  for (const e of source) {
    if (e.seq <= cut.boundarySeq) continue;
    if (e.type === "turn/start") {
      if (inTurn) return void 0;
      inTurn = true;
      continue;
    }
    if (e.type === "turn/end" && inTurn) return void 0;
    if (!inTurn || e.type !== "user/message") continue;
    const m = e.data;
    if (m.source?.kind === "user" && typeof m.id === "string") return m.id;
  }
  return void 0;
}
function tasksEndedByStop(events, kindPrefix = "raw-agent-") {
  const ended = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.type !== "job/registered" && e.type !== "job/settled") continue;
    const d = e.data;
    if (typeof d.jobId !== "string" || typeof d.kind !== "string" || !d.kind.startsWith(kindPrefix)) continue;
    const label = typeof d.label === "string" ? d.label : d.kind;
    const key = `${d.kind}\0${label}`;
    if (e.type === "job/registered") {
      ended.set(key, label);
      continue;
    }
    const teardown = d.settleCause === "teardown" || typeof d.detail === "string" && TEARDOWN_REASONS.includes(d.detail);
    if (teardown) ended.set(key, label);
    else ended.delete(key);
  }
  return [...ended.values()];
}
var REWIND_TEXT_MAX = 300;
var REWIND_DRAFT_MAX = 2e4;
var REWIND_POINTS_MAX = 200;
function rewindPoints(events) {
  let marker = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "session/end-seed" && e.data.inherited === true) {
      marker = e.seq;
      break;
    }
  }
  const out = [];
  let lastEnd;
  let inTurn = false;
  let opened = false;
  for (const e of events) {
    if (e.type === "turn/start") {
      inTurn = true;
      opened = false;
      continue;
    }
    if (e.type === "turn/end") {
      inTurn = false;
      lastEnd = e.seq;
      continue;
    }
    if (!inTurn || opened) continue;
    if (e.type === "step/start") {
      opened = true;
      continue;
    }
    if (e.type !== "user/message") continue;
    opened = true;
    const m = e.data;
    if (m.source?.kind !== "user" || typeof m.id !== "string") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    const p = {
      messageId: m.id,
      text: text.length > REWIND_TEXT_MAX ? `${text.slice(0, REWIND_TEXT_MAX)}\u2026` : text,
      at: e.time
    };
    if (text.length > REWIND_TEXT_MAX) {
      p.cut = true;
      if (text.length <= REWIND_DRAFT_MAX) p.draft = text;
    }
    const other = blocks.filter((b) => b?.type !== "text").length;
    if (other > 0) p.attachments = other;
    if (lastEnd !== void 0) p.forkSeq = lastEnd;
    if (marker >= 0 && e.seq < marker) p.inherited = true;
    out.push(p);
  }
  return out.slice(-REWIND_POINTS_MAX);
}

// packages/dsh-host/src/port/children.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// packages/dsh-host/src/port/writer.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/dsh-host/src/port/stream.ts
import { isDeepStrictEqual as isDeepStrictEqual2 } from "node:util";
var StreamRecorder = class {
  #records = [];
  /** Add one timed chunk. Returns the chunk as published live. */
  push(time, chunk) {
    if (!Number.isSafeInteger(time)) throw new TypeError(`stream time must be a safe integer, got ${time}`);
    const c = structuredClone(chunk);
    const prev = this.#records.at(-1);
    if (c.type === "text-delta" || c.type === "reasoning-delta") {
      const type = c.type === "text-delta" ? "text-chunks" : "reasoning-chunks";
      if (prev !== void 0 && prev.type === type && prev.index === c.index && "texts" in prev) {
        prev.dt.push(time - prev.lastTime);
        prev.texts.push(c.text);
        prev.lastTime = time;
      } else this.#records.push({ type, time0: time, index: c.index, dt: [], texts: [c.text], lastTime: time });
      return c;
    }
    if (c.type === "tool-call-delta" && c.id.length > 0 && c.name !== "") {
      const sameName = prev?.type === "tool-call-chunks" && Object.hasOwn(prev, "name") === Object.hasOwn(c, "name") && prev.name === c.name;
      if (prev?.type === "tool-call-chunks" && prev.index === c.index && prev.id === c.id && sameName) {
        prev.dt.push(time - prev.lastTime);
        prev.args.push(c.argumentsDelta);
        prev.lastTime = time;
      } else {
        const r = {
          type: "tool-call-chunks",
          time0: time,
          index: c.index,
          dt: [],
          id: c.id,
          args: [c.argumentsDelta],
          lastTime: time
        };
        if (c.name !== void 0) r.name = c.name;
        this.#records.push(r);
      }
      return c;
    }
    this.#records.push({ type: "chunk", time, chunk: c });
    return c;
  }
  get empty() {
    return this.#records.length === 0;
  }
  /** The durable record list (DSH `AssistantStreamRecord[]`). */
  snapshot() {
    return this.#records.map((r) => {
      if (r.type === "chunk") return { ...r };
      const { lastTime: _l, ...durable } = r;
      return structuredClone(durable);
    });
  }
};
function expandRecords(records) {
  const out = [];
  for (const r of records) {
    if (r.type === "chunk") {
      out.push({ time: r.time, chunk: r.chunk });
      continue;
    }
    const members = r.type === "tool-call-chunks" ? r.args : r.texts;
    let time = r.time0;
    members.forEach((m, i) => {
      if (i > 0) time += r.dt[i - 1] ?? 0;
      let chunk;
      if (r.type === "text-chunks") chunk = { type: "text-delta", index: r.index, text: m };
      else if (r.type === "reasoning-chunks") chunk = { type: "reasoning-delta", index: r.index, text: m };
      else {
        const t = r;
        const c = {
          type: "tool-call-delta",
          index: t.index,
          id: t.id,
          argumentsDelta: m
        };
        if (t.name !== void 0) c.name = t.name;
        chunk = c;
      }
      out.push({ time, chunk });
    });
  }
  return out;
}
function replayStream(records) {
  const partials = /* @__PURE__ */ new Map();
  const order = [];
  let usage;
  let finish;
  let replayState;
  const ensure = (index, blockType) => {
    let p = partials.get(index);
    if (p === void 0) {
      p = { blockType, text: "", args: "" };
      partials.set(index, p);
      order.push(index);
    }
    return p;
  };
  const timed = expandRecords(records);
  for (const { chunk: c } of timed) {
    switch (c.type) {
      case "block-start":
        ensure(c.index, c.blockType);
        break;
      case "text-delta":
      case "reasoning-delta": {
        const p = ensure(c.index, c.type === "text-delta" ? "text" : "reasoning");
        if (p.block === void 0) p.text += c.text;
        break;
      }
      case "tool-call-delta": {
        const p = ensure(c.index, "tool-call");
        if (p.block !== void 0) break;
        p.id = c.id;
        if (c.name) p.name = c.name;
        p.args += c.argumentsDelta;
        break;
      }
      case "block-end": {
        const p = ensure(c.index, c.block.type);
        if (p.block === void 0) p.block = c.block;
        break;
      }
      case "usage":
        usage = c.usage;
        break;
      case "finish":
        finish = c.reason;
        replayState = c.replayState;
        break;
    }
  }
  const assemble = (p, index) => {
    if (p.block !== void 0) return p.block;
    if (p.blockType === "text") return { type: "text", text: p.text };
    if (p.blockType === "reasoning") return { type: "reasoning", text: p.text };
    if (p.blockType === "tool-call")
      return { type: "tool-call", id: p.id ?? `call-${index}`, name: p.name ?? "", arguments: p.args };
    throw new Error(`cannot assemble incomplete block of type "${p.blockType}"`);
  };
  const all = order.map((i) => assemble(partials.get(i), i));
  const blocks = finish?.kind === "max-tokens" ? all.filter((b) => b.type !== "tool-call") : all;
  const interruptedBlocks = order.map((i) => {
    const p = partials.get(i);
    const type = p.block?.type ?? p.blockType;
    return type === "text" || type === "reasoning" ? assemble(p, i) : void 0;
  }).filter((b) => (b?.type === "text" || b?.type === "reasoning") && b.text.trim() !== "");
  const envelope = replayState;
  const rs = envelope?.blocks === void 0 ? replayState : void 0;
  return { blocks, interruptedBlocks, usage, replayState: rs, chunkCount: timed.length };
}
var deepEqual = (a, b) => isDeepStrictEqual2(a, b);

// packages/dsh-host/src/port/writer.ts
var WriterAssertError = class extends Error {
  name = "WriterAssertError";
};
var REPAIR_STARTED_TEXT = "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.";
var WRITER_EVENT_TYPES = Object.freeze([
  "user/message",
  "step/start",
  "assistant/message",
  "assistant/attempt",
  "tool/call",
  "tool/result",
  "step/end",
  "agent/inbox/spliced",
  // D44: DSH's log-only approval audit pair (`P/dsh-user-approval/lib/types/types.d.ts:25-52`).
  "approval/asked",
  "approval/decided",
  // D26 (M3): the visible trigger of a wake turn, a native step event that is never sent to the agent.
  "developer/message"
]);
function spliceInbox(session, inbox, splice) {
  const list = splice.target === "next-turn" ? inbox.nextTurn : splice.target === "next-step" ? inbox.nextStep : void 0;
  if (list === void 0)
    throw new WriterAssertError(`refused inbox splice: unknown target ${String(splice.target)} (rule h)`);
  const removed = splice.removedCount ?? 0;
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > list.length)
    throw new WriterAssertError(`refused inbox splice: start ${splice.start} out of range (rule h)`);
  if (!Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > list.length)
    throw new WriterAssertError(`refused inbox splice: removedCount ${removed} out of range (rule h)`);
  const next = list.toSpliced(splice.start, removed, ...splice.inserted);
  const other = splice.target === "next-turn" ? inbox.nextStep : inbox.nextTurn;
  const ids = /* @__PURE__ */ new Set();
  for (const m of [...next, ...other]) {
    if (ids.has(m.id)) throw new WriterAssertError(`refused inbox splice: message ${m.id} is already pending (rule h)`);
    ids.add(m.id);
  }
  const data = { target: splice.target, start: splice.start, inserted: splice.inserted };
  if (removed > 0) data.removedCount = removed;
  return session.append("agent/inbox/spliced", data).seq;
}
var UNTIMED_SKEW_MS = 250;
var MAX_PLAUSIBLE_TOKENS_PER_SECOND = 500;
var MIN_TIMED_DECODE_MS = 500;
function mostlyToolInput(blocks) {
  let prose = 0;
  let tool = 0;
  for (const b of blocks) {
    if (b.type === "tool-call") tool += b.arguments.length;
    else if (b.type === "text" || b.type === "reasoning") prose += b.text.length;
  }
  return tool > prose;
}
var TurnLog = class {
  #session;
  #live;
  #turn;
  #opts;
  #now;
  #step = 0;
  #stepOpen = false;
  #closed = false;
  #hasMessage = false;
  #calls = /* @__PURE__ */ new Map();
  #recorder = new StreamRecorder();
  #attemptId = "";
  #frameIndex = 0;
  /** Block indices that already have a block-start chunk in this attempt. */
  #started = /* @__PURE__ */ new Set();
  /** D44: audit ids asked in this turn without a decision yet. */
  #approvals = /* @__PURE__ */ new Set();
  #triggered = false;
  /** R8.4: when the open step started (its request), and its first token. */
  #openedAt = 0;
  #firstTokenAt;
  #reasoningStreamed = false;
  /** R8.4: this step's live timing is not real; its durable stream gets no deltas. */
  #untimed = false;
  /** Tool-call blocks that already have their first-token marker in this attempt. */
  #toolMarked = /* @__PURE__ */ new Set();
  constructor(session, live, turn, opts) {
    this.#session = session;
    this.#live = live;
    this.#turn = turn;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }
  get turn() {
    return this.#turn;
  }
  get step() {
    return this.#step;
  }
  get stepOpen() {
    return this.#stepOpen;
  }
  get hasMessage() {
    return this.#hasMessage;
  }
  /** Written calls without a result in the open step. */
  get openCallIds() {
    return [...this.#calls].filter(([, c]) => !c.resolved).map(([id]) => id);
  }
  hasCall(callId) {
    return this.#calls.has(callId);
  }
  #append(type, data, options) {
    if (!WRITER_EVENT_TYPES.includes(type) || type.startsWith("plugin:"))
      throw new WriterAssertError(`refused unknown event type ${type} (rule e)`);
    if (this.#closed) throw new WriterAssertError(`refused ${type}: the turn is closed`);
    return this.#session.append(type, data, options).seq;
  }
  /**
   * The human message, unchanged (D22). Only between steps. A granted plugin message (D66,
   * `source.kind: 'raw-agent-plugin'`, admitted by the caller) is written unchanged too, so the log
   * shows who sent it.
   */
  writeUser(message) {
    if (this.#stepOpen) throw new WriterAssertError("refused user/message inside an open step");
    if (message.source.kind !== "user" && message.source.kind !== PLUGIN_SOURCE_KIND)
      throw new WriterAssertError("refused a non-human user/message");
    this.#append("user/message", message, { surfaceOp: "append" });
  }
  /**
   * Open a step. `startedAt`: when the agent really began it (its request, or its response when
   * no request was seen). A step opened well after that has no real timing (R8.4).
   */
  openStep(startedAt) {
    if (this.#stepOpen) throw new WriterAssertError("refused step/start: a step is already open");
    this.#step += 1;
    this.#append("step/start", { turn: this.#turn, step: this.#step });
    this.#stepOpen = true;
    this.#hasMessage = false;
    this.#calls = /* @__PURE__ */ new Map();
    this.#openedAt = this.#now();
    this.#untimed = startedAt !== void 0 && this.#openedAt - startedAt > UNTIMED_SKEW_MS;
    this.#beginAttempt();
  }
  /** R8.4: whether the open step's timing reaches DSH (tests and diagnostics). */
  get stepTimed() {
    return this.#stepOpen && !this.#untimed;
  }
  #beginAttempt() {
    this.#recorder = new StreamRecorder();
    this.#started = /* @__PURE__ */ new Set();
    this.#toolMarked = /* @__PURE__ */ new Set();
    this.#firstTokenAt = void 0;
    this.#reasoningStreamed = false;
    this.#frameIndex = 0;
    this.#attemptId = this.#live.nextAttemptId();
    this.#live.emit({
      type: "start",
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      turn: this.#turn,
      step: this.#step
    });
  }
  #push(chunk, time) {
    const c = this.#recorder.push(time, chunk);
    this.#live.emit({
      type: "chunk",
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      index: this.#frameIndex++,
      time,
      chunk: c
    });
  }
  /** Start blocks up to `index` so DSH's assembler keeps block order (earlier, unseen ones as placeholders). */
  #startUpTo(index, blockType, time) {
    for (let i = 0; i <= index; i++) {
      if (this.#started.has(i)) continue;
      this.#started.add(i);
      this.#push({ type: "block-start", index: i, blockType: i === index ? blockType : "text" }, time);
    }
  }
  /**
   * A live delta (D20), stamped with its real arrival time. Tool-input text is not streamed (D21):
   * a tool call gets one name-only `tool-call-delta` at its first input, as DSH's own providers
   * send at a call's start, so a step with only a tool call still has a real first token (R8.4).
   * The block-end of the call decides its content.
   */
  delta(kind, blockIndex, text, at, tool) {
    if (!this.#stepOpen || this.#hasMessage || text === "") return;
    let time = Math.max(Math.trunc(at), 0);
    if (this.#openedAt - time > UNTIMED_SKEW_MS) this.#untimed = true;
    time = Math.max(time, this.#openedAt);
    if (kind === "tool-input") {
      if (tool === void 0 || tool.id === "" || tool.name === "" || this.#toolMarked.has(blockIndex)) return;
      if (this.#started.has(blockIndex)) return;
      this.#toolMarked.add(blockIndex);
      this.#startUpTo(blockIndex, "tool-call", time);
      this.#firstTokenAt ??= time;
      this.#push(
        { type: "tool-call-delta", index: blockIndex, id: tool.id, name: tool.name, argumentsDelta: "" },
        time
      );
      return;
    }
    this.#startUpTo(blockIndex, kind, time);
    this.#firstTokenAt ??= time;
    if (kind === "reasoning") this.#reasoningStreamed = true;
    this.#push({ type: kind === "text" ? "text-delta" : "reasoning-delta", index: blockIndex, text }, time);
  }
  /**
   * R8.4: may this step's live timing reach DSH's TTFT and speed figures? Not when the step was
   * opened late, when its thinking was counted but never streamed (the speed would include the
   * hidden thinking), when its output is mostly tool-call input (sent in bursts), when its decode
   * window is too short to measure, or when its output came as a burst faster than any model writes.
   */
  #timingHonest(blocks, usage, at) {
    if (this.#untimed) return false;
    if (usage === void 0 || this.#firstTokenAt === void 0) return true;
    if ((usage.reasoningTokens ?? 0) > 0 && !this.#reasoningStreamed) return false;
    if (mostlyToolInput(blocks)) return false;
    const decodeMs = at - this.#firstTokenAt;
    if (usage.outputTokens <= 0) return true;
    if (decodeMs < MIN_TIMED_DECODE_MS) return false;
    return usage.outputTokens * 1e3 / decodeMs <= MAX_PLAUSIBLE_TOKENS_PER_SECOND;
  }
  /**
   * Write the step's assistant/message (with its embedded stream), then a tool/call per kept
   * tool-call block (D18). An interrupted message keeps only its text prefix and no usage or
   * finish; an empty interrupted prefix becomes an assistant/attempt.
   */
  commit(input) {
    if (!this.#stepOpen) throw new WriterAssertError("refused assistant/message outside an open step (rule a)");
    if (this.#hasMessage && input.continued !== true)
      throw new WriterAssertError("refused a second main-thread assistant/message in one step");
    const interrupted = input.interrupted === true;
    if (interrupted && input.blocks.some((b) => b.type === "tool-call"))
      throw new WriterAssertError("refused interrupted assistant/message that keeps a tool call (D17 f)");
    input = { ...input, blocks: this.#uniqueCalls(input.blocks) };
    if (this.#hasMessage) {
      if (input.blocks.length === 0) return { calls: [] };
      this.#beginAttempt();
    }
    const replayState = { response: input.binding };
    const hasCall = input.blocks.some((b) => b.type === "tool-call");
    const encodeTail = (time) => {
      input.blocks.forEach((block, i) => {
        this.#startUpTo(i, block.type, time);
        this.#push({ type: "block-end", index: i, block: structuredClone(block) }, time);
      });
      if (!interrupted) {
        if (input.usage !== void 0) this.#push({ type: "usage", usage: input.usage }, time);
        this.#push({ type: "finish", reason: { kind: hasCall ? "tool-calls" : "stop" }, replayState }, time);
      }
    };
    const expected = interrupted ? input.blocks.filter((b) => (b.type === "text" || b.type === "reasoning") && b.text.trim() !== "") : input.blocks;
    const at = Math.max(this.#now(), this.#firstTokenAt ?? 0);
    if (!this.#recorder.empty && !this.#timingHonest(input.blocks, interrupted ? void 0 : input.usage, at)) {
      this.#recorder = new StreamRecorder();
      this.#started = /* @__PURE__ */ new Set();
    }
    encodeTail(at);
    let records = this.#recorder.snapshot();
    if (!this.#opts.skipStreamCheck && !deepEqual(this.#content(records, interrupted), expected)) {
      this.#opts.warn?.("stream fallback: live deltas did not reproduce the final blocks", { step: this.#step });
      this.#recorder = new StreamRecorder();
      this.#started = /* @__PURE__ */ new Set();
      encodeTail(at);
      records = this.#recorder.snapshot();
    }
    const content = this.#content(records, interrupted);
    if (interrupted && content.length === 0) {
      const seq2 = this.#append("assistant/attempt", { turn: this.#turn, step: this.#step, stream: records });
      this.#endFrame({ kind: "committed", eventType: "assistant/attempt", seq: seq2 });
      this.#hasMessage = true;
      return { calls: [] };
    }
    const source = {
      kind: "model",
      provider: this.#opts.provider,
      model: input.model ?? "settings",
      rawAgent: input.binding
    };
    if (!interrupted) source.replayState = replayState;
    const message = { id: randomUUID2(), role: "assistant", content, source };
    const data = { turn: this.#turn, step: this.#step, message, stream: records };
    if (!interrupted && input.usage !== void 0) data.usage = input.usage;
    if (interrupted) data.interrupted = true;
    if (!this.#opts.skipStreamCheck) this.#assertStream(data);
    const seq = this.#append("assistant/message", data, { surfaceOp: "append" });
    this.#endFrame({ kind: "committed", eventType: "assistant/message", seq });
    this.#hasMessage = true;
    const calls = [];
    for (const b of content) {
      if (b.type !== "tool-call") continue;
      const callSeq = this.#append("tool/call", {
        turn: this.#turn,
        step: this.#step,
        callId: b.id,
        name: b.name,
        arguments: b.arguments
      });
      this.#calls.set(b.id, { name: b.name, arguments: b.arguments, seq: callSeq, resolved: false });
      calls.push(b.id);
    }
    return { calls };
  }
  /** Drop exact repeats of a tool call (in this message or written earlier in the step); refuse a conflict. */
  #uniqueCalls(blocks) {
    const seen = /* @__PURE__ */ new Map();
    for (const [id, c] of this.#calls) seen.set(id, c);
    const out = [];
    for (const b of blocks) {
      if (b.type !== "tool-call") {
        out.push(b);
        continue;
      }
      const prior = seen.get(b.id);
      if (prior === void 0) {
        seen.set(b.id, { name: b.name, arguments: b.arguments });
        out.push(b);
        continue;
      }
      if (prior.name !== b.name || prior.arguments !== b.arguments)
        throw new WriterAssertError(`refused duplicate tool call id ${b.id} with different content (W1)`);
      this.#opts.warn?.("dropped a repeated tool call block (W1)", { callId: b.id, step: this.#step });
    }
    return out;
  }
  #content(records, interrupted) {
    const r = replayStream(records);
    return interrupted ? r.interruptedBlocks : r.blocks;
  }
  /** D17 (f): the embedded stream alone must reproduce the event. */
  #assertStream(data) {
    const r = replayStream(data.stream);
    if (r.chunkCount === 0) throw new WriterAssertError("refused assistant/message with an empty stream (rule d)");
    const message = data.message;
    const content = data.interrupted === true ? r.interruptedBlocks : r.blocks;
    if (!deepEqual(message.content, content)) throw new WriterAssertError("refused: content disagrees with its stream");
    if (!deepEqual(data.usage, r.usage)) throw new WriterAssertError("refused: usage disagrees with its stream");
    if (!deepEqual(message.source.replayState, r.replayState))
      throw new WriterAssertError("refused: replay state disagrees with its stream");
  }
  #endFrame(outcome) {
    this.#live.emit({
      type: "end",
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      index: this.#frameIndex,
      outcome
    });
  }
  /** A tool/result for a call written in this step (rule b, D18 buffering happens in the mapper). */
  result(callId, content, isError, meta) {
    if (!this.#stepOpen) throw new WriterAssertError(`refused tool/result for ${callId} outside an open step`);
    const call = this.#calls.get(callId);
    if (call === void 0) throw new WriterAssertError(`refused tool/result for ${callId}: no tool/call in this step`);
    if (call.resolved) throw new WriterAssertError(`refused a second tool/result for ${callId}`);
    const message = {
      id: randomUUID2(),
      role: "tool",
      toolCallId: callId,
      source: { kind: "tool", callId },
      content: content.length > 0 ? content : [{ type: "text", text: "" }]
    };
    if (isError) message.isError = true;
    const data = { turn: this.#turn, step: this.#step, message };
    if (meta !== void 0) data.meta = meta;
    this.#append("tool/result", data, { surfaceOp: "append", sourceEventSeqs: [call.seq] });
    call.resolved = true;
  }
  /**
   * Claim one pending steer at a step boundary (D27): a driver-owned `agent/inbox/spliced` that
   * removes it from `nextStep` with no `outcome`, then the unchanged `user/message`. Returns false
   * when the message is no longer pending (the user removed it, or DSH already claimed it).
   */
  claim(messageId, inbox) {
    if (this.#stepOpen) throw new WriterAssertError("refused a claim inside an open step");
    if (this.#closed) throw new WriterAssertError("refused a claim: the turn is closed");
    const index = inbox.nextStep.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    const pending = inbox.nextStep[index];
    spliceInbox(this.#session, inbox, { target: "next-step", start: index, removedCount: 1, inserted: [] });
    this.writeUser(pending);
    return true;
  }
  /**
   * Close the open step (D18, D74): an assistant/attempt when nothing was committed, DSH's exact
   * repair result for every unresolved call (rule c), then step/end.
   */
  closeStep() {
    if (!this.#stepOpen) return;
    if (!this.#hasMessage) {
      const stream = this.#recorder.snapshot();
      this.#append("assistant/attempt", { turn: this.#turn, step: this.#step, stream });
      this.#endFrame({ kind: "abandoned" });
      this.#hasMessage = true;
    }
    for (const [callId, call] of this.#calls) {
      if (call.resolved) continue;
      const message = {
        id: `interrupted-tool-result-${callId}-${this.#session.seq + 1}`,
        role: "tool",
        toolCallId: callId,
        isError: true,
        source: { kind: "tool", callId },
        content: [{ type: "text", text: REPAIR_STARTED_TEXT }]
      };
      this.#append(
        "tool/result",
        {
          turn: this.#turn,
          step: this.#step,
          message,
          error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" }
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] }
      );
      call.resolved = true;
    }
    this.#append("step/end", { turn: this.#turn, step: this.#step });
    this.#stepOpen = false;
  }
  /**
   * D26 (M3): the visible trigger of a wake turn: DSH's native `developer/message`, inside the open
   * step (a step event, `P/dsh-session-format-v3-to-v4/lib/index.js:492-496, 742`), with a
   * producer-owned source and the `notice` form, so DSH's chat shows its one-line summary
   * (`P/dsh-client-ui-chat/lib/client.js:5690-5697`). Not a `user/message` (D22, rule 3): the
   * agent is never sent it, and no host model runs in these sessions (D2). Once per turn.
   */
  trigger(text, sourceKind, items) {
    if (!this.#stepOpen) throw new WriterAssertError("refused developer/message outside an open step");
    if (this.#triggered) return;
    if (text.trim() === "") throw new WriterAssertError("refused an empty wake trigger");
    const message = {
      id: randomUUID2(),
      role: "developer",
      content: [{ type: "text", text }],
      source: {
        kind: sourceKind,
        form: "notice",
        summary: text.slice(0, 200),
        // The plugin's trigger card lists what ended (D26); DSH's own row shows the summary.
        ...items && items.length > 0 ? { items: items.slice(-20).map((i) => i.slice(0, 300)) } : {}
      }
    };
    this.#append("developer/message", { turn: this.#turn, step: this.#step, message }, { surfaceOp: "append" });
    this.#triggered = true;
  }
  /**
   * D44: `approval/asked` for an ask shown while this turn is open. Log-only (no surface op), like
   * DSH's own `approval.request()`: it may sit inside or between steps. Returns the audit id.
   */
  approvalAsked(info) {
    if (typeof info.toolName !== "string" || info.toolName === "")
      throw new WriterAssertError("refused approval/asked without a tool name");
    const id = randomUUID2();
    const data = { id, toolName: info.toolName };
    if (info.callId !== void 0) data.callId = info.callId;
    if (info.reason !== void 0) data.reason = info.reason;
    this.#append("approval/asked", data);
    this.#approvals.add(id);
    return id;
  }
  /** D44: the one `approval/decided` of an asked id. A second decision is ignored. */
  approvalDecided(id, outcome) {
    if (!this.#approvals.has(id)) return;
    if (outcome !== "allowed-once" && outcome !== "rejected" && outcome !== "cancelled")
      throw new WriterAssertError(`refused approval/decided with outcome ${String(outcome)}`);
    this.#append("approval/decided", { id, outcome });
    this.#approvals.delete(id);
  }
  /** Close everything this writer opened. Later appends are refused (the loop writes turn/end). */
  close() {
    this.closeStep();
    for (const id of [...this.#approvals]) this.approvalDecided(id, "cancelled");
    this.#closed = true;
  }
};

// packages/dsh-host/src/port/children.ts
var ENTER = { kind: "enter", messages: [] };
var LIVE_CHILDREN = /* @__PURE__ */ new Map();
function childPreStep(p) {
  return LIVE_CHILDREN.get(p.agent.session.id)?.(p);
}
async function guard(_p, next) {
  const d = await next();
  return d.kind === "reject" ? d : ENTER;
}
function childChannel(ctx, agent) {
  let revision = 0;
  let attempt = 0;
  return {
    emit: (frame) => {
      if (frame.type !== "chunk") ctx.emit("agent/assistant-stream", { agent, frame });
    },
    nextRevision: () => ++revision,
    nextAttemptId: () => `${agent.session.id}:raw-child-${++attempt}`
  };
}
function childSink(log) {
  return {
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    openStep: () => log.openStep(),
    delta: () => {
    },
    // D68: none for children
    commit: (m) => {
      const input = {
        blocks: m.blocks.map((b) => b.type === "reasoning" ? { type: "reasoning", text: b.text } : b),
        binding: m.binding
      };
      if (m.model) input.model = m.model;
      if (m.continued) input.continued = true;
      return log.commit(input);
    },
    result: (id, content, isError, chainId) => log.result(
      id,
      content.map(
        (c) => c.type === "text" ? { type: "text", text: c.text } : c.type === "saved-image" ? { type: "image", attachment: c.ref } : { type: "text", text: c.type === "image" ? "[image]" : JSON.stringify(c.value) }
      ),
      isError,
      chainId === void 0 ? void 0 : { chainUuid: chainId }
    ),
    closeStep: () => log.closeStep(),
    claim: () => false,
    // a child has no steers (D45)
    approvalAsked: (info) => log.approvalAsked(info),
    approvalDecided: (id, outcome) => log.approvalDecided(id, outcome)
  };
}
function childWriter(ctx, o, runner) {
  return async (p) => {
    const { agent, messages, turn, signal } = p;
    if (messages.length === 0) return ENTER;
    const log = new TurnLog(agent.session, childChannel(ctx, agent), turn, {
      provider: o.factory.kind,
      warn: o.warn,
      ...o.writer
    });
    for (const m of messages) if (m.source.kind === "user") log.writeUser(m);
    let outcome;
    try {
      outcome = await runner(childSink(log), signal);
    } finally {
      log.close();
    }
    if (outcome.kind === "error") throw new Error(outcome.message);
    if (outcome.kind === "stopped" && !signal.aborted) {
      try {
        agent.cancel?.(
          { kind: outcome.cause },
          { keepInbox: true }
        );
      } catch (error) {
        o.warn("could not mark the child turn stopped", String(error));
      }
    }
    signal.throwIfAborted();
    return ENTER;
  };
}
async function createChildSession(ctx, parent, o, spec, runner) {
  const agents = ctx.get("agents");
  if (typeof agents?.create !== "function") throw new Error("the host has no agent registry");
  const sessionId = `session-${randomUUID3()}`;
  const header = parent.session.header;
  const depth = (typeof header.delegationDepth === "number" ? header.delegationDepth : 0) + 1;
  const meta = {
    parentSession: parent.session.id,
    isSeeded: false,
    origin: "subagent",
    delegationDepth: depth,
    agentPreset: o.presetId
  };
  if (header.cwd !== void 0) meta.cwd = header.cwd;
  const write = childWriter(ctx, o, runner);
  const handle = await agents.create({
    sessionId,
    parentAgent: parent,
    meta,
    agentOptions: { provider: o.factory.kind, model: SETTINGS_MODEL },
    setup: (cctx, child) => {
      const descriptor = { version: 3, mode: "one-shot", provider: o.factory.kind };
      descriptor.label = spec.label;
      child.session.append("subagent/descriptor", descriptor);
      child.session.append("agent-preset/selected", { agentPreset: o.presetId });
      cctx.on("agent/pre-step", guard, { prepend: true });
      cctx.on("agent/pre-step", ((p) => write(p)));
    }
  });
  LIVE_CHILDREN.set(sessionId, write);
  try {
    parent.session.append("subagent/catalog", {
      version: 0,
      childId: sessionId,
      childCreatedAt: handle.agent.session.header.createdAt,
      mode: "one-shot",
      label: spec.label
    });
  } catch (error) {
    o.warn("could not list the child in its parent", String(error?.message ?? error));
  }
  let disposed = false;
  return {
    hostSessionId: sessionId,
    begin(prompt) {
      const child = handle.agent;
      const open2 = () => child.followup({
        id: randomUUID3(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" }
      });
      if (child.status === "running" && typeof child.whenIdle === "function")
        void child.whenIdle().then(open2, (error) => o.warn("could not open a child turn", String(error)));
      else open2();
    },
    createChild: (s, r) => createChildSession(ctx, handle.agent, o, s, r),
    async dispose() {
      if (disposed) return;
      disposed = true;
      LIVE_CHILDREN.delete(sessionId);
      await handle.dispose().catch((error) => o.warn("could not release a child session", String(error)));
    }
  };
}

// packages/dsh-host/src/port/workflows.ts
var WORKFLOW_EVENT_TYPES = Object.freeze({
  "run-start": "tool-workflow/run-start",
  "agent-start": "tool-workflow/agent-start",
  "agent-end": "tool-workflow/agent-end",
  "run-end": "tool-workflow/run-end"
});
function workflowEventData(r) {
  switch (r.kind) {
    case "run-start":
      return { runId: r.runId, name: r.name };
    case "agent-start": {
      const d = { runId: r.runId, seq: r.seq, label: r.label };
      if (r.phase !== void 0) d.phase = r.phase;
      d.childId = r.childId;
      return d;
    }
    case "agent-end":
      return { runId: r.runId, seq: r.seq, outcome: r.outcome };
    case "run-end":
      return { runId: r.runId, stopReason: r.stopReason };
  }
}
function appendWorkflowRecord(session, r) {
  session.append(WORKFLOW_EVENT_TYPES[r.kind], workflowEventData(r));
}
function openWorkflowRuns(session) {
  const runs = /* @__PURE__ */ new Map();
  for (const e of session.snapshotEvents()) {
    const runId = typeof e.data?.runId === "string" ? e.data.runId : void 0;
    if (runId === void 0) continue;
    const seq = typeof e.data.seq === "number" ? e.data.seq : void 0;
    switch (e.type) {
      case WORKFLOW_EVENT_TYPES["run-start"]:
        runs.set(runId, /* @__PURE__ */ new Set());
        break;
      case WORKFLOW_EVENT_TYPES["agent-start"]:
        if (seq !== void 0) runs.get(runId)?.add(seq);
        break;
      case WORKFLOW_EVENT_TYPES["agent-end"]:
        if (seq !== void 0) runs.get(runId)?.delete(seq);
        break;
      case WORKFLOW_EVENT_TYPES["run-end"]:
        runs.delete(runId);
        break;
    }
  }
  return [...runs].map(([runId, seqs]) => ({ runId, openSeqs: [...seqs] }));
}

// packages/dsh-host/src/port/types.ts
var DSH_IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

// packages/dsh-host/src/port/loop.ts
var WAKE_SOURCE_KIND = "raw-agent-wake";
function presetIdFor(kind) {
  return `raw-agent-${kind}`;
}
var randomId = () => globalThis.crypto.randomUUID();
function liveChannel(ctx, agent, counters) {
  return {
    emit: (frame) => ctx.emit("agent/assistant-stream", { agent, frame }),
    nextRevision: () => ++counters.revision,
    nextAttemptId: () => `${agent.session.id}:raw-${++counters.attempt}`
  };
}
function toDshUsage(u) {
  const out = {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite
  };
  if (u.reasoning !== void 0) out.reasoningTokens = u.reasoning;
  return out;
}
function toResultBlocks(content) {
  return content.map((c) => {
    switch (c.type) {
      case "text":
        return { type: "text", text: c.text };
      case "saved-image":
        return { type: "image", attachment: c.ref };
      case "image":
        return { type: "text", text: imageUnavailableText(c.mediaType, "it was not stored") };
      default:
        return { type: "text", text: JSON.stringify(c.value) };
    }
  });
}
async function saveResultImages(ctx, images) {
  const store = ctx.get("attachments");
  if (typeof store?.saveImages !== "function") throw new Error("no attachment store is mounted");
  const decoded = images.map((i) => {
    if (!DSH_IMAGE_MEDIA_TYPES.includes(i.mediaType))
      throw new Error(`the media type ${i.mediaType} is not PNG, JPEG, WebP or GIF`);
    const data = Buffer.from(i.base64, "base64");
    if (data.length === 0) throw new Error("the image data is empty or not base64");
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), mediaType: i.mediaType };
  });
  return store.saveImages(decoded);
}
function sinkFor(log, agent, ctx, onClaimed) {
  return {
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    claim: (id) => {
      const claimed = log.claim(id, agent.inbox);
      if (claimed) onClaimed?.(id);
      return claimed;
    },
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    get turn() {
      return log.turn;
    },
    openStep: (startedAt) => log.openStep(startedAt),
    delta: (k, i, t, at, tool) => log.delta(k, i, t, at, tool),
    commit: (m) => {
      const input = {
        blocks: m.blocks.map((b) => b.type === "reasoning" ? { type: "reasoning", text: b.text } : b),
        binding: m.binding
      };
      if (m.usage) input.usage = toDshUsage(m.usage);
      if (m.model) input.model = m.model;
      if (m.interrupted) input.interrupted = true;
      if (m.continued) input.continued = true;
      return log.commit(input);
    },
    result: (id, content, isError, chainId) => log.result(id, toResultBlocks(content), isError, chainId === void 0 ? void 0 : { chainUuid: chainId }),
    saveImages: (images) => saveResultImages(ctx, images),
    closeStep: () => log.closeStep(),
    approvalAsked: (info) => log.approvalAsked(info),
    approvalDecided: (id, outcome) => log.approvalDecided(id, outcome),
    trigger: (text, items) => log.trigger(text, WAKE_SOURCE_KIND, items)
  };
}
var AttachmentInputError = class extends Error {
  name = "AttachmentInputError";
};
var hasImage = (m) => m.content.some((b) => b.type === "image");
function attachmentName(ref) {
  const n = ref?.name;
  return typeof n === "string" && n !== "" ? `"${n}"` : "a file";
}
function buildInput(factory, m, ctx, images = []) {
  const parts = [];
  const store = ctx.get("attachments");
  let k = 0;
  for (const b of m.content) {
    if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
    else if (b.type === "file") {
      const path9 = typeof store?.fileHostPath === "function" ? store.fileHostPath(b.attachment) : void 0;
      if (path9 === void 0 || path9 === "")
        throw new AttachmentInputError(
          `${attachmentName(b.attachment)} has no local copy on this host, so ${factory.displayName} cannot read it`
        );
      parts.push({ type: "file", hostPath: path9 });
    } else if (b.type === "image") {
      const image = images[k++];
      if (image === void 0) throw new AttachmentInputError("an attached image was not read");
      parts.push({ type: "image", mediaType: image.mediaType, base64: image.base64 });
    }
  }
  return { id: factory.inputIdFor?.(m.id) ?? m.id, parts };
}
async function readImages(m, ctx, signal) {
  const blocks = m.content.filter((b) => b.type === "image");
  if (blocks.length === 0) return [];
  const store = ctx.get("attachments");
  if (typeof store?.readImage !== "function")
    throw new AttachmentInputError("an image is attached, but no attachment store is mounted");
  const out = [];
  for (const b of blocks) {
    let stored;
    try {
      stored = await store.readImage(b.attachment, signal);
    } catch (error) {
      throw new AttachmentInputError(
        `an attached image could not be read: ${String(error?.message ?? error)}`,
        {
          cause: error
        }
      );
    }
    const ref = b.attachment ?? {};
    const mediaType = stored.ref?.mediaType ?? (typeof ref.mediaType === "string" ? ref.mediaType : void 0);
    if (mediaType === void 0) throw new AttachmentInputError("an attached image has no media type");
    out.push({ mediaType, base64: Buffer.from(stored.data).toString("base64") });
  }
  return out;
}
async function toInput(factory, m, ctx, signal) {
  return buildInput(factory, m, ctx, await readImages(m, ctx, signal));
}
function latestBinding(agent, kind) {
  const events = agent.session.snapshotEvents();
  let laterChain;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "tool/result" && laterChain === void 0) {
      const c = e.data.meta?.chainUuid;
      if (typeof c === "string") laterChain = c;
      continue;
    }
    if (e.type !== "assistant/message") continue;
    const b = (e.data.message.source ?? {}).rawAgent;
    if (b?.backend !== kind || typeof b.sessionId !== "string" || b.sessionId === "") continue;
    const out = { sessionId: b.sessionId };
    if (typeof b.hostSessionId === "string") out.hostSessionId = b.hostSessionId;
    const chain = laterChain ?? (typeof b.lastChainId === "string" ? b.lastChainId : void 0);
    if (chain !== void 0) out.chainId = chain;
    if (typeof b.mode === "string" && b.mode !== "") out.mode = b.mode;
    return out;
  }
  return void 0;
}
async function sourceEvents(ctx, sessionId) {
  try {
    const live = ctx.get("sessions")?.get?.(sessionId);
    if (live && typeof live.snapshotEvents === "function") return live.snapshotEvents();
  } catch {
  }
  const query = ctx.get("sessionQuery");
  if (typeof query?.readSession !== "function") return void 0;
  return (await query.readSession(sessionId)).events;
}
function modelChoice(agent, kind) {
  const events = agent.session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "model/selection") continue;
    const d = e.data;
    if (d.provider !== kind) continue;
    return d.model === SETTINGS_MODEL || typeof d.model !== "string" ? void 0 : d.model;
  }
  return void 0;
}
function messageText(m) {
  return m.content.map((b) => b.type === "text" && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
}
function hostRegistry(ctx) {
  try {
    const r = ctx.get(SESSIONS_SERVICE);
    return isSessionRegistry(r) ? r : void 0;
  } catch {
    return void 0;
  }
}
function mountAgent(ctx, o) {
  const factory = o.factory;
  const shared = o.registry ?? hostRegistry(ctx);
  const registry = shared ?? new SessionRegistry();
  const mine = /* @__PURE__ */ new Set();
  const counters = /* @__PURE__ */ new WeakMap();
  const warn = (note, detail) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? "");
  const jobs = () => ctx.get("jobs");
  const presetId = o.presetId ?? presetIdFor(factory.kind);
  const forwardable = (m) => m.source.kind === "user" || (m.source.kind === PLUGIN_SOURCE_KIND && typeof registry.pluginSender === "function" ? registry.pluginSender(m.id) !== void 0 : false);
  const consume = (id) => {
    if (typeof registry.takePluginMessage === "function") registry.takePluginMessage(id);
  };
  const j = jobs();
  if (j) ctx.effect(() => j.attachController("raw-agent"), "raw-agent: job controller");
  const portFor = (agent) => ({
    hostSessionId: agent.session.id,
    cwd: agent.session.header.cwd ?? process.cwd(),
    wake(summary) {
      agent.followup({
        id: randomId(),
        role: "user",
        content: [{ type: "text", text: summary }],
        source: { kind: WAKE_SOURCE_KIND, form: "notice", summary }
      });
    },
    latestBinding: () => latestBinding(agent, factory.kind),
    // M7 (D29): the first dropped source turn's human message, read from the source log.
    forkDroppedMessage: async () => {
      const cut = forkCut(agent.session.snapshotEvents());
      const source = latestBinding(agent, factory.kind)?.hostSessionId;
      if (!cut || cut.midTurn || source === void 0 || source === agent.session.id) return void 0;
      const events = await sourceEvents(ctx, source);
      return events ? droppedHumanMessage(events, cut) : void 0;
    },
    forkedFromChild: () => {
      if (!agent.session.header.isSeeded) return false;
      const events = agent.session.snapshotEvents();
      return forkCut(events)?.childPrefix === true && latestBinding(agent, factory.kind) === void 0;
    },
    tasksEndedByStop: () => tasksEndedByStop(agent.session.snapshotEvents()),
    rewindPoints: () => rewindPoints(agent.session.snapshotEvents()),
    modelChoice: () => modelChoice(agent, factory.kind),
    // D36: session-only. `agent.model.select` records `model/selection` and never saves the host
    // default (DSH's `session.selectModel` would, K1).
    selectModel(model) {
      agent.model.select({ provider: factory.kind, model });
    },
    startJob(task, stop, onTeardown) {
      const registry2 = jobs();
      return registry2 ? startJob(registry2, agent.session.id, task, stop, warn, onTeardown) : void 0;
    },
    // D45: child agents become one-shot host child sessions of this session.
    createChild: (spec, runner) => createChildSession(
      ctx,
      agent,
      { factory, presetId, warn, ...o.writer ? { writer: o.writer } : {} },
      spec,
      runner
    ),
    // D48: native workflow records in this (the parent) session; no DSH workflow call (R2.4).
    recordWorkflow: (record) => appendWorkflowRecord(agent.session, record),
    openWorkflowRuns: () => openWorkflowRuns(agent.session),
    warn,
    returnDraft(messageId) {
      const m = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find((x) => x.id === messageId);
      try {
        agent.inbox.remove?.(messageId);
      } catch (error) {
        warn("could not remove a cancelled steer from the inbox", String(error));
      }
      const draft = { messageId, text: m ? messageText(m) : "", at: Date.now() };
      const attachments = m ? m.content.filter((b) => b.type !== "text").length : 0;
      if (attachments > 0) draft.attachments = attachments;
      registry.noteDraft(agent.session.id, draft);
      ctx.emit("raw-agent/draft-returned", { sessionId: agent.session.id, ...draft });
    },
    notify(state) {
      ctx.emit("raw-agent/state", { sessionId: agent.session.id, state });
    },
    // R7.1, D52: the agent's command list changed; update the rows in this agent's `/` menu.
    commandsChanged: () => menus.sync(agent.id)
  });
  const runtimeFor = (agent) => {
    const existing = registry.get(agent.id, factory.kind);
    if (existing) {
      if (!mine.has(agent.id)) {
        existing.attach(portFor(agent));
        mine.add(agent.id);
        shadowPermission(agent);
      }
      return existing;
    }
    const opts = { env: o.env ?? process.env };
    if (o.stopGraceMs !== void 0) opts.stopGraceMs = o.stopGraceMs;
    const userConfig = o.userConfig ?? shared?.userConfig;
    if (userConfig) opts.userConfig = userConfig;
    const r = new SessionRuntime(factory, portFor(agent), opts);
    registry.set(agent.id, factory.kind, r);
    mine.add(agent.id);
    shadowPermission(agent);
    return r;
  };
  const menus = new AgentCommandMenus({
    factory,
    runtime: (id) => registry.get(id, factory.kind),
    warn,
    ...o.modeCommand === false ? { modeCommand: false } : {}
  });
  const shadowPermission = (agent) => menus.mount(agent);
  const unshadowPermission = (agentId) => menus.unmount(agentId);
  ctx.on(
    "agent/pre-step",
    (async (_p, next) => {
      const d = await next();
      return d.kind === "reject" ? d : { kind: "enter", messages: [] };
    }),
    { prepend: true }
  );
  ctx.on("agent/pre-step", (async (p, _next) => {
    const { agent, messages, turn, signal } = p;
    if (messages.length === 0) return { kind: "enter", messages: [] };
    if (agent.session.header.origin === "subagent") return await childPreStep(p) ?? { kind: "enter", messages: [] };
    const human = messages.filter(forwardable);
    const wake = messages.some((m) => m.source.kind === WAKE_SOURCE_KIND);
    const log = new TurnLog(agent.session, liveChannel(ctx, agent, counters.get(agent) ?? newCounters(agent)), turn, {
      provider: factory.kind,
      warn,
      ...o.writer
    });
    for (const m of human) {
      if (m.source.kind === PLUGIN_SOURCE_KIND) consume(m.id);
      log.writeUser(m);
    }
    const runtime = runtimeFor(agent);
    let userInputs;
    try {
      userInputs = await Promise.all(human.map((m) => toInput(factory, m, ctx, signal)));
    } catch (error) {
      log.close();
      throw new Error(
        `${factory.displayName} was not sent this message: ${String(error?.message ?? error)}`,
        {
          cause: error
        }
      );
    }
    const outcome = await runtime.runTurn(sinkFor(log, agent, ctx, consume), { userInputs, wake }, signal);
    log.close();
    if (outcome.kind === "error") throw new Error(outcome.message);
    signal.throwIfAborted();
    return { kind: "enter", messages: [] };
  }));
  function newCounters(agent) {
    const c = { revision: 0, attempt: 0 };
    counters.set(agent, c);
    return c;
  }
  ctx.on("agent/status", ((p) => {
    const { agent, status } = p;
    if (status !== "idle" || agent.session.header.origin === "subagent") return;
    const message = agent.inbox.nextTurn.at(0);
    if (!message) return;
    try {
      spliceInbox(agent.session, agent.inbox, { target: "next-turn", start: 0, removedCount: 1, inserted: [] });
    } catch (error) {
      warn("refused the re-wake splice", String(error));
      return;
    }
    try {
      agent.send(message, "next-turn", true);
    } catch (error) {
      warn("the re-wake send failed; the message stays queued", String(error));
      try {
        spliceInbox(agent.session, agent.inbox, {
          target: "next-turn",
          start: 0,
          removedCount: 0,
          inserted: [message]
        });
      } catch (again) {
        warn("could not put the queued message back", String(again));
      }
    }
  }));
  ctx.on("agent/inbox/inserted", ((p) => {
    const { agent, message } = p;
    if (!agent || !message || agent.session.header.origin === "subagent") return;
    if (!forwardable(message)) return;
    if (factory.staticCapabilities.steer === "queue") return;
    if (!agent.inbox.nextStep.some((m) => m.id === message.id)) return;
    const runtime = registry.get(agent.id, factory.kind);
    if (!runtime) return;
    if (!hasImage(message)) {
      try {
        runtime.steer(message.id, buildInput(factory, message, ctx));
      } catch (error) {
        warn("could not send a steer", String(error));
      }
      return;
    }
    toInput(factory, message, ctx).then(
      (input) => runtime.steer(message.id, input),
      (error) => warn("could not send a steer", String(error))
    );
  }));
  ctx.on("agent/created", ((p) => {
    if (p.agent?.session.header.origin === "subagent") return;
    try {
      runtimeFor(p.agent);
    } catch (error) {
      warn("could not attach the session runtime", String(error));
    }
    return void 0;
  }));
  const routeBefore = /* @__PURE__ */ new Map();
  const lastSelection = (agent) => {
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i].type === "model/selection") return events[i].data;
    return void 0;
  };
  const recordSettingsModel = (agent) => {
    if (!o.selectSettingsModel || agent.session.header.isSeeded) return;
    if (lastSelection(agent)?.provider === factory.kind) return;
    try {
      const before = agent.model.current();
      if (typeof before?.provider === "string" && typeof before.model === "string" && before.provider !== factory.kind)
        routeBefore.set(agent.id, { provider: before.provider, model: before.model });
      agent.model.select({ provider: factory.kind, model: "settings" });
    } catch (error) {
      warn("could not record the settings model selection", String(error));
    }
  };
  ctx.on("agent/created", ((p) => {
    if (p.source === "startup") recordSettingsModel(p.agent);
    return void 0;
  }));
  const adoptRebound = () => {
    let agents;
    let presets;
    try {
      agents = ctx.get("agents")?.list?.() ?? [];
      presets = ctx.get("agentPresets");
    } catch {
      return;
    }
    if (typeof presets?.composedPreset !== "function") return;
    for (const agent of agents) {
      if (agent.session.header.origin === "subagent" || agent.ctx === void 0) continue;
      let bound;
      try {
        bound = presets.composedPreset(agent.ctx);
      } catch {
        continue;
      }
      if (mine.has(agent.id)) {
        if (bound !== void 0 && bound !== presetId) leaveRebound(agent);
        continue;
      }
      if (bound !== presetId) continue;
      try {
        runtimeFor(agent);
        recordSettingsModel(agent);
      } catch (error) {
        warn("could not attach the session runtime", String(error));
      }
    }
  };
  function leaveRebound(agent) {
    const runtime = registry.get(agent.id, factory.kind);
    if (runtime?.backend !== void 0) return;
    if (agent.session.snapshotEvents().some((e) => e.type === "turn/start")) return;
    const last = lastSelection(agent);
    const before = routeBefore.get(agent.id);
    if (before && last?.provider === factory.kind && last.model === "settings") {
      try {
        agent.model.select(before);
      } catch (error) {
        warn("could not restore the model route", String(error));
      }
    }
    routeBefore.delete(agent.id);
    mine.delete(agent.id);
    unshadowPermission(agent.id);
    void registry.delete(agent.id);
  }
  ctx.on("tools/change", (() => {
    adoptRebound();
    return void 0;
  }));
  const release = (id) => {
    menus.forget(id);
    if (!mine.delete(id)) return;
    if (shared) registry.get(id, factory.kind)?.detach();
    else void registry.delete(id);
  };
  ctx.on("agent/disposed", ((p) => release(p.agent.id)));
  ctx.effect(
    () => () => {
      for (const id of [...mine]) release(id);
    },
    "raw-agent: backend sessions"
  );
  return {
    registry,
    shared: shared !== void 0,
    runtime: (id) => registry.get(id, factory.kind)
  };
}

// packages/dsh-host/src/port/routes.ts
import { readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";

// packages/dsh-host/src/config-preview.ts
var MAX_PREVIEW_BYTES = 1024 * 1024;
var fail = (status, error) => ({ status, body: { error } });
function pickFactory(deps, kind) {
  if (kind === null || kind === "") return deps.factories.find((f) => f.configFiles !== void 0);
  return deps.factories.find((f) => f.kind === kind);
}
async function filesFor(url, deps) {
  const sessionId = url.searchParams.get("session");
  if (sessionId === null || sessionId === "") return fail(400, "missing session");
  const factory = pickFactory(deps, url.searchParams.get("backend"));
  if (!factory?.configFiles) return fail(404, "no settings files for this backend");
  const cwd = deps.cwdOf(sessionId);
  if (cwd === void 0) return fail(404, "no live session with a folder");
  return { factory, files: await factory.configFiles(cwd) };
}
async function listConfigFiles(url, deps) {
  const r = await filesFor(url, deps);
  if ("status" in r) return r;
  const items = r.files.map((f) => ({ ...f, exists: deps.readFile(f.path).kind !== "missing" }));
  return { status: 200, body: { backend: r.factory.kind, files: items } };
}
async function previewConfigFile(url, deps) {
  const r = await filesFor(url, deps);
  if ("status" in r) return r;
  const scope = url.searchParams.get("scope");
  const file = r.files.find((f) => f.scope === scope);
  if (!file) return fail(404, "unknown settings scope");
  const read = deps.readFile(file.path);
  if (read.kind === "missing") return { status: 200, body: { ...file, exists: false } };
  if (read.kind === "error") return { status: 200, body: { ...file, exists: true, error: read.message } };
  if (read.size > MAX_PREVIEW_BYTES)
    return { status: 200, body: { ...file, exists: true, tooLarge: true, size: read.size, mtimeMs: read.mtimeMs } };
  const masked = r.factory.maskConfig ? r.factory.maskConfig({ path: file.path, format: file.format }, read.text) : void 0;
  if (!masked) return { status: 200, body: { ...file, exists: true, error: "this backend cannot mask this file" } };
  const reveal = url.searchParams.get("reveal");
  if (reveal !== null) {
    const index = Number(reveal);
    const s = Number.isInteger(index) ? masked.secrets[index] : void 0;
    if (!s) return fail(404, "no such hidden value");
    return { status: 200, body: { index, key: s.key, value: read.text.slice(s.sourceStart, s.sourceEnd) } };
  }
  const body = {
    ...file,
    exists: true,
    masked: masked.masked,
    secrets: masked.secrets.map(({ start, end, key }) => key === void 0 ? { start, end } : { start, end, key }),
    mtimeMs: read.mtimeMs,
    size: read.size
  };
  return { status: 200, body };
}

// packages/dsh-host/src/port/routes.ts
var CONFIG_FILES_ROUTE = "/api/raw-agent/config-files";
var CONFIG_FILE_ROUTE = "/api/raw-agent/config-file";
function readFileForPreview(p) {
  try {
    const st = statSync3(p);
    if (!st.isFile()) return { kind: "error", message: "not a regular file" };
    if (st.size > 1024 * 1024) return { kind: "ok", text: "", mtimeMs: st.mtimeMs, size: st.size };
    return { kind: "ok", text: readFileSync2(p, "utf8"), mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "error", message: code ?? "unreadable" };
  }
}
var json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function configRoutes(deps) {
  const wrap = (fn) => async (request) => {
    try {
      const r = await fn(new URL(request.url), deps);
      return json(r.status, r.body);
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  };
  return [
    { path: CONFIG_FILES_ROUTE, methods: ["GET"], requestBody: "buffered", fetch: wrap(listConfigFiles) },
    { path: CONFIG_FILE_ROUTE, methods: ["GET"], requestBody: "buffered", fetch: wrap(previewConfigFile) }
  ];
}
function mountConfigRoutes(ctx, factories) {
  if (!factories.some((f) => f.configFiles !== void 0)) return false;
  const register = (c) => {
    const connection = c.get("connection");
    if (!connection?.fetch) return;
    const routes = configRoutes({
      factories,
      cwdOf(sessionId) {
        const sessions = c.get("sessions");
        const cwd = sessions?.get(sessionId)?.header.cwd;
        return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
      },
      readFile: readFileForPreview
    });
    for (const r of routes) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(["connection"], register);
  else register(ctx);
  return true;
}
var START_ROUTE = "/api/raw-agent/start";
var FORCE_STOP_ROUTE = "/api/raw-agent/force-stop";
var STATE_ROUTE = "/api/raw-agent/state";
var CHILD_STOP_ROUTE = "/api/raw-agent/child-stop";
var TASK_STOP_ROUTE = "/api/raw-agent/task-stop";
var CHILD_OF_ROUTE = "/api/raw-agent/child-of";
var WORKFLOW_STOP_ROUTE = "/api/raw-agent/workflow-stop";
var WORKFLOW_AGENT_STOP_ROUTE = "/api/raw-agent/workflow-agent-stop";
var TASK_OUTPUT_ROUTE = "/api/raw-agent/task-output";
var REWIND_ROUTE = "/api/raw-agent/rewind";
var REWIND_RESTORE_ROUTE = "/api/raw-agent/rewind-restore";
var REWIND_FILES_ROUTE = "/api/raw-agent/rewind-files";
var USAGE_ROUTE = "/api/raw-agent/usage";
var CONTEXT_ROUTE = "/api/raw-agent/context";
function lifecycleRoutes(registry, controls) {
  const handler = (fn) => async (request) => {
    const id = new URL(request.url).searchParams.get("session");
    if (!id) return json(400, { error: "missing session" });
    try {
      const r = await fn(id);
      return json(r.status, r.body);
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  };
  const missing = { status: 404, body: { error: "not a session of this plugin" } };
  return [
    {
      path: START_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        await r.start();
        return { status: 200, body: { state: r.state() } };
      })
    },
    {
      path: FORCE_STOP_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        await r.forceStop();
        return { status: 200, body: { state: r.state() } };
      })
    },
    {
      path: STATE_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        return { status: 200, body: { state: r.state(), returnedDrafts: registry.takeDrafts(id) } };
      })
    },
    {
      path: CHILD_STOP_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        const child = url.searchParams.get("child");
        if (!id || !child) return json(400, { error: "missing session or child" });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopChild(child);
          return json(result.ok ? 200 : result.status === "unknown" ? 404 : 409, result);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: TASK_STOP_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        const task = url.searchParams.get("task");
        if (!id || !task) return json(400, { error: "missing session or task" });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopTask(task);
          return json(result.ok ? 200 : 409, result);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: WORKFLOW_STOP_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        const task = url.searchParams.get("task");
        if (!id || !task) return json(400, { error: "missing session or task" });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopWorkflow(task);
          return json(result.ok ? 200 : result.status === "unknown" ? 404 : 409, result);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: WORKFLOW_AGENT_STOP_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        const task = url.searchParams.get("task");
        const agent = url.searchParams.get("agent");
        if (!id || !task || !agent) return json(400, { error: "missing session, task or agent" });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopWorkflowAgent(task, agent);
          const status = result.ok ? 200 : result.unsupported ? 409 : result.status === "unknown" ? 404 : 409;
          return json(status, result);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      // Only a task this session's own process started (a shell or a monitor): the task id is
      // looked up in that runtime, never used as a path. No file is served.
      path: TASK_OUTPUT_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        const task = url.searchParams.get("task");
        if (!id || !task) return json(400, { error: "missing session or task" });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.taskOutput(task);
          if (result.ok) return json(200, result);
          return json(result.code === "unknown" ? 404 : result.code === "unsupported" ? 409 : 502, result);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: CHILD_OF_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: handler(async (id) => {
        const found = registry.findChild?.(id);
        if (!found) return { status: 404, body: { error: "not a child session of this plugin" } };
        return { status: 200, body: found };
      })
    },
    ...rewindRoutes(registry),
    ...usageRoutes(registry),
    ...commandRoutes(registry),
    ...controls ? sessionControlRoutes(registry, controls) : []
  ];
}
function rewindRoutes(registry) {
  const missing = () => json(404, { error: "not a session of this plugin" });
  const lookup = (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("session");
    return { url, id, runtime: id ? registry.get(id) : void 0 };
  };
  const guard2 = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  };
  return [
    {
      path: REWIND_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.rewindOptions !== "function") return json(409, { error: "this runtime cannot rewind" });
        return json(200, await runtime.rewindOptions());
      })
    },
    {
      path: REWIND_RESTORE_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { url, id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.requestCodeRestore !== "function")
          return json(409, { error: "this runtime cannot rewind" });
        const on = url.searchParams.get("on") !== "0";
        const r = runtime.requestCodeRestore(on);
        return json(r.ok ? 200 : 409, r);
      })
    },
    {
      path: REWIND_FILES_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { url, id, runtime } = lookup(request);
        const message = url.searchParams.get("message");
        if (!id || !message || message.length > 256) return json(400, { error: "missing session or message" });
        if (!runtime) return missing();
        if (typeof runtime.rewindFiles !== "function") return json(409, { error: "this runtime cannot rewind" });
        const r = await runtime.rewindFiles(message, url.searchParams.get("dryRun") === "1");
        const status = r.ok ? 200 : r.code === "failed" ? 502 : 409;
        return json(status, r);
      })
    }
  ];
}
function usageRoutes(registry) {
  const missing = json(404, { error: "not a session of this plugin" });
  return [
    {
      path: USAGE_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const id = new URL(request.url).searchParams.get("session");
        if (!id) return json(400, { error: "missing session" });
        const r = registry.get(id);
        if (!r) return missing;
        if (typeof r.usage !== "function") return json(409, { error: "this runtime has no usage data" });
        try {
          return json(200, await r.usage());
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: CONTEXT_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get("session");
        if (!id) return json(400, { error: "missing session" });
        const detail = url.searchParams.get("detail") ?? "summary";
        if (detail !== "summary" && detail !== "full") return json(400, { error: "detail must be summary or full" });
        const r = registry.get(id);
        if (!r) return missing;
        if (typeof r.contextUsage !== "function") return json(409, { error: "this runtime has no context data" });
        try {
          return json(200, await r.contextUsage(detail));
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    }
  ];
}
var COMMANDS_ROUTE = "/api/raw-agent/commands";
var SIDE_QUESTION_ROUTE = "/api/raw-agent/side-question";
var SIDE_QUESTION_CANCEL_ROUTE = "/api/raw-agent/side-question-cancel";
var MCP_ROUTE = "/api/raw-agent/mcp";
var MCP_RECONNECT_ROUTE = "/api/raw-agent/mcp-reconnect";
var MCP_TOGGLE_ROUTE = "/api/raw-agent/mcp-toggle";
var MCP_AUTH_ROUTE = "/api/raw-agent/mcp-auth";
var MCP_AUTH_CALLBACK_ROUTE = "/api/raw-agent/mcp-auth-callback";
var LOCAL_OUTPUT_ROUTE = "/api/raw-agent/local-output";
var MAX_MCP_TEXT = 4096;
var MAX_SIDE_BODY = 128 * 1024;
async function readJson2(request, max) {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new RangeError("the body is too large");
  const body = request.body;
  if (!body) return JSON.parse(await request.text());
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => void 0);
      throw new RangeError("the body is too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
function commandRoutes(registry) {
  const missing = () => json(404, { error: "not a session of this plugin" });
  const lookup = (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("session");
    return { url, id, runtime: id ? registry.get(id) : void 0 };
  };
  const guard2 = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  };
  const mcpStatusOf = (code) => code === "unknown-server" ? 404 : code === "failed" ? 502 : 409;
  const serverParam = (url) => {
    const s = url.searchParams.get("server");
    return s && s.length <= MAX_MCP_TEXT ? s : void 0;
  };
  return [
    {
      path: COMMANDS_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.commandsAnswer !== "function") return json(409, { error: "this runtime has no commands" });
        return json(200, await runtime.commandsAnswer());
      })
    },
    {
      path: SIDE_QUESTION_ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.askSideQuestion !== "function" || typeof runtime.sideQuestions !== "function")
          return json(409, { error: "this runtime has no side questions" });
        if (request.method !== "POST") return json(200, runtime.sideQuestions());
        let body;
        try {
          body = await readJson2(request, MAX_SIDE_BODY);
        } catch {
          return json(400, { error: 'the body must be JSON: {"question": "\u2026"}' });
        }
        const question = body?.question;
        if (typeof question !== "string") return json(400, { error: "question must be text" });
        const asked = runtime.askSideQuestion(question);
        const r = await Promise.race([asked, new Promise((done) => setTimeout(() => done(void 0), 0))]);
        const side = runtime.sideQuestions();
        if (r === void 0) {
          const entry = side.entries.at(-1);
          return json(202, { ok: true, ...entry ? { entry } : {}, side });
        }
        if (r.ok) return json(r.entry.status === "answered" ? 200 : 202, { ...r, side });
        return json(r.code === "busy" || r.code === "unsupported" ? 409 : 400, { ...r, side });
      })
    },
    {
      path: SIDE_QUESTION_CANCEL_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { url, id, runtime } = lookup(request);
        const entry = url.searchParams.get("id");
        if (!id || !entry) return json(400, { error: "missing session or id" });
        if (!runtime) return missing();
        if (typeof runtime.cancelSideQuestion !== "function") return json(409, { error: "no side questions" });
        const ok = runtime.cancelSideQuestion(entry);
        return json(ok ? 200 : 409, { ok, side: runtime.sideQuestions?.() });
      })
    },
    {
      path: MCP_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.mcp !== "function") return json(409, { error: "this runtime has no MCP data" });
        return json(200, await runtime.mcp());
      })
    },
    ...[
      [MCP_RECONNECT_ROUTE, "reconnect"],
      [MCP_TOGGLE_ROUTE, "toggle"],
      [MCP_AUTH_ROUTE, "authenticate"]
    ].map(([path9, action]) => ({
      path: path9,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { url, id, runtime } = lookup(request);
        const server = serverParam(url);
        if (!id || server === void 0) return json(400, { error: "missing session or server" });
        if (!runtime) return missing();
        if (typeof runtime.mcpAction !== "function") return json(409, { error: "this runtime has no MCP controls" });
        let arg;
        if (action === "toggle") {
          const enabled = url.searchParams.get("enabled");
          if (enabled !== "true" && enabled !== "false") return json(400, { error: "enabled must be true or false" });
          arg = { enabled: enabled === "true" };
        }
        const r = await runtime.mcpAction(action, server, arg);
        return json(r.ok ? 200 : mcpStatusOf(r.code), r);
      })
    })),
    {
      path: MCP_AUTH_CALLBACK_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { id, runtime } = lookup(request);
        if (!id) return json(400, { error: "missing session" });
        if (!runtime) return missing();
        if (typeof runtime.mcpAction !== "function") return json(409, { error: "this runtime has no MCP controls" });
        let body;
        try {
          body = await readJson2(request, MAX_MCP_TEXT * 2);
        } catch {
          return json(400, { error: 'the body must be JSON: {"server": "\u2026", "url": "\u2026"}' });
        }
        const b = body ?? {};
        if (typeof b.server !== "string" || b.server === "" || b.server.length > MAX_MCP_TEXT)
          return json(400, { error: "server must be a server name" });
        if (typeof b.url !== "string" || !/^https?:\/\//i.test(b.url) || b.url.length > MAX_MCP_TEXT)
          return json(400, { error: "url must be the http(s) address the browser ended on" });
        const r = await runtime.mcpAction("auth-callback", b.server, { callbackUrl: b.url });
        return json(r.ok ? 200 : mcpStatusOf(r.code), r);
      })
    },
    {
      path: LOCAL_OUTPUT_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => guard2(async () => {
        const { url, id, runtime } = lookup(request);
        const out = url.searchParams.get("id");
        if (!id || !out) return json(400, { error: "missing session or id" });
        if (!runtime) return missing();
        const found = runtime.localOutput?.(out);
        if (!found) return json(404, { error: "this output is no longer kept; its text is in the conversation" });
        return json(200, found);
      })
    }
  ];
}
var SESSION_ROUTE = "/api/raw-agent/session";
var CHOICE_ROUTE = "/api/raw-agent/choice";
var ANSWER_ROUTE = "/api/raw-agent/answer";
var INTERACTIONS_ROUTE = "/api/raw-agent/interactions";
var INTERACTIONS_PING_MS = 25e3;
var MODEL_ID = /^[\w.:@/[\]-]{1,200}$/;
function parseChoice(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "the body must be a JSON object";
  const b = body;
  const out = {};
  if (b.model !== void 0) {
    if (typeof b.model !== "string" || !MODEL_ID.test(b.model)) return "model must be a model id";
    out.model = b.model;
  }
  if (b.effort !== void 0) {
    if (b.effort !== null && (typeof b.effort !== "string" || !MODEL_ID.test(b.effort))) return "bad effort";
    out.effort = b.effort;
  }
  if (b.mode !== void 0) {
    if (typeof b.mode !== "string" || !MODEL_ID.test(b.mode)) return "bad mode";
    out.mode = b.mode;
  }
  if (b.agent !== void 0) {
    if (b.agent !== null && (typeof b.agent !== "string" || !MODEL_ID.test(b.agent))) return "bad agent";
    out.agent = b.agent;
  }
  if (out.model === void 0 && out.effort === void 0 && out.mode === void 0 && out.agent === void 0)
    return "nothing to choose";
  return out;
}
var MAX_ANSWER_BYTES = 512 * 1024;
var plainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseAnswer(body) {
  if (!plainObject(body)) return "the body must be a JSON object";
  const b = body;
  if (typeof b.ask !== "string" || !MODEL_ID.test(b.ask)) return "ask must be an ask id";
  if (typeof b.choice !== "string" || !MODEL_ID.test(b.choice)) return "choice must be a choice id";
  try {
    if (JSON.stringify(b).length > MAX_ANSWER_BYTES) return "the answer is too large";
  } catch {
    return "the body must be JSON";
  }
  const out = { ask: b.ask, choice: b.choice };
  if (b.feedback !== void 0) {
    if (typeof b.feedback !== "string") return "feedback must be text";
    out.feedback = b.feedback;
  }
  if (b.answers !== void 0) {
    if (!plainObject(b.answers)) return "answers must be an object";
    out.answers = b.answers;
  }
  if (b.notes !== void 0) {
    if (!plainObject(b.notes)) return "notes must be an object";
    out.notes = b.notes;
  }
  if (b.content !== void 0) {
    if (!plainObject(b.content)) return "content must be an object";
    out.content = b.content;
  }
  if (b.rule !== void 0) {
    if (typeof b.rule !== "string") return "rule must be text";
    out.rule = b.rule;
  }
  return out;
}
function channelLine(view) {
  const line = {
    type: "asks",
    asks: view.asks ?? [],
    state: view.state,
    live: view.live,
    children: view.children ?? [],
    team: view.team ?? null,
    tasks: view.tasks ?? [],
    workflows: view.workflows ?? [],
    // M5: the pill's small usage summary, so context and totals update without a poll (D59).
    usage: view.usage ?? null,
    // M6: side questions (D54), the command list version (R7.1) and the MCP summary (R7.4).
    side: view.side ?? null,
    menu: view.menu ?? null,
    mcp: view.mcp ?? null
  };
  return `${JSON.stringify(line)}
`;
}
function interactionsRoute(registry, pingMs = INTERACTIONS_PING_MS) {
  return {
    path: INTERACTIONS_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    async fetch(request) {
      const id = new URL(request.url).searchParams.get("session");
      if (!id) return json(400, { error: "missing session" });
      const runtime = registry.get(id);
      if (!runtime) return json(404, { error: "not a session of this plugin" });
      const enc = new TextEncoder();
      let stop = () => {
      };
      const stream = new ReadableStream({
        start(controller) {
          let last = "";
          let closed = false;
          const send = (line) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(line));
            } catch {
              stop();
            }
          };
          const push = (view) => {
            const line = channelLine(view);
            if (line === last) return;
            last = line;
            send(line);
          };
          let unsubscribe = () => {
          };
          const timer = setInterval(() => send('{"type":"ping"}\n'), pingMs);
          timer.unref?.();
          stop = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            request.signal?.removeEventListener("abort", stop);
            try {
              controller.close();
            } catch {
            }
          };
          request.signal?.addEventListener("abort", stop, { once: true });
          push(runtime.view());
          unsubscribe = runtime.subscribe(push, () => stop());
          if (closed) unsubscribe();
        },
        cancel() {
          stop();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    }
  };
}
function sessionControlRoutes(registry, deps) {
  const missing = { status: 404, body: { error: "not a session of this plugin" } };
  const describe = async (id) => {
    const runtime = registry.get(id);
    const kind = registry.kindOf(id);
    const factory = deps.factories.find((f) => f.kind === kind);
    if (!runtime || !factory) return void 0;
    const view = runtime.view();
    const live = view.models ?? registry.lastModels(factory.kind);
    const agentList = view.agents ?? registry.lastAgents?.(factory.kind, view.cwd);
    const models = [...live ?? []];
    for (const seed of deps.seedModels ?? [])
      if (!models.some((m) => m.value === seed)) models.push({ value: seed, displayName: seed });
    let settings;
    if (factory.settingsDefaults && view.cwd !== void 0) {
      try {
        settings = await factory.settingsDefaults(view.cwd);
      } catch {
        settings = void 0;
      }
    }
    let trust;
    if (factory.trustState && view.cwd !== void 0) {
      try {
        const t = await factory.trustState(view.cwd);
        if (t.state !== "trusted") {
          trust = { state: t.state, directory: t.directory };
          if (t.untrustedEffect !== void 0) trust.effect = t.untrustedEffect;
        }
      } catch {
        trust = void 0;
      }
    }
    const allModes = factory.staticCapabilities.permissionModes;
    const permissionModes = offeredPermissionModes(allModes, registry.userConfig?.().options, [
      view.live.mode,
      view.choice.pendingMode,
      settings?.permissionMode
    ]);
    const unavailableModes = allModes.filter((m) => !permissionModes.some((o) => o.id === m.id)).map((m) => {
      const option = factory.staticCapabilities.userOptions?.find((o) => o.key === m.requiresOption);
      return { ...m, ...option?.label !== void 0 ? { optionLabel: option.label } : {} };
    });
    return {
      backend: { kind: factory.kind, displayName: factory.displayName },
      permissionModes,
      ...unavailableModes.length > 0 ? { unavailableModes } : {},
      ...factory.staticCapabilities.permissionModeCycle ? { permissionModeCycle: [...factory.staticCapabilities.permissionModeCycle] } : {},
      efforts: factory.staticCapabilities.efforts ?? [],
      needsProcess: factory.staticCapabilities.needsProcess,
      models,
      modelsFrom: live ? view.models ? "session" : "recent" : "none",
      mainAgentPicker: factory.staticCapabilities.mainAgentPicker,
      agents: [...agentList ?? []],
      agentsFrom: agentList ? view.agents ? "session" : "recent" : "none",
      settings,
      trust,
      view
    };
  };
  return [
    {
      path: SESSION_ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const id = new URL(request.url).searchParams.get("session");
        if (!id) return json(400, { error: "missing session" });
        try {
          const body = await describe(id);
          return body ? json(200, body) : json(missing.status, missing.body);
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: CHOICE_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const id = new URL(request.url).searchParams.get("session");
        if (!id) return json(400, { error: "missing session" });
        const runtime = registry.get(id);
        if (!runtime) return json(missing.status, missing.body);
        let raw;
        try {
          raw = await request.json();
        } catch {
          return json(400, { error: "the body must be JSON" });
        }
        const choice = parseChoice(raw);
        if (typeof choice === "string") return json(400, { error: choice });
        try {
          const result = await runtime.choose(choice);
          return json(result.ok ? 200 : 409, { ...result, session: await describe(id) });
        } catch (e) {
          return json(500, { error: String(e?.message ?? e) });
        }
      }
    },
    {
      path: ANSWER_ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const id = new URL(request.url).searchParams.get("session");
        if (!id) return json(400, { error: "missing session" });
        const runtime = registry.get(id);
        if (!runtime) return json(missing.status, missing.body);
        let raw;
        try {
          raw = await request.json();
        } catch {
          return json(400, { error: "the body must be JSON" });
        }
        const a = parseAnswer(raw);
        if (typeof a === "string") return json(400, { error: a });
        const { ask, ...reply } = a;
        const r = runtime.respond(ask, reply);
        if (r.ok) return json(200, { ok: true, session: await describe(id) });
        return json(r.code === "gone" ? 409 : 400, { ok: false, error: r.error, session: await describe(id) });
      }
    },
    interactionsRoute(registry)
  ];
}
function mountLifecycleRoutes(ctx, registry, controls) {
  const register = (c) => {
    const connection = c.get("connection");
    if (!connection?.fetch) return;
    for (const r of lifecycleRoutes(registry, controls)) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(["connection"], register);
  else register(ctx);
}

// packages/dsh-host/src/grants.ts
import { createHash as createHash2, randomBytes, timingSafeEqual } from "node:crypto";
var GRANT_TOKEN_PREFIX = "rag1_";
var GRANTS_MAX = 50;
var HEX64 = /^[0-9a-f]{64}$/;
function hashToken(token) {
  return createHash2("sha256").update(token, "utf8").digest("hex");
}
function parseGrantRecords(raw) {
  const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const r of value) {
    if (r === null || typeof r !== "object") continue;
    const { id, label, hash, created } = r;
    if (typeof id !== "string" || id === "" || typeof hash !== "string" || !HEX64.test(hash)) continue;
    if (out.some((o) => o.id === id)) continue;
    out.push({
      id,
      label: typeof label === "string" && label !== "" ? label : id,
      hash,
      created: typeof created === "number" && Number.isFinite(created) ? created : 0
    });
  }
  return out;
}
var base64url = (b) => Buffer.from(b).toString("base64url");
var GrantStore = class {
  #persistence;
  #now;
  #random;
  /** Created in this run and not (yet) found in the stored list. */
  #local = /* @__PURE__ */ new Map();
  /** Revoked in this run: hidden even when the stored list still has them (a failed write). */
  #revoked = /* @__PURE__ */ new Set();
  #uses = /* @__PURE__ */ new Map();
  constructor(opts = {}) {
    this.#persistence = opts.persistence;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? ((n) => randomBytes(n));
  }
  #stored() {
    try {
      return parseGrantRecords(this.#persistence?.load());
    } catch {
      return [];
    }
  }
  #durable() {
    try {
      return this.#persistence?.durable?.() !== false;
    } catch {
      return false;
    }
  }
  #all() {
    const stored = this.#stored();
    const durable = this.#durable();
    const out = [];
    for (const r of stored) if (!this.#revoked.has(r.id)) out.push({ ...r, saved: durable });
    for (const r of this.#local.values())
      if (!this.#revoked.has(r.id) && !out.some((o) => o.id === r.id)) out.push({ ...r, saved: false });
    return out;
  }
  list() {
    return this.#all().map((r) => {
      const use = this.#uses.get(r.id);
      const v = { id: r.id, label: r.label, created: r.created, saved: r.saved, uses: use?.uses ?? 0 };
      if (use) v.lastUsed = use.last;
      return v;
    });
  }
  async #save(records) {
    if (!this.#persistence) return false;
    try {
      return await this.#persistence.save(records) === true;
    } catch {
      return false;
    }
  }
  /** Create a grant. The token is returned once and never again. */
  async create(label) {
    const checked = checkGrantLabel(label);
    if (!checked.ok) return checked;
    const all = this.#all();
    if (all.length >= GRANTS_MAX)
      return { ok: false, error: `There are already ${GRANTS_MAX} grants. Revoke one first.` };
    const token = `${GRANT_TOKEN_PREFIX}${base64url(this.#random(32))}`;
    const record = {
      id: `grant-${base64url(this.#random(9))}`,
      label: checked.label,
      hash: hashToken(token),
      created: this.#now()
    };
    const saved = await this.#save([...all.map(({ saved: _saved, ...r }) => r), record]) && this.#durable();
    this.#local.set(record.id, record);
    const grant = { id: record.id, label: record.label, created: record.created, saved, uses: 0 };
    return { ok: true, grant, token };
  }
  /** Revoke one grant. Applies at once, even when the stored list cannot be written. */
  async revoke(id) {
    const all = this.#all();
    if (!all.some((r) => r.id === id)) return { ok: false, saved: false };
    this.#revoked.add(id);
    this.#local.delete(id);
    const keep2 = all.filter((r) => r.id !== id).map(({ saved: _saved, ...r }) => r);
    const stored = this.#stored().some((r) => r.id === id);
    const written = stored ? await this.#save(keep2) : true;
    return { ok: true, saved: written || !this.#durable() };
  }
  /** True while the grant with this id exists and is not revoked. Counts no use. */
  active(id) {
    return this.#all().some((r) => r.id === id);
  }
  /** The grant a token names, if any. Counts the use. */
  check(token) {
    if (typeof token !== "string" || !token.startsWith(GRANT_TOKEN_PREFIX) || token.length > 200) return void 0;
    const hash = Buffer.from(hashToken(token), "hex");
    let found;
    for (const r of this.#all()) {
      const other = Buffer.from(r.hash, "hex");
      if (other.length === hash.length && timingSafeEqual(other, hash)) found = r;
    }
    if (!found) return void 0;
    const use = this.#uses.get(found.id) ?? { uses: 0, last: 0 };
    use.uses += 1;
    use.last = this.#now();
    this.#uses.set(found.id, use);
    const { saved: _saved, ...record } = found;
    return record;
  }
};

// packages/dsh-host/src/port/grant-storage.ts
var GRANTS_DOMAIN_NAME = "raw_agent_grants";
var GRANTS_DOMAIN_VERSION = 1;
var SAFE_KEY = /^[a-zA-Z0-9_-]+$/;
function duckSchema(check, what) {
  const parse = (raw) => {
    const v = check(raw);
    if (v === void 0) throw new Error(`not a ${what}`);
    return v;
  };
  return {
    parse,
    safeParse(raw) {
      try {
        return { success: true, data: parse(raw) };
      } catch (error) {
        return { success: false, error };
      }
    }
  };
}
var grantSchema = duckSchema((raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const [r] = parseGrantRecords([raw]);
  return r;
}, "grant record");
var importedSchema = duckSchema((raw) => {
  if (raw === null || typeof raw !== "object") return void 0;
  const at = raw.at;
  return typeof at === "number" && Number.isFinite(at) ? { at } : void 0;
}, "import mark");
var GRANTS_DOMAIN_SPEC = Object.freeze({
  name: GRANTS_DOMAIN_NAME,
  version: GRANTS_DOMAIN_VERSION,
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  tables: Object.freeze({
    grants: Object.freeze({ valueSchema: grantSchema }),
    imported: Object.freeze({ valueSchema: importedSchema })
  })
});
var sameRecord = (a, b) => a !== void 0 && a.id === b.id && a.label === b.label && a.hash === b.hash && a.created === b.created;
var codeOf = (e) => e !== null && typeof e === "object" ? e.code : void 0;
function domainGrantPersistence(ctx, o) {
  const warn = (note, detail) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? "");
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.openRetries ?? 20;
  const delay = o.retryDelayMs ?? 250;
  let domain;
  let settle = () => {
  };
  let settled = false;
  const ready = new Promise((resolve) => {
    settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
  });
  const importInto = async (d) => {
    const raw = o.importable?.();
    const rows = parseGrantRecords(raw);
    if (rows.length === 0) return;
    const grants = d.table("grants");
    const imported = d.table("imported");
    for (const r of rows) {
      if (imported.get(r.hash) !== void 0) continue;
      const held = [...grants.entries()].some(([, g]) => g.hash === r.hash);
      if (!held) {
        const id = SAFE_KEY.test(r.id) && grants.get(r.id) === void 0 ? r.id : `grant-${r.hash.slice(0, 16)}`;
        await grants.put(id, { ...r, id });
      }
      await imported.put(r.hash, { at: now() });
    }
  };
  const open2 = async (facility, isClosed) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await facility.open(GRANTS_DOMAIN_SPEC);
      } catch (error) {
        if (codeOf(error) === "already-open" && attempt < retries && !isClosed()) {
          await sleep(delay);
          continue;
        }
        warn("could not open DSH storage for grants; they are kept until DSH restarts", String(error));
        return void 0;
      }
    }
  };
  const start = (c) => {
    const facility = c.get("storageDomain");
    if (typeof facility?.open !== "function") {
      settle(false);
      return;
    }
    let closed = false;
    let handle;
    c.effect(() => {
      return () => {
        closed = true;
        if (domain === handle) domain = void 0;
        const h = handle;
        handle = void 0;
        if (h) void h.close().catch(() => {
        });
      };
    }, "raw-agent: grant storage");
    void (async () => {
      const d = await open2(facility, () => closed);
      if (!d) return settle(false);
      if (closed) {
        void d.close().catch(() => {
        });
        return settle(false);
      }
      handle = d;
      try {
        await importInto(d);
      } catch (error) {
        warn("could not take in the grants of the entry config", String(error));
      }
      if (closed) return settle(false);
      domain = d;
      try {
        await importInto(d);
      } catch {
      }
      settle(true);
    })().catch((error) => {
      warn("grant storage failed to start", String(error));
      settle(false);
    });
  };
  try {
    if (ctx.inject) ctx.inject(["storageDomain"], start);
    else start(ctx);
  } catch (error) {
    warn("could not wait for DSH storage; grants are kept until DSH restarts", String(error));
    settle(false);
  }
  return {
    ready,
    async importConfig() {
      if (domain) await importInto(domain);
    },
    load() {
      if (!domain) return o.fallback.load();
      return [...domain.table("grants").entries()].map(([, g]) => g);
    },
    durable() {
      if (domain) return true;
      return o.fallback.durable?.() !== false;
    },
    async save(records) {
      const d = domain;
      if (!d) return o.fallback.save(records);
      const grants = d.table("grants");
      const keep2 = new Set(records.map((r) => r.id));
      for (const r of records) {
        if (!SAFE_KEY.test(r.id)) return false;
        if (!sameRecord(grants.get(r.id), r)) await grants.put(r.id, { ...r });
      }
      const drop = [...grants.keys()].filter((k) => !keep2.has(k));
      if (drop.length > 0) await grants.deleteMany(drop);
      return true;
    }
  };
}

// packages/dsh-host/src/plugin-service.ts
var fail2 = (code, message) => new RawAgentServiceError(code, message);
function publicView(runtime) {
  return runtime.view();
}
function backendInfos(factories) {
  return factories.map((f) => ({ kind: f.kind, displayName: f.displayName }));
}
function createRawAgentService(deps) {
  const { registry, factories, grants } = deps;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const backends = backendInfos(factories);
  registry.setPluginGrantCheck((grantId) => grants.active(grantId));
  const backendOf = (sessionId) => {
    const kind = registry.kindOf(sessionId);
    return backends.find((b) => b.kind === kind);
  };
  const ours = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") throw fail2("not-our-session", "missing session id");
    const runtime = registry.get(sessionId);
    const backend = backendOf(sessionId);
    if (!runtime || !backend) throw fail2("not-our-session", "not a session of this plugin");
    return { runtime, backend, id: sessionId };
  };
  const granted = (grant) => {
    if (grant === void 0 || grant === null || grant === "")
      throw fail2("no-grant", "This call needs a grant token. The user creates one in the plugin access panel.");
    const record = grants.check(grant);
    if (!record) throw fail2("bad-grant", "The grant token is not valid (wrong, or revoked by the user).");
    return record;
  };
  const checkText = (text, max) => {
    if (typeof text !== "string") throw fail2("empty", "the text must be a string");
    if (text.trim() === "") throw fail2("empty", "the text is empty");
    if (text.length > max) throw fail2("too-long", `the text is longer than ${max} characters`);
    return text;
  };
  const deliver = (mode, sessionId, text, grant) => {
    const { id } = ours(sessionId);
    const body = checkText(text, PLUGIN_TEXT_MAX);
    const record = granted(grant);
    const agent = deps.agent(id);
    if (!agent) throw fail2("not-our-session", "the session is not open in DSH");
    const message = {
      id: newId(),
      role: "user",
      content: [{ type: "text", text: body }],
      source: { kind: PLUGIN_SOURCE_KIND, grant: record.label, grantId: record.id }
    };
    registry.admitPluginMessage(message.id, { grantId: record.id, label: record.label });
    try {
      if (mode === "send") agent.followup(message);
      else agent.steer(message);
    } catch (error) {
      registry.forgetPluginMessage(message.id);
      throw fail2("failed", `DSH refused the message: ${String(error?.message ?? error)}`);
    }
    return { messageId: message.id };
  };
  const service = {
    apiVersion: RAW_AGENT_API_VERSION,
    backends,
    async sessionInfo(sessionId) {
      const runtime = typeof sessionId === "string" ? registry.get(sessionId) : void 0;
      const backend = typeof sessionId === "string" ? backendOf(sessionId) : void 0;
      if (!runtime || !backend) return void 0;
      return sessionInfoFromView(sessionId, backend, publicView(runtime));
    },
    async interrupt(sessionId) {
      const { id } = ours(sessionId);
      const agent = deps.agent(id);
      if (!agent) throw fail2("not-our-session", "the session is not open in DSH");
      try {
        agent.cancel();
      } catch (error) {
        throw fail2("failed", `DSH refused the stop: ${String(error?.message ?? error)}`);
      }
    },
    onEvent(sessionId, listener) {
      let stopped = false;
      let offRuntime;
      let offAdded;
      let tracker;
      const emit = (events) => {
        for (const e of events) {
          if (stopped) return;
          try {
            listener(e);
          } catch (error) {
            deps.warn?.("a plugin event listener failed", String(error));
          }
        }
      };
      const attach = () => {
        const runtime = registry.get(sessionId);
        const backend = backendOf(sessionId);
        if (!runtime || !backend || stopped) return false;
        tracker ??= new PublicEventTracker(sessionId, backend);
        const t = tracker;
        emit(t.update(publicView(runtime)));
        offRuntime = runtime.subscribe(
          (view) => emit(t.update(view)),
          () => {
            offRuntime?.();
            offRuntime = void 0;
            if (registry.get(sessionId) && registry.get(sessionId) !== runtime) {
              attach();
              return;
            }
            emit(t.end());
            stop();
          }
        );
        return true;
      };
      const stop = () => {
        stopped = true;
        offRuntime?.();
        offAdded?.();
        offRuntime = void 0;
        offAdded = void 0;
      };
      if (typeof sessionId !== "string" || sessionId === "") return () => {
      };
      if (!attach())
        offAdded = registry.onRuntime((id) => {
          if (id !== sessionId || offRuntime) return;
          if (attach()) {
            offAdded?.();
            offAdded = void 0;
          }
        });
      return stop;
    },
    send: async (sessionId, text, grant) => deliver("send", sessionId, text, grant),
    steer: async (sessionId, text, grant) => deliver("steer", sessionId, text, grant),
    async askSideQuestion(sessionId, question, grant) {
      const { runtime } = ours(sessionId);
      const q = checkText(question, SIDE_QUESTION_MAX);
      granted(grant);
      if (typeof runtime.askSideQuestion !== "function")
        throw fail2("unsupported", "this session cannot answer side questions");
      if (runtime.state().process !== "running")
        throw fail2("not-running", "the agent is not running; the user must start it first");
      const r = await runtime.askSideQuestion(q);
      if (!r.ok) throw fail2(r.code === "busy" ? "busy" : r.code === "unsupported" ? "unsupported" : "failed", r.error);
      const entry = r.entry;
      if (entry.status === "failed") throw fail2("failed", entry.error ?? "the side question failed");
      if (entry.status !== "answered" || entry.synthetic) return null;
      return entry.answer ?? null;
    }
  };
  return Object.freeze(service);
}

// packages/dsh-host/src/port/services.ts
var PLUGIN_SESSION_INFO_ROUTE = "/api/raw-agent/plugin/session-info";
var PLUGIN_INTERRUPT_ROUTE = "/api/raw-agent/plugin/interrupt";
var PLUGIN_SEND_ROUTE = "/api/raw-agent/plugin/send";
var PLUGIN_SIDE_QUESTION_ROUTE = "/api/raw-agent/plugin/side-question";
var GRANTS_ROUTE = "/api/raw-agent/grants";
var GRANT_CREATE_ROUTE = "/api/raw-agent/grants/create";
var GRANT_REVOKE_ROUTE = "/api/raw-agent/grants/revoke";
var MAX_BODY = 512 * 1024;
var json2 = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function statusOf3(code) {
  switch (code) {
    case "not-our-session":
      return 404;
    case "no-grant":
    case "bad-grant":
      return 403;
    case "empty":
    case "too-long":
      return 400;
    case "not-running":
    case "busy":
    case "unsupported":
      return 409;
    default:
      return 502;
  }
}
function agentOps(ctx, sessionId) {
  let agent;
  try {
    agent = ctx.get("agents")?.get?.(sessionId);
  } catch {
    return void 0;
  }
  if (!agent || typeof agent.followup !== "function") return void 0;
  const a = agent;
  return {
    followup: (m) => a.followup(m),
    steer: (m) => {
      if (typeof a.steer === "function") a.steer(m);
      else if (typeof a.send === "function") a.send(m, "next-step", true);
      else a.followup(m);
    },
    cancel: () => {
      if (typeof a.cancel !== "function") throw new Error("this DSH agent has no cancel");
      a.cancel({ kind: "user" }, { keepInbox: true });
    }
  };
}
function pluginRoutes(service, grants) {
  const handle = (fn) => async (request) => {
    let body;
    try {
      body = await readJson2(request, MAX_BODY);
    } catch {
      return json2(400, { error: "the body must be a JSON object" });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return json2(400, { error: "the body must be a JSON object" });
    try {
      const r = await fn(body);
      return json2(r.status, r.body);
    } catch (e) {
      if (isRawAgentServiceError(e)) return json2(statusOf3(e.code), { error: e.message, code: e.code });
      return json2(500, { error: String(e?.message ?? e) });
    }
  };
  const session = (b) => typeof b.session === "string" ? b.session : "";
  const route = (path9, fn) => ({
    path: path9,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: handle(fn)
  });
  return [
    route(PLUGIN_SESSION_INFO_ROUTE, async (b) => {
      const info = await service.sessionInfo(session(b));
      return info ? { status: 200, body: info } : { status: 404, body: { error: "not a session of this plugin", code: "not-our-session" } };
    }),
    route(PLUGIN_INTERRUPT_ROUTE, async (b) => {
      await service.interrupt(session(b));
      return { status: 200, body: { ok: true } };
    }),
    route(PLUGIN_SEND_ROUTE, async (b) => {
      const call = b.mode === "steer" ? service.steer : service.send;
      const r = await call(session(b), b.text, b.grant);
      return { status: 200, body: { ok: true, ...r } };
    }),
    route(PLUGIN_SIDE_QUESTION_ROUTE, async (b) => {
      const answer = await service.askSideQuestion(session(b), b.question, b.grant);
      return { status: 200, body: { ok: true, answer } };
    }),
    // The grant panel. Any page script with the DSH cookie can call these too: the grant is a
    // consent switch between trusted plugins, not a security boundary (D66).
    route(GRANTS_ROUTE, async () => ({ status: 200, body: { grants: grants.list() } })),
    route(GRANT_CREATE_ROUTE, async (b) => {
      const r = await grants.create(b.label);
      return r.ok ? { status: 200, body: { ok: true, grant: r.grant, token: r.token, grants: grants.list() } } : { status: 400, body: { ok: false, error: r.error } };
    }),
    route(GRANT_REVOKE_ROUTE, async (b) => {
      const id = typeof b.id === "string" ? b.id : "";
      const r = await grants.revoke(id);
      return r.ok ? { status: 200, body: { ok: true, saved: r.saved, grants: grants.list() } } : { status: 404, body: { ok: false, error: "no such grant" } };
    })
  ];
}
var RUNTIME_CONFIG_FIELDS = ["grants", "executablePath", "options"];
var withoutRuntimeFields = (c) => {
  if (c === null || typeof c !== "object") return JSON.stringify(c ?? null);
  const src = c;
  const rest = {};
  for (const k of Object.keys(src).sort())
    if (!RUNTIME_CONFIG_FIELDS.includes(k) && src[k] !== void 0) rest[k] = src[k];
  return JSON.stringify(rest);
};
function onlyRuntimeFieldsChanged(before, after) {
  return withoutRuntimeFields(before) === withoutRuntimeFields(after);
}
function configGrantPersistence(ctx, config, onChange) {
  try {
    ctx.on("internal/update", ((resolved, next) => {
      if (resolved !== null && typeof resolved === "object" && onlyRuntimeFieldsChanged(config.get() ?? {}, resolved)) {
        config.set(resolved);
        onChange?.();
        return void 0;
      }
      return next();
    }));
  } catch (error) {
    ctx.logger?.warn("[raw-agent] could not watch config updates; grants stay in memory", String(error));
  }
  return {
    load: () => config.get()?.grants,
    // M8 live (DSH 0.2.2-rc.1): `fiber.update` reaches the loader, but a row inserted by a bundle
    // layer is changed in the composed tree only; the profile files are not written, so the grants
    // are gone after a DSH restart. Say so instead of claiming they are saved.
    durable: () => false,
    async save(records) {
      const fiber = ctx.fiber;
      if (typeof fiber?.update !== "function") return false;
      const next = { ...config.get() ?? {}, grants: records.map((r) => ({ ...r })) };
      await fiber.update(next);
      const stored = config.get()?.grants;
      return Array.isArray(stored) && stored.length === records.length;
    }
  };
}
var NO_PERSISTENCE = { load: () => void 0, save: async () => false, durable: () => false };
function grantPersistence(ctx, hostConfig) {
  const takeIn = () => void durable.importConfig().catch((e) => ctx.logger?.warn("[raw-agent] could not take in config grants", String(e)));
  const fallback = hostConfig ? configGrantPersistence(ctx, hostConfig, takeIn) : NO_PERSISTENCE;
  const durable = domainGrantPersistence(ctx, {
    fallback,
    ...hostConfig ? { importable: () => hostConfig.get()?.grants } : {}
  });
  return durable;
}
function mountServices(ctx, o) {
  const warn = (note, detail) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? "");
  const grants = o.grants ?? new GrantStore({ persistence: grantPersistence(ctx, o.hostConfig) });
  const service = createRawAgentService({
    registry: o.registry,
    factories: o.factories,
    grants,
    agent: (id) => agentOps(ctx, id),
    warn
  });
  try {
    ctx.provide?.(RAW_AGENT_SERVICE, service);
  } catch (error) {
    warn("could not provide the rawAgent service", String(error));
  }
  const register = (c) => {
    const connection = c.get("connection");
    if (!connection?.fetch) return;
    for (const r of pluginRoutes(service, grants)) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(["connection"], register);
  else register(ctx);
  return { service, grants };
}

// packages/dsh-host/src/port/index.ts
var TESTED_DSH_VERSIONS = Object.freeze(["0.2.2-rc.1"]);

// packages/dsh-host/src/user-config.ts
function current(v) {
  if (v !== null && typeof v === "object" && typeof v.get === "function")
    return v.get();
  return v;
}
function readUserConfig(raw) {
  const out = { options: {} };
  if (!raw) return out;
  const path9 = current(raw.executablePath);
  if (typeof path9 === "string" && path9.trim() !== "") out.executablePath = path9;
  const opts = current(raw.options);
  if (opts !== null && typeof opts === "object" && !Array.isArray(opts)) {
    const o = {};
    for (const [k, v] of Object.entries(opts)) o[k] = current(v);
    out.options = o;
  }
  return out;
}

// packages/dsh-host/src/index.ts
function createRawAgentHost(options) {
  const kinds = /* @__PURE__ */ new Set();
  for (const f of options.factories) {
    if (kinds.has(f.kind)) throw new Error(`Duplicate backend kind: ${f.kind}`);
    kinds.add(f.kind);
  }
  const minutes = options.idleReapMinutes;
  const registryOpts = {};
  if (minutes) registryOpts.idleReapMs = () => Math.max(0, Number(minutes() ?? 0)) * 6e4;
  if (options.userConfig) registryOpts.userConfig = options.userConfig;
  const sessions = new SessionRegistry(registryOpts);
  let services;
  return {
    factories: options.factories,
    sessions,
    get services() {
      return services;
    },
    apply(ctx) {
      mountHost(ctx, options.factories, options.seedModels ?? []);
      mountConfigRoutes(ctx, options.factories);
      try {
        ctx.provide?.(SESSIONS_SERVICE, sessions);
      } catch (error) {
        ctx.logger?.warn("[raw-agent] could not provide the session registry", String(error));
      }
      mountLifecycleRoutes(ctx, sessions, { factories: options.factories, seedModels: options.seedModels ?? [] });
      try {
        services = mountServices(ctx, {
          registry: sessions,
          factories: options.factories,
          ...options.hostConfig ? { hostConfig: options.hostConfig } : {}
        });
      } catch (error) {
        ctx.logger?.warn("[raw-agent] could not mount the plugin services", String(error));
      }
      ctx.effect(() => {
        const stop = sessions.startReaper();
        return () => {
          stop();
          void sessions.disposeAll();
        };
      }, "raw-agent: session registry");
    },
    applyAgent(ctx, config, extra) {
      const kind = config?.backend ?? options.factories[0]?.kind;
      const factory = options.factories.find((f) => f.kind === kind);
      if (!factory) throw new Error(`Unknown backend kind: ${String(kind)}`);
      const llm = ctx.get("llm");
      const mountOpts = { factory, selectSettingsModel: typeof llm?.registerAdapter === "function" };
      if (options.userConfig) mountOpts.userConfig = options.userConfig;
      return mountAgent(ctx, { ...mountOpts, ...extra });
    }
  };
}

// packages/plugin/src/host.ts
var name = "dsh-raw-agent";
var seedModels = (process.env.DSH_RAW_AGENT_TEST_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
var testJobWait = Number(process.env.DSH_RAW_AGENT_TEST_JOB_WAIT_MS ?? "");
if (testJobWait > 0) setJobWaitForTests(testJobWait);
var entryConfig;
var host = createRawAgentHost({
  factories: [createClaudeFactory()],
  seedModels,
  userConfig: () => readUserConfig(entryConfig),
  // R9.2, D66: plugin grants live in this entry's `grants` field; a grant-only change applies in
  // place (no restart), see dsh-host port/services.ts.
  hostConfig: {
    get: () => entryConfig,
    set: (next) => {
      entryConfig = next;
    }
  }
});
function apply(ctx, config) {
  entryConfig = config;
  host.apply(ctx);
}
export {
  apply,
  name
};
//# sourceMappingURL=host.js.map
