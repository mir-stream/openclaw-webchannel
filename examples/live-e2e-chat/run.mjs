/**
 * One-command orchestrator for the live E2E chat demo.
 *
 *   npm start
 *
 * Boots: nats-server (websocket) → the agent → the Vite dev server, then prints
 * the URL. Ctrl-C tears everything down.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = (name) => {
  const p = join(here, "node_modules", ".bin", name);
  if (!existsSync(p)) {
    console.error(`[run] ${name} not found — run \`npm install\` in ${here}`);
    process.exit(1);
  }
  return p;
};

const children = [];
function spawnNamed(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const tag = `[${label}]`;
  child.stdout?.on("data", (b) => process.stdout.write(prefix(tag, b)));
  child.stderr?.on("data", (b) => process.stdout.write(prefix(tag, b)));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${tag} exited (code ${code}) — shutting down.`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}
function prefix(tag, buf) {
  return buf
    .toString()
    .split("\n")
    .filter((l) => l.length)
    .map((l) => `${tag} ${l}\n`)
    .join("");
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGKILL");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function waitForLog(child, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    const onData = (b) => {
      if (b.toString().includes(needle)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

async function main() {
  console.log("[run] starting nats-server (websocket :8087)…");
  const nats = spawnNamed("nats", "nats-server", ["-c", join(here, "nats.conf")]);
  await waitForLog(nats, "Server is ready", 8000).catch(() => {
    console.error("[run] nats-server did not start. Install it: `brew install nats-server`");
    shutdown(1);
  });

  console.log("[run] starting agent…");
  const agent = spawnNamed("agent", bin("tsx"), [join(here, "agent", "agent.ts")]);
  await waitForLog(agent, "waiting for a browser", 10000).catch(() => {});

  console.log("[run] starting web (Vite)…");
  spawnNamed("web", bin("vite"), ["web"], { cwd: here });

  console.log("\n[run] ───────────────────────────────────────────────");
  console.log("[run]  Open  http://localhost:5273  in your browser.");
  console.log("[run]  Type a message — it is ChaCha20-Poly1305 encrypted,");
  console.log("[run]  relayed by NATS as ciphertext, and decrypted by the agent.");
  console.log("[run]  Ctrl-C to stop everything.");
  console.log("[run] ───────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("[run] fatal:", err);
  shutdown(1);
});
