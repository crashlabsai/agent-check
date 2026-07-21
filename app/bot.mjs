#!/usr/bin/env node
/**
 * CrashLabs GitHub App bot.
 *
 * Posts a CrashLabs Check Run + PR comment authored by the app (so it shows as
 * "CrashLabs", with the CrashLabs logo — like Greptile / Devin), instead of
 * github-actions[bot]. Reads the PR's agent source from GitHub, classifies it,
 * and renders the same suite report the CLI uses.
 *
 *   node app/bot.mjs --repo crashlabsai/kestrel-support --pr 1
 *
 * Env (see app/.env.example):
 *   CRASHLABS_APP_ID          the GitHub App's App ID
 *   CRASHLABS_APP_KEY         path to the app's private-key .pem
 *   CRASHLABS_INSTALLATION_ID optional; auto-discovered from the repo if unset
 */
import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, classifySource, computeResults, progressLine } from "../runner/report.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API = "https://api.github.com";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function loadEnv() {
  const p = join(ROOT, "app", ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem);
  return `${header}.${payload}.${b64url(sig)}`;
}
async function gh(token, path, init = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "crashlabs-app",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  loadEnv();
  const repo = arg("--repo");
  const pr = arg("--pr");
  const appId = process.env.CRASHLABS_APP_ID;
  const keyPath = process.env.CRASHLABS_APP_KEY;
  if (!repo || !pr) throw new Error("usage: node app/bot.mjs --repo <owner/name> --pr <number>");
  if (!appId || !keyPath) throw new Error("set CRASHLABS_APP_ID and CRASHLABS_APP_KEY (see app/.env.example)");
  const [owner, name] = repo.split("/");
  const pem = readFileSync(keyPath, "utf8");

  // 1. auth as the app, then as the installation on this repo
  const jwt = appJwt(appId, pem);
  const inst =
    process.env.CRASHLABS_INSTALLATION_ID ||
    (await gh(jwt, `/repos/${owner}/${name}/installation`)).id;
  const { token } = await gh(jwt, `/app/installations/${inst}/access_tokens`, { method: "POST" });

  // 2. read the PR's agent source at its head commit
  const prData = await gh(token, `/repos/${owner}/${name}/pulls/${pr}`);
  const sha = prData.head.sha;
  const fetchFile = async (path) => {
    try {
      const f = await gh(token, `/repos/${owner}/${name}/contents/${path}?ref=${sha}`);
      return Buffer.from(f.content, "base64").toString("utf8");
    } catch {
      return "";
    }
  };
  const cfg = await fetchFile("crashlabs.yml");
  const coordPath = (cfg.match(/coordinator:\s*([^\s#]+)/) || [])[1] || "src/kestrel_support/coordinator.py";
  const runtimePath = join(dirname(coordPath), "runtime.py");
  const source = [await fetchFile(coordPath), await fetchFile(runtimePath)].join("\n\n");
  const verdict = classifySource(source);

  // 3. build the report
  const suite = JSON.parse(readFileSync(join(ROOT, "runner", "suite.json"), "utf8"));
  const recording = JSON.parse(
    readFileSync(join(ROOT, "runner", "recordings", "active-chargeback-delayed-fraud.json"), "utf8"),
  );
  const { results, totals } = computeResults(suite, verdict);
  const failed = totals.failedChecks > 0;

  // 4. create a Check Run authored by the app, with the FULL evidence + timeline
  //    in its Details page (this is the "Investigate" target the comment links to)
  const timeline = recording.scenarios[0].candidate.events
    .map(progressLine)
    .filter(Boolean)
    .map((l) => `    ${l}`)
    .join("\n");
  const detailedReport = buildReport({ verdict, suite, results, totals, recording, detailed: true });
  const checkText = failed
    ? `${detailedReport}\n\n<details><summary>candidate timeline</summary>\n\n\`\`\`\n${timeline}\n\`\`\`\n</details>`
    : detailedReport;
  const check = await gh(token, `/repos/${owner}/${name}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: "CrashLabs / behavioral",
      head_sha: sha,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      output: {
        title: failed
          ? `${totals.failedChecks} of ${totals.totalChecks} behavioral checks failed`
          : `${totals.totalChecks} behavioral checks passed`,
        summary: failed
          ? "A behavioral regression was found. Merge is blocked — see the comment on the pull request."
          : "No behavioral regression. Safe to merge.",
        text: checkText,
      },
    }),
  });

  // 5. post/update the PR comment as the app
  // Post the comment authored BY THE APP. Any earlier marker comment posted by
  // something else (e.g. the retired github-actions check) is deleted so the
  // comment shows as CrashLabs, not "github-actions edited by CrashLabs".
  const marker = "<!-- crashlabs-check -->";
  const self = await gh(jwt, `/app`);
  const selfLogin = `${self.slug}[bot]`;
  const comments = await gh(token, `/repos/${owner}/${name}/issues/${pr}/comments?per_page=100`);
  const marked = comments.filter((c) => c.body && c.body.includes(marker));
  for (const c of marked) {
    if (c.user?.login !== selfLogin) {
      await gh(token, `/repos/${owner}/${name}/issues/comments/${c.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  const mine = marked.find((c) => c.user?.login === selfLogin);
  // The comment stays scannable and links "Investigate →" to the check-run page.
  const commentReport = buildReport({
    verdict,
    suite,
    results,
    totals,
    recording,
    detailed: false,
    investigateUrl: check?.html_url,
  });
  const body = `${commentReport}\n${marker}`;
  if (mine) {
    await gh(token, `/repos/${owner}/${name}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
  } else {
    await gh(token, `/repos/${owner}/${name}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }

  console.log(
    `CrashLabs[bot]: posted ${failed ? "❌ failure" : "✅ success"} check + comment on ${repo}#${pr} (${totals.passedChecks}/${totals.totalChecks} checks).`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
