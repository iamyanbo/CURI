/**
 * Pi command: /webui — start (or reveal) the autoresearch dashboard.
 *
 * The extension is a CLIENT of the dashboard, never a controller of the
 * campaign. It starts a read-only server and prints the URL. It deliberately
 * registers no way to start, steer, approve or stop research from a Pi session:
 * `plans/03` §17.1 requires that closing, reloading or forking a Pi session
 * cannot affect a running campaign, and the simplest guarantee is that this
 * extension has no such capability to begin with.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PORT = 4791;

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/summary`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function (pi: any) {
  pi.registerCommand("webui", {
    description: "Open the autoresearch dashboard (read-only experiment tree, trajectory, progress)",
    handler: async (ctx: any) => {
      const cwd = ctx?.cwd ?? process.cwd();
      const port = Number(process.env.AR_UI_PORT ?? DEFAULT_PORT);
      const server = join(cwd, "src", "ui", "server.ts");
      const url = `http://127.0.0.1:${port}`;

      if (!existsSync(join(cwd, ".autoresearch", "state.sqlite"))) {
        return `No campaign found in ${cwd}. Run a cycle first — the dashboard reads recorded state and has nothing to show without it.`;
      }

      if (await isUp(port)) return `Dashboard already running: ${url}`;

      if (!existsSync(server)) {
        return `Dashboard server not found at ${server}.`;
      }

      // Detached so the dashboard outlives this Pi session, matching the
      // campaign daemon's lifetime rather than the terminal's.
      const child = spawn("npx", ["tsx", server], {
        cwd,
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
        env: { ...process.env, AR_UI_PORT: String(port) },
      });
      child.unref();

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isUp(port)) return `Dashboard started: ${url}`;
      }
      return `Started the dashboard process but ${url} did not respond. Check: npx tsx ${server}`;
    },
  });
}
