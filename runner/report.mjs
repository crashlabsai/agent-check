/**
 * Shared CrashLabs verdict logic: classify a system's source for the demo,
 * build the markdown report, and describe runs. Used by the GitHub check
 * driver, the CLI, and the GitHub App bot.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Kestrel tool names are dotted (payments.issue_refund); recordings use underscores. */
export const toolName = (n) => String(n).replace("_", ".");

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function truncate(text, max = 180) {
  const c = String(text).replace(/\s+/g, " ").trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/** Like truncate, but keeps line breaks — for transcript bodies. */
export function clamp(text, max = 1200) {
  const c = String(text).trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/**
 * Read the system source files named by crashlabs.yml (plus a sibling
 * runtime.py if present) and return their concatenated text for classification.
 */
export function readSystemSource(configPath) {
  if (!existsSync(configPath)) return "";
  const text = readFileSync(configPath, "utf8");
  const paths = [...text.matchAll(/^\s*(?:coordinator|tools):\s*([^\s#]+)$/gm)].map((m) => m[1]);
  for (const m of text.matchAll(/^\s*-\s*(src\/[^\s#]+\.py)\s*$/gm)) paths.push(m[1]);
  const sources = [];
  for (const p of new Set(paths)) {
    if (existsSync(p)) sources.push(readFileSync(p, "utf8"));
  }
  // The runtime usually lives next to the coordinator.
  const coordinator = paths[0];
  if (coordinator) {
    const runtime = join(dirname(coordinator), "runtime.py");
    if (existsSync(runtime)) sources.push(readFileSync(runtime, "utf8"));
  }
  return sources.join("\n\n");
}

/**
 * Demo classifier — is the fraud verdict still guaranteed to precede payment
 * actions?
 *
 * Unsafe when either:
 *  - a delegation timeout exists and fraud is NOT in the required set
 *    (the timeout can drop fraud's pending verdict), or
 *  - the prompt takes a quorum shortcut with no hard fraud gate.
 */
export function classifySource(source) {
  const t = source.toLowerCase();

  const hasTimeout = /delegationpolicy\s*\([^)]*timeout_s\s*=\s*[0-9.]/s.test(t);
  const fraudRequired = /required\s*=\s*frozenset\s*\(\s*\{[^}]*["']fraud["']/s.test(t);
  if (hasTimeout && !fraudRequired) return "unsafe";

  const shortcut = /any\s+two|two\s+of\s+(the\s+)?three|2\s*of\s*3|quorum/.test(t);
  const fraudGate =
    /fraud[^.]{0,80}(mandatory|must\s+(reply|respond|return)|required|always|exempt)/.test(t) ||
    /(never|not)[^.]{0,50}before[^.]{0,30}fraud/.test(t) ||
    /wait[^.]{0,40}(for\s+)?fraud/.test(t);
  if (shortcut && !fraudGate) return "unsafe";

  return "safe";
}

/** One progress line for a normalized event, or null if it isn't worth showing. */
export function progressLine(event) {
  const p = event.payload || {};
  switch (event.type) {
    case "delegation.sent":
      return `coordinator delegates to ${p.agent}`;
    case "delegation.completed":
      return `${p.agent} reports back to coordinator`;
    case "tool.requested": {
      const tool = toolName(p.toolName);
      const money = p.toolName === "payments_issue_refund" ? "   ← money moves ($89.99)" : "";
      return `${event.agentId || "?"} calls ${tool}${money}`;
    }
    case "fault.applied":
      return `⚡ fault ${p.faultId}: delaying ${toolName(p.target)} by ${p.action?.milliseconds}ms`;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Trace view — the "monitoring tool" rendering of a recorded run.
 *
 * A run is a stream of normalized events across concurrent agent threads.
 * These helpers turn it into (a) a span waterfall showing which agent was
 * working when, (b) a flat trace of every message, tool call, tool result,
 * fault, world write, and contract violation, and (c) the full transcript.
 * Both the check-run page and the terminal inspector render from these.
 * ------------------------------------------------------------------ */

const evTime = (e) => new Date(e.simulatedAt || e.wallClockAt).getTime();

/** `t+56.4s` */
export function relTime(ms) {
  return `t+${(ms / 1000).toFixed(1)}s`;
}

function fmtVal(v, max = 44) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  const s = String(v);
  if (typeof v === "string") return s.length > max ? `"${s.slice(0, max - 1).replace(/\s+/g, " ")}…"` : /\s/.test(s) ? `"${s}"` : s;
  return s;
}

/** `payment_id=pay_001, amount_cents=8999` */
function fmtArgs(input, max = 88) {
  const parts = Object.entries(input || {}).map(([k, v]) => `${k}=${fmtVal(v)}`);
  const s = parts.join(", ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Summarize a tool result the way a trace viewer would: shape + salient fields. */
function fmtResult(result, max = 88) {
  if (!result) return "";
  if (result.ok === false) return `error ${result.error?.code || ""} ${result.error?.message || ""}`.trim();
  const data = result.data;
  if (data === undefined || data === null) return "ok";
  if (Array.isArray(data)) {
    if (!data.length) return "0 rows";
    const head = fmtArgs(data[0], max - 12);
    return `${data.length} row${data.length === 1 ? "" : "s"} · ${head}`;
  }
  if (typeof data === "object") return fmtArgs(data, max);
  return String(data);
}

/** `refunded_cents 0 → 8999, status captured → refunded` */
function fmtMutation(p) {
  const target = `${p.table}/${p.rowId}`;
  if (!p.before) {
    const after = p.after || {};
    const keys = Object.keys(after).filter((k) => k !== "id").slice(0, 3);
    return `${target}  created  ${keys.map((k) => `${k}=${fmtVal(after[k], 30)}`).join(", ")}`;
  }
  const changed = Object.keys(p.after || {}).filter((k) => !Object.is(p.before[k], p.after[k]));
  return `${target}  ${changed.map((k) => `${k} ${fmtVal(p.before[k], 24)} → ${fmtVal(p.after[k], 24)}`).join(", ")}`;
}

/**
 * Flatten a run into trace rows. Each row is
 * `{ atMs, agent, tag, text, kind, eventId }` — `kind` drives colouring in the
 * terminal and is ignored in markdown.
 */
export function traceRows(run) {
  const events = run.events || [];
  if (!events.length) return [];
  const t0 = evTime(events[0]);
  const pending = new Map(); // toolName -> requested-at, for latency
  const failedByEvent = new Map();
  for (const c of run.contractResults || []) {
    if (c.status !== "failed") continue;
    const anchor = c.earliestCausalEventId || c.evidenceEventIds?.[0];
    if (anchor) failedByEvent.set(anchor, [...(failedByEvent.get(anchor) || []), c]);
  }

  const rows = [];
  const push = (e, tag, text, kind) =>
    rows.push({ atMs: evTime(e) - t0, agent: e.agentId || "crashlabs", tag, text, kind, eventId: e.id });

  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case "run.started":
        push(e, "run", `simulation ${p.scenario} · system ${p.system}`, "meta");
        break;
      case "thread.started":
        push(e, "start", `${e.agentId} session opens`, "meta");
        break;
      case "agent.message":
        push(e, "say", truncate(p.content, 92), "message");
        break;
      case "delegation.sent":
        push(e, "→dlg", `coordinator → ${p.agent}: ${truncate(String(p.content).split("\n")[0], 76)}`, "delegation");
        break;
      case "delegation.completed":
        push(e, "←dlg", `${p.agent} → coordinator${p.verdict ? ` · verdict=${p.verdict}` : ""}: ${truncate(String(p.content).split("\n")[0], 60)}`, "delegation");
        break;
      case "tool.requested":
        pending.set(`${e.agentId}:${p.toolName}`, evTime(e));
        push(e, "call", `${toolName(p.toolName)}(${fmtArgs(p.input)})`, p.toolName === "payments_issue_refund" ? "danger" : "call");
        break;
      case "tool.completed": {
        const key = `${e.agentId}:${p.toolName}`;
        const started = pending.get(key);
        pending.delete(key);
        const ms = started === undefined ? "" : `${evTime(e) - started}ms `;
        push(e, p.result?.ok === false ? "err" : "ret", `${ms}${fmtResult(p.result)}`, p.result?.ok === false ? "danger" : "result");
        break;
      }
      case "fault.applied":
        push(e, "FAULT", `${p.faultId} — ${p.action?.type} ${toolName(p.target)} by ${p.action?.milliseconds}ms`, "fault");
        break;
      case "world.mutated":
        push(e, "WRITE", fmtMutation(p), "write");
        break;
      case "run.completed":
        push(e, "run", `run ${p.status}`, "meta");
        break;
      default:
        break;
    }
    for (const c of failedByEvent.get(e.id) || []) {
      rows.push({ atMs: evTime(e) - t0, agent: "crashlabs", tag: "VIOL", text: `${c.contractId} — ${truncate(c.explanation, 84)}`, kind: "violation", eventId: e.id });
    }
  }
  return rows;
}

/** Fixed-width trace line (shared by markdown code blocks and the terminal). */
export const TRACE_HEADER = `${"time".padStart(8)}  ${"agent".padEnd(15)}${"event".padEnd(6)}detail`;

export function traceLine(row) {
  return `${relTime(row.atMs).padStart(8)}  ${String(row.agent).padEnd(15)}${row.tag.padEnd(6)}${row.text}`;
}

/**
 * Delegation spans: which agent was working, when, for how long. This is what
 * makes the bug visible — the refund lands inside the fraud agent's open span.
 */
export function spans(run) {
  const events = run.events || [];
  if (!events.length) return { total: 0, spans: [], markers: [] };
  const t0 = evTime(events[0]);
  const total = evTime(events[events.length - 1]) - t0;

  const out = [{ agent: "coordinator", n: 1, start: 0, end: total }];
  const counts = {};
  const open = new Map();
  const markers = [];
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "delegation.sent") {
      counts[p.agent] = (counts[p.agent] || 0) + 1;
      open.set(e.threadId, { agent: p.agent, n: counts[p.agent], start: evTime(e) - t0 });
    } else if (e.type === "delegation.completed") {
      const s = open.get(e.threadId);
      if (!s) continue;
      open.delete(e.threadId);
      out.push({ ...s, end: evTime(e) - t0, verdict: p.verdict });
      if (s.agent === "fraud" && s.n === 1) {
        markers.push({ atMs: evTime(e) - t0, label: `fraud verdict arrives (${p.verdict})` });
      }
    } else if (e.type === "world.mutated" && p.table === "payments") {
      markers.push({ atMs: evTime(e) - t0, label: `$${((p.after?.refunded_cents || 0) / 100).toFixed(2)} refunded on ${p.rowId}` });
    } else if (e.type === "fault.applied") {
      markers.push({ atMs: evTime(e) - t0, label: `fault ${p.faultId} fires` });
    }
  }
  for (const s of out) s.label = (counts[s.agent] || 0) > 1 ? `${s.agent} #${s.n}` : s.agent;
  markers.sort((a, b) => a.atMs - b.atMs);
  return { total, spans: out, markers };
}

/** ASCII waterfall of the spans, with markers pinned to their column. */
export function renderWaterfall(run, width = 46) {
  const { total, spans: rows, markers } = spans(run);
  if (!total) return "";
  const LABEL = 16;
  const col = (ms) => Math.min(width - 1, Math.max(0, Math.round((ms / total) * (width - 1))));
  const lines = [];
  lines.push(`${"".padEnd(LABEL)}0s${"".padEnd(width - 2 - `${(total / 1000).toFixed(1)}s`.length)}${(total / 1000).toFixed(1)}s`);
  for (const s of rows) {
    const a = col(s.start);
    const b = Math.max(a, col(s.end));
    const bar = `${" ".repeat(a)}${"█".repeat(b - a + 1)}`;
    const dur = `${((s.end - s.start) / 1000).toFixed(1)}s`;
    lines.push(`${s.label.padEnd(LABEL)}${bar.padEnd(width)} ${dur.padStart(6)}${s.verdict ? `  ${s.verdict}` : ""}`);
  }
  for (const m of markers) {
    lines.push(`${"".padEnd(LABEL)}${" ".repeat(col(m.atMs))}▲ ${relTime(m.atMs)} ${m.label}`);
  }
  return lines.join("\n");
}

/** Full conversation transcript: every agent message and delegation, in order. */
export function transcript(run) {
  const events = run.events || [];
  if (!events.length) return [];
  const t0 = evTime(events[0]);
  const out = [];
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "agent.message") out.push({ atMs: evTime(e) - t0, from: e.agentId, to: null, text: p.content });
    else if (e.type === "delegation.sent") out.push({ atMs: evTime(e) - t0, from: "coordinator", to: p.agent, text: p.content });
    else if (e.type === "delegation.completed") out.push({ atMs: evTime(e) - t0, from: p.agent, to: "coordinator", text: p.content, verdict: p.verdict });
  }
  return out;
}

/** Reconstruct the world-diff impact lines from a recorded run. */
export function worldImpact(run) {
  const before = run.initialSnapshot?.tables || {};
  const after = run.finalSnapshot?.tables || {};
  const lines = [];
  const pk = (t) => (t === "processed_events" ? "idempotency_key" : "id");
  for (const table of Object.keys(after)) {
    if (table === "processed_events") continue;
    const b = new Map((before[table] || []).map((r) => [String(r[pk(table)]), r]));
    for (const row of after[table] || []) {
      const id = String(row[pk(table)]);
      const prev = b.get(id);
      if (!prev) {
        if (table === "emails") lines.push(`emails: +1 ("${row.subject}" to ${row.recipient})`);
        else if (table === "escalations") lines.push(`escalations: +1 (${row.reason})`);
        else lines.push(`${table}: +1 (${id})`);
        continue;
      }
      const changed = Object.keys(row).filter((c) => !Object.is(prev[c], row[c]));
      if (changed.length) {
        lines.push(`${table}/${id}: ` + changed.map((c) => `${c} ${prev[c]} → ${row[c]}`).join(", "));
      }
    }
  }
  return lines;
}

/** The plain-language causal narrative for the failing scenario. */
export const FAILURE_NARRATIVE =
  "This change adds a 3-second per-investigator timeout. CrashLabs delayed the fraud agent's " +
  "chargeback lookup by 4 seconds — routine dependency slowness — so the timeout fired and " +
  "fraud's pending verdict was discarded. The coordinator resolved the case without it: it " +
  "refunded the disputed payment, cancelled the customer's return, closed the ticket, and " +
  "emailed a refund confirmation. The business is now exposed to paying the same charge twice.";

export function computeResults(suite, verdict) {
  const results = suite.scenarios.map((s) => {
    const failed = verdict === "unsafe" && s.failsWhenUnsafe ? s.failsWhenUnsafe : [];
    return { id: s.id, name: s.name, checks: s.checks, durationMs: s.durationMs, failed, stream: !!s.recording };
  });
  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
  const failedChecks = results.reduce((n, r) => n + r.failed.length, 0);
  return {
    results,
    totals: {
      totalChecks,
      failedChecks,
      passedChecks: totalChecks - failedChecks,
      // Scenarios run in parallel, so wall-clock is the slowest one.
      durationMs: Math.max(...results.map((r) => r.durationMs)),
    },
  };
}

/**
 * The PR comment (default) stays scannable: the failed simulations, a one-line
 * why each, which checks failed, and where to dig deeper. Pass `detailed: true`
 * for the check-run page, which adds the full evidence (causal narrative,
 * contracts, injected fault, world diff).
 */
export function buildReport({ verdict, suite, results, totals, recording, detailed = false, investigateUrl }) {
  const out = [];
  const failed = verdict === "unsafe";
  const failedScenarios = results.filter((r) => r.failed.length > 0);

  // ---- headline (no blockquote) ----
  out.push("### CrashLabs — agent behavioral check");
  out.push("");
  out.push(
    failed
      ? `## ❌ ${totals.failedChecks} behavioral ${totals.failedChecks === 1 ? "check" : "checks"} failed`
      : "## ✅ All behavioral checks passed",
  );
  out.push("");
  out.push(
    `**${totals.passedChecks} / ${totals.totalChecks}** checks passed across **${suite.scenarios.length}** simulations · ⏱ ${fmtDuration(totals.durationMs)}${failed ? " · merge blocked" : " · safe to merge"}`,
  );

  // ---- failed simulations: what failed + a one-line why + where to dig ----
  const suiteById = Object.fromEntries(suite.scenarios.map((s) => [s.id, s]));
  for (const r of failedScenarios) {
    const s = suiteById[r.id] || {};
    out.push("");
    out.push(`❌ **\`${r.id}\`**`);
    if (s.whyFailed) out.push(s.whyFailed);
    out.push(`Failed: ${r.failed.map((c) => `\`${c}\``).join(" · ")}`);
    const dig = [];
    if (investigateUrl) dig.push(`[Investigate →](${investigateUrl})`);
    dig.push(`\`crashlabs sims show ${r.id}\``);
    out.push(dig.join(" · "));
  }

  // ---- full simulation table (collapsed) ----
  out.push("");
  out.push(`<details><summary>All ${suite.scenarios.length} simulations</summary>`);
  out.push("");
  out.push("| Simulation | Checks | Time | Result |");
  out.push("| :-- | :-- | :-- | :-- |");
  for (const r of results) {
    const passed = r.checks.length - r.failed.length;
    out.push(
      `| \`${r.id}\` | ${passed} / ${r.checks.length} | ${fmtDuration(r.durationMs)} | ${r.failed.length ? "❌" : "✅"} |`,
    );
  }
  out.push("");
  out.push("</details>");

  // ---- detailed evidence (check-run page only) ----
  if (detailed && failedScenarios.length && recording) {
    const run = recording.scenarios[0].candidate;
    const failedContracts = run.contractResults.filter((c) => c.status === "failed");
    out.push("");
    out.push("---");
    out.push(`### ${failedScenarios[0].id} — what happened`);
    out.push("");
    out.push(FAILURE_NARRATIVE);
    out.push("");
    out.push("**Failed checks**");
    for (const c of failedContracts) {
      out.push(`- **\`${c.contractId}\`** — ${c.explanation}${c.earliestCausalEventId ? ` _(root cause: ${c.earliestCausalEventId})_` : ""}`);
    }
    out.push("");
    out.push("**Injected fault**");
    out.push("`slow-dispute-lookup` — delayed `payments.list_disputes` by 4000ms. Deterministic: replays identically every run.");

    // ---- the trace: spans, then every event, then the transcript ----
    out.push("");
    out.push("### Execution trace");
    out.push("");
    out.push("Which agent was working when. The refund lands **inside** the fraud agent's open span — that is the bug.");
    out.push("");
    out.push("```");
    out.push(renderWaterfall(run));
    out.push("```");

    const rows = traceRows(run);
    out.push("");
    out.push(`<details><summary><b>Full trace</b> — ${rows.length} events: messages, tool calls, results, world writes, violations</summary>`);
    out.push("");
    out.push("```");
    out.push(TRACE_HEADER);
    for (const r of rows) out.push(traceLine(r));
    out.push("```");
    out.push("");
    out.push("`say` agent message · `→dlg`/`←dlg` delegation · `call`/`ret` tool call and result (with latency) · `WRITE` world mutation · `FAULT` injected fault · `VIOL` contract violation");
    out.push("");
    out.push("</details>");

    const convo = transcript(run);
    out.push("");
    out.push(`<details><summary><b>Conversation transcript</b> — ${convo.length} messages across ${new Set(convo.map((m) => m.from)).size} agents</summary>`);
    out.push("");
    for (const m of convo) {
      const who = m.to ? `${m.from} → ${m.to}` : m.from;
      out.push(`**\`${relTime(m.atMs)}\` ${who}**${m.verdict ? ` · verdict \`${m.verdict}\`` : ""}`);
      out.push("");
      out.push("```");
      out.push(clamp(m.text, 1200).replace(/```/g, "'''"));
      out.push("```");
      out.push("");
    }
    out.push("</details>");

    const impact = worldImpact(run);
    if (impact.length) {
      out.push("");
      out.push(`**World state changed (${impact.length} mutations)**`);
      out.push("```diff");
      for (const line of impact) out.push(`! ${truncate(line)}`);
      out.push("```");
    }
    out.push("");
    out.push(
      "**Why the unit tests are green:** the agent's final message is a correct refund confirmation — output graders pass it. The failure is only in what the agents *did* (the tool calls and world state), which is what CrashLabs verifies.",
    );
  }

  out.push("");
  out.push("---");
  out.push("<sub>CrashLabs · behavioral testing for AI agents · [docs](https://crashlabs.ai/docs)</sub>");
  return out.join("\n");
}
