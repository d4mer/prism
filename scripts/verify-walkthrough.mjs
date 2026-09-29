#!/usr/bin/env node
/**
 * Helper for docs/verification-walkthrough.md: builds a throwaway "SAP APO to
 * OMP" bundle in your temp folder, then runs a real Prism server on it, so
 * every check in the walkthrough has realistic data to work on. Nothing in
 * your own bundles is touched.
 *
 *   node scripts/verify-walkthrough.mjs start    # (re)seed the bundle and start the server
 *   node scripts/verify-walkthrough.mjs stop     # stop the server (the bundle stays for inspection)
 *   node scripts/verify-walkthrough.mjs status
 *
 * Needs Node 22.5+ and the packages built (pnpm install && pnpm -r build).
 * The server is started with NO model or embeddings configured, on purpose:
 * everything checked here must work without one. (Check 12, embeddings, is the
 * exception: start with PRISM_VERIFY_EMBEDDINGS=1 to pass your EMBEDDING_*
 * settings through.)
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(os.tmpdir(), "prism-verify");
const bundle = path.join(work, "bundle");
const pidFile = path.join(work, "server.pid");
const logFile = path.join(work, "server.log");
const port = Number(process.env.PRISM_VERIFY_PORT ?? 3899);
const base = `http://127.0.0.1:${port}/api/v1`;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function stopServer() {
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf-8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(pidFile, { force: true });
  return true;
}

async function alive() {
  try {
    return (await fetch(`${base}/index/status`)).ok;
  } catch {
    return false;
  }
}

async function seed() {
  const core = await import(pathToFileURL(path.join(repo, "packages/core/dist/index.js")).href).catch(() =>
    fail("Prism isn't built yet. Run:  pnpm install && pnpm -r build")
  );
  const { KnowledgeBase } = core;
  const kb = new KnowledgeBase(bundle);
  const DAY = 86_400_000;
  const iso = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

  await kb.writeConcept(
    "/emea/cmo/safety-stock-policy.md",
    {
      type: "Decision",
      title: "Safety stock buffer method for CMO network",
      description: "Fixed min/max banding replaces APO's dynamic safety stock for the CMO network",
      tags: ["cmo", "inventory"],
      aliases: ["SSTK"],
      status: "open",
      owner: "Priya S.",
      due: iso(-9), // overdue on purpose
      confidence: 0.4, // low on purpose
      source: "document",
      asserted: iso(-40),
    },
    "# Context\n\nAPO calculated safety stock dynamically. OMP has no equivalent method in the target release, so the workshop proposed fixed min/max banding.\n\n# Related\n\n- [Planning book parameters](/emea/cmo/planning-book-params.md)\n- [Master data interface](/emea/cmo/master-data-interface.md)\n- [Confirm CMO freeze window](/emea/cmo/freeze-window.md)\n",
    "Added [Safety stock policy](/emea/cmo/safety-stock-policy.md)."
  );
  await kb.writeConcept(
    "/emea/cmo/planning-book-params.md",
    { type: "Config Item", title: "OMP planning book: CMO safety stock parameters", description: "Min/max band values in the OMP planning book", tags: ["cmo"] },
    "Min/max bands are set monthly by regional planners.\n\nDriven by [the safety stock decision](/emea/cmo/safety-stock-policy.md).\n",
    "Added [Planning book parameters](/emea/cmo/planning-book-params.md)."
  );
  await kb.writeConcept(
    "/emea/cmo/master-data-interface.md",
    { type: "Interface", title: "APO-to-OMP master data interface (nightly batch)", description: "Nightly batch carrying product and location data", tags: ["cmo", "integration"] },
    "Carries product and location data during the parallel run. Also feeds the [local-to-local network](/emea/l2l/local-to-local-network.md).\n\nSee [planning book parameters](/emea/cmo/planning-book-params.md).\n",
    "Added [Master data interface](/emea/cmo/master-data-interface.md)."
  );
  await kb.writeConcept(
    "/emea/l2l/local-to-local-network.md",
    { type: "Reference", title: "Local-to-local supply network", description: "Sites that manufacture for their own market", aliases: ["L2L"] },
    "Sites supply their own region. Lead times are in [LATAM lead times](/latam/lead-times.md).\n",
    "Added [L2L network](/emea/l2l/local-to-local-network.md)."
  );
  await kb.writeConcept(
    "/latam/lead-times.md",
    { type: "Note", title: "LATAM lead times", description: "Lead times collected from LATAM sites", tags: ["latam"] },
    "Lead times collected from sites. Earlier figures: [old CMO lead time note](/emea/cmo/old-lead-time-note.md).\n",
    "Added [LATAM lead times](/latam/lead-times.md)."
  );
  await kb.writeConcept(
    "/emea/cmo/freeze-window.md",
    { type: "Action", title: "Confirm CMO freeze window", description: "Agree the freeze window with the client", status: "in_progress", owner: "Priya S.", due: iso(5) },
    "Confirm the freeze window with the client before cutover. Part of [the safety stock decision](/emea/cmo/safety-stock-policy.md).\n",
    "Added [Freeze window](/emea/cmo/freeze-window.md)."
  );
  await kb.writeConcept(
    "/emea/cmo/old-lead-time-note.md",
    { type: "Note", title: "Old CMO lead time note", description: "First-workshop lead time figures" },
    "Figures from the first workshop, never revisited.\n",
    "Added [Old lead time note](/emea/cmo/old-lead-time-note.md)."
  );
  // Belief history for the temporal checks.
  await kb.writeConcept(
    "/emea/cmo/service-level-target.md",
    { type: "Decision", title: "Service level target: 95%", description: "Original CMO service level", asserted: "2026-03-01", source: "human" },
    "Target 95% for all CMO SKUs.\n",
    "Added [Service level target](/emea/cmo/service-level-target.md)."
  );
  await kb.supersede(
    "/emea/cmo/service-level-target.md",
    "/emea/cmo/service-level-target-v2.md",
    { type: "Decision", title: "Service level target: 98%", description: "Raised CMO service level", asserted: "2026-06-01", source: "human" },
    "Target raised to 98% after the May workshop.\n",
    "Superseded [the 95% target](/emea/cmo/service-level-target.md) with [98%](/emea/cmo/service-level-target-v2.md) after the May workshop."
  );
  // An untriaged capture from ten days ago (an orphan in the inbox, on purpose).
  await kb.capture({ text: "Ask Priya whether the CMO freeze also covers master data", now: new Date(Date.now() - 10 * DAY) });

  // Make one note look long-untouched while its folder stays active.
  const { promises: fs } = await import("node:fs");
  const stale = path.join(bundle, "emea/cmo/old-lead-time-note.md");
  const old = new Date(Date.now() - 120 * DAY).toISOString();
  await fs.writeFile(stale, (await fs.readFile(stale, "utf-8")).replace(/^timestamp: .*$/m, `timestamp: '${old}'`));

  await kb.rebuildSearchIndex();
  return (await kb.validate()).conceptCount;
}

async function start() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) fail(`Node 22.5 or newer is needed (you have ${process.versions.node}).`);
  const server = path.join(repo, "packages/server/dist/index.js");
  if (!existsSync(server)) fail("Prism isn't built yet. Run:  pnpm install && pnpm -r build");
  if (stopServer()) await new Promise((r) => setTimeout(r, 500));
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const count = await seed();
  const log = openSync(logFile, "w");
  const child = spawn(process.execPath, ["--no-warnings", server], {
    detached: true,
    stdio: ["ignore", log, log],
    // Deliberately no LLM_* variables, and no EMBEDDING_* unless asked for, whatever your shell has set.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BUNDLE_ROOT: bundle,
      PORT: String(port),
      INDEX_WATCH: "true",
      // Only when you ask for it (check 12): pass your EMBEDDING_* settings through.
      ...(process.env.PRISM_VERIFY_EMBEDDINGS === "1"
        ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("EMBEDDING_")))
        : {}),
    },
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 80 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await alive())) fail(`The server didn't start. Last log lines:\n${readFileSync(logFile, "utf-8").split("\n").slice(-12).join("\n")}`);

  console.log(`
Prism walkthrough server is running with ${count} sample concepts.
Nothing here touches your own bundles; the sample lives in:
  ${bundle}

Paste these two lines into the terminal you will use for the checks:

  export B=${base}
  export V='${bundle}'

When you are done:  node scripts/verify-walkthrough.mjs stop
`);
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") {
  console.log(stopServer() ? "Stopped." : "Nothing was running.");
} else if (cmd === "status") {
  console.log((await alive()) ? `Running at ${base}\nBundle: ${bundle}` : "Not running.");
} else fail("Usage: node scripts/verify-walkthrough.mjs start | stop | status");
