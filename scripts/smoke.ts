/**
 * Runs one short generation through the app, the way the browser would, and
 * waits for it: the end-to-end proof that a setup works.
 *
 *   pnpm smoke                                   # Text to Video on localhost:3000
 *   pnpm smoke --director local                  # rewrite on the ComfyUI machine
 *   pnpm smoke --director local --local-model gemma-4-12b-heretic
 *   pnpm smoke --director none                   # skip the rewrite altogether
 *   pnpm smoke --url https://<app>.vercel.app    # against a deployment
 *   pnpm smoke --workflow minimax-music3
 *
 * Needs the app running at --url, and APP_ACCESS_TOKEN (from .env.local or the
 * environment) when the app has one. It submits with the switches a new user
 * gets — Turbo and SageAttention — because those are what fail on a
 * fresh machine, and prints ComfyUI's own error if the run fails, so whoever
 * runs it can fix it from the output instead of from a screenshot.
 *
 * Exit 0: the run finished and produced a file. Anything else is a failure, and
 * the last lines say which kind — the run failed (with ComfyUI's error), or it
 * could not be submitted (app not running, wrong token, ComfyUI unreachable).
 * Run directly the script exits 1 or 2 for those; through pnpm both read as 1.
 */
import { WORKFLOWS } from "../src/lib/workflows";
import { LOCAL_DIRECTOR_MODELS } from "../src/lib/workflows/local-director";
import { loadEnvFiles } from "./lib/env";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const PROMPTS: Record<string, string> = {
  "minimax-h3":
    "A paper boat drifts down a rain-soaked street at night while a cat watches from a doorway.",
  "minimax-music3": "A short, upbeat acoustic guitar instrumental.",
};

async function main() {
  loadEnvFiles();
  const url = arg("url", "http://localhost:3000").replace(/\/$/, "");
  const director = arg("director", "gateway");
  // The best of the local models unless told: on a machine without it the
  // run says so, and names the file.
  const localModel = arg("local-model", LOCAL_DIRECTOR_MODELS[0].id);
  const workflowId = arg("workflow", "minimax-h3");
  const workflow = WORKFLOWS.find((w) => w.id === workflowId);
  if (!workflow) {
    console.error(`Unknown workflow "${workflowId}". Known: ${WORKFLOWS.map((w) => w.id).join(", ")}`);
    process.exit(2);
  }
  if (!["gateway", "local", "none"].includes(director)) {
    console.error('--director is gateway, local or none.');
    process.exit(2);
  }
  if (!LOCAL_DIRECTOR_MODELS.some((model) => model.id === localModel)) {
    console.error(`--local-model is one of ${LOCAL_DIRECTOR_MODELS.map((model) => model.id).join(", ")}.`);
    process.exit(2);
  }
  const prompt = PROMPTS[workflowId];
  if (!prompt) {
    console.error(`No smoke prompt for ${workflowId} — it needs an upload. Use minimax-h3 or minimax-music3.`);
    process.exit(2);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.APP_ACCESS_TOKEN) headers["x-app-token"] = process.env.APP_ACCESS_TOKEN;

  const health = await fetch(`${url}/api/health`, { headers })
    .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }))
    .catch((error: unknown) => {
      console.error(`Could not reach the app at ${url}: ${error instanceof Error ? error.message : error}. Is it running?`);
      process.exit(2);
    });
  if (health.status === 401) {
    console.error("The app refused APP_ACCESS_TOKEN. Check it in .env.local (or the environment).");
    process.exit(2);
  }
  if (health.body.reachable !== true || health.body.authorized === false) {
    console.error(`The app cannot use ComfyUI: ${JSON.stringify(health.body)}`);
    process.exit(2);
  }

  const turbo = workflow.turbo?.defaultOn === true;
  const patches = (workflow.patches ?? []).filter((p) => p.defaultOn).map((p) => p.id);
  const body = {
    workflowId,
    turbo,
    patches,
    params: {
      prompt,
      ...(workflowId === "minimax-h3" ? { duration: 5 } : { duration: 20 }),
      ...(director === "none" ? { literal_prompt: true } : {}),
    },
    ...(director === "local" ? { director: "local", localDirector: localModel } : {}),
  };

  const label = [workflow.name, turbo ? "Turbo" : null, ...patches].filter(Boolean).join(" + ");
  console.log(
    `Submitting ${label}, rewrite: ${director === "local" ? `local (${localModel})` : director}, to ${url}`,
  );
  const submitted = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = (await submitted.json().catch(() => ({}))) as { promptId?: string; error?: string };
  if (!submitted.ok || !result.promptId) {
    console.error(`The app would not queue it (${submitted.status}): ${result.error ?? JSON.stringify(result)}`);
    process.exit(2);
  }

  const started = Date.now();
  const elapsed = () => {
    const s = Math.round((Date.now() - started) / 1000);
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = (await fetch(`${url}/api/status?promptId=${result.promptId}`, { headers })
      .then((r) => r.json())
      .catch(() => ({ state: "unreachable" }))) as {
      state: string;
      queuePosition?: number | null;
      error?: string;
      outputs?: { filename: string }[];
    };
    const now = status.state === "queued" ? `queued (position ${status.queuePosition ?? "?"})` : status.state;
    if (now !== last) {
      console.log(`  ${elapsed()}  ${now}`);
      last = now;
    }
    if (status.state === "done") {
      const file = status.outputs?.[0]?.filename;
      if (!file) {
        console.error("Finished, but produced no file.");
        process.exit(1);
      }
      console.log(`\nSmoke test passed: ${workflow.name} finished in ${elapsed()} → ${file}`);
      return;
    }
    if (status.state === "error") {
      console.error(`\nSmoke test FAILED after ${elapsed()}:\n${status.error ?? "(no error text)"}`);
      process.exit(1);
    }
    if (Date.now() - started > 45 * 60_000) {
      console.error("\nNo result after 45 minutes. Check ComfyUI's console.");
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
