/**
 * Downloads the model files the chosen workflows need, into a ComfyUI install.
 *
 *   pnpm models:download --comfy <ComfyUI folder>                     # what each workflow needs, and what is already there
 *   pnpm models:download --comfy <dir> --workflows minimax-h3,minimax-music3
 *   pnpm models:download --comfy <dir> --workflows all --extras local-director
 *   pnpm models:download --comfy <dir> --workflows all --skip minimax_h3_ref2va_bf16.safetensors
 *
 * Run it on the ComfyUI machine. Which files a workflow needs comes from the
 * graphs themselves (src/lib/workflows/needs.ts, the same list `check:nodes` asks
 * about), and where each comes from is scripts/lib/model-sources.ts.
 *
 * Models already on the machine count wherever ComfyUI would find them: the
 * install's own models/, every folder its extra_model_paths.yaml adds, and any
 * further --models-dir. New files go to the first of those. A file already in
 * place at the right size is skipped.
 *
 * Two cases for someone who already runs H3 in ComfyUI:
 *
 * - The same file under another name, or in a subfolder: found by its exact
 *   size and hard-linked under the name the graphs use — the same data under a
 *   second name, no download and no copy. `--no-link` turns that off.
 * - A file with the right name and the wrong size: someone's own copy, an older
 *   or newer revision. Never overwritten silently — the script stops and says
 *   where it is. `--replace <file>` downloads it anyway, into this install's
 *   own models folder: a copy of theirs in that folder is kept as <file>.old,
 *   and copies in other installs' folders are not touched. A partial download is
 * resumed from where it stopped, so an interrupted run is safe to repeat. No
 * file in use is gated today; a source marked `gated` would need HF_TOKEN from
 * an account that accepted its licence, and the script says so.
 */
import {
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WORKFLOWS } from "../src/lib/workflows";
import { collect } from "../src/lib/workflows/needs";
import { EXTRAS, MODEL_SOURCES } from "./lib/model-sources";

interface Args {
  comfy?: string;
  modelsDirs: string[];
  workflows: string[];
  extras: string[];
  skip: string[];
  replace: string[];
  link: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    modelsDirs: [],
    workflows: [],
    extras: [],
    skip: [],
    replace: [],
    link: true,
    dryRun: false,
  };
  /**
   * A list flag takes "a,b" and also "a b": PowerShell turns an unquoted a,b
   * into an array, which reaches here as separate arguments.
   */
  const takeList = (i: number): [string[], number] => {
    const values: string[] = [];
    let j = i + 1;
    while (j < argv.length && !argv[j].startsWith("--")) {
      values.push(...argv[j].split(/[,\s]+/).map((v) => v.trim()).filter(Boolean));
      j++;
    }
    return [values, j - 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--comfy") (args.comfy = value), i++;
    else if (flag === "--models-dir") (args.modelsDirs.push(value), i++);
    else if (flag === "--workflows") [args.workflows, i] = takeList(i);
    else if (flag === "--extras") [args.extras, i] = takeList(i);
    else if (flag === "--skip") [args.skip, i] = takeList(i);
    else if (flag === "--replace") [args.replace, i] = takeList(i);
    else if (flag === "--no-link") args.link = false;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--") continue;
    else {
      console.error(`Unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * ComfyUI's old folder names, which it still searches: a file under unet/ is a
 * diffusion model to it, and one under clip/ a text encoder.
 */
const LEGACY: Record<string, string[]> = {
  diffusion_models: ["unet"],
  text_encoders: ["clip"],
};
const canonical = (folder: string) =>
  Object.entries(LEGACY).find(([, old]) => old.includes(folder))?.[0] ?? folder;

/**
 * Every folder ComfyUI would look in, per model folder name: each root's own
 * subfolder (and its legacy name), plus what extra_model_paths.yaml adds.
 */
type SearchPath = Map<string, string[]>;

function addRoot(paths: SearchPath, root: string): void {
  for (const folder of new Set(Object.values(MODEL_SOURCES).map((s) => s.folder))) {
    const list = paths.get(folder) ?? [];
    for (const name of [folder, ...(LEGACY[folder] ?? [])]) list.push(join(root, name));
    paths.set(folder, list);
  }
}

/**
 * The parts of extra_model_paths.yaml that say where models are: each section's
 * base_path, and its folder keys, one path or a `|` block of several. A small
 * reader rather than a YAML dependency, because this is the whole of the format
 * ComfyUI documents for the file.
 */
function addExtraModelPaths(paths: SearchPath, comfy: string): string[] {
  const file = join(comfy, "extra_model_paths.yaml");
  if (!existsSync(file)) return [];
  const added: string[] = [];
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  interface Section { base: string; entries: [string, string[]][] }
  const sections: Section[] = [];
  let section: Section | null = null;
  let block: [string, string[]] | null = null;
  let blockIndent = -1;

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (block && indent > blockIndent) {
      block[1].push(unquote(line));
      continue;
    }
    block = null;
    if (indent === 0) {
      section = { base: comfy, entries: [] };
      sections.push(section);
      continue;
    }
    const match = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match || !section) continue;
    const [, key, value] = match;
    if (key === "base_path") section.base = resolve(dirname(file), unquote(value));
    else if (key === "is_default") continue;
    else if (value.trim() === "|" || value.trim() === "") {
      block = [key, []];
      blockIndent = indent;
      section.entries.push(block);
    } else section.entries.push([key, [unquote(value)]]);
  }

  for (const { base, entries } of sections) {
    for (const [key, values] of entries) {
      const folder = canonical(key);
      if (!paths.has(folder)) continue;
      for (const value of values) {
        const dir = resolve(base, value);
        paths.get(folder)!.push(dir);
        added.push(dir);
      }
    }
  }
  return added;
}

const gb = (bytes: number) =>
  bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;

/** Required files per workflow id, read off the graphs. */
function requiredByWorkflow(): Map<string, Set<string>> {
  const byWorkflow = new Map<string, Set<string>>(
    WORKFLOWS.map((w) => [w.id, new Set<string>()]),
  );
  for (const [file, need] of collect().models) {
    if (need.optional) continue;
    // Labels are "<workflow id>" or "<workflow id> (<form>)".
    for (const label of need.workflows) {
      byWorkflow.get(label.split(" ")[0])?.add(file);
    }
  }
  return byWorkflow;
}

function pathFor(modelsDir: string, file: string): string {
  return join(modelsDir, MODEL_SOURCES[file].folder, file);
}

/**
 * Present means somewhere ComfyUI will look, at the right size: a short file
 * is a download that stopped.
 */
function isPresent(paths: SearchPath, file: string): boolean {
  const { folder, bytes } = MODEL_SOURCES[file];
  return (paths.get(folder) ?? []).some((dir) => {
    const target = join(dir, file);
    return existsSync(target) && statSync(target).size === bytes && !mislinked(paths, target, file);
  });
}

/**
 * A copy that is really another source's file: hard-linked to it, as earlier
 * versions of this script did when two sources shared a size (see
 * sameSizeElsewhere). Right name, right size, wrong weights — so it counts as
 * absent, and the download replaces the link without touching the other file.
 */
function mislinked(paths: SearchPath, target: string, file: string): boolean {
  const { dev, ino } = statSync(target);
  return Object.entries(MODEL_SOURCES).some(([name, s]) => {
    if (name === file || s.bytes !== MODEL_SOURCES[file].bytes) return false;
    return (paths.get(s.folder) ?? []).some((dir) => {
      const other = join(dir, name);
      if (!existsSync(other)) return false;
      const stats = statSync(other);
      return stats.dev === dev && stats.ino === ino;
    });
  });
}

/** Same name, wrong size, anywhere ComfyUI looks: someone's own copy. */
function conflictFor(paths: SearchPath, file: string): string | null {
  const { folder, bytes } = MODEL_SOURCES[file];
  for (const dir of paths.get(folder) ?? []) {
    const target = join(dir, file);
    if (existsSync(target) && statSync(target).size !== bytes) return target;
  }
  return null;
}

const MODEL_EXTENSIONS = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;

/**
 * Every model file in every folder ComfyUI searches, by size, a few levels
 * deep — ComfyUI lists files in subfolders as "sub/name", which no graph's
 * filename matches, so they are as good as absent until linked.
 */
function filesBySize(paths: SearchPath): Map<number, string[]> {
  const bySize = new Map<number, string[]>();
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (MODEL_EXTENSIONS.test(entry.name)) {
        try {
          const size = statSync(full).size;
          bySize.set(size, [...(bySize.get(size) ?? []), full]);
        } catch {
          // Unreadable: not ours to worry about.
        }
      }
    }
  };
  for (const dirs of paths.values()) for (const dir of dirs) walk(dir, 0);
  return bySize;
}

/**
 * A file of exactly the expected size under another name. Byte-exact size is
 * a strong match for files of hundreds of megabytes to tens of gigabytes; a
 * name match is not required, because a renamed or moved copy is the point.
 *
 * Except where two sources share a size: H3's ref2va and fl2va checkpoints are
 * the same shape with different weights, so each pair is byte-for-byte the
 * same length. A renamed copy of either cannot be told apart by size, and
 * linking one under the other's name runs the wrong model without a word —
 * those are downloaded, never linked. A file named as another source is that
 * source, whatever its size, so it is never a candidate either.
 */
function sameSizeElsewhere(bySize: Map<number, string[]>, file: string): string | null {
  const { bytes } = MODEL_SOURCES[file];
  const shared = Object.entries(MODEL_SOURCES).some(([name, s]) => name !== file && s.bytes === bytes);
  if (shared) return null;
  const candidates = (bySize.get(bytes) ?? []).filter((path) => {
    const name = basename(path);
    return name === file || !(name in MODEL_SOURCES);
  });
  return candidates[0] ?? null;
}

/**
 * A hard link: the same data under a second name. Fails across drives. Made to
 * the real file, since a hard link to a relative symlink — common on Linux,
 * where models are often linked in from a shared store — dangles once it sits
 * in another folder.
 */
function linkInto(modelsDir: string, file: string, from: string): string | null {
  const target = pathFor(modelsDir, file);
  try {
    mkdirSync(join(modelsDir, MODEL_SOURCES[file].folder), { recursive: true });
    linkSync(realpathSync(from), target);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function download(modelsDir: string, file: string): Promise<void> {
  const source = MODEL_SOURCES[file];
  const target = pathFor(modelsDir, file);
  const partial = `${target}.part`;
  mkdirSync(join(modelsDir, source.folder), { recursive: true });

  const have = existsSync(partial) ? statSync(partial).size : 0;
  const headers: Record<string, string> = {};
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  if (have > 0) headers.Range = `bytes=${have}-`;

  const url = `https://huggingface.co/${source.repo}/resolve/main/${source.path}`;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      source.gated
        ? `${file} is gated. Accept the licence at https://huggingface.co/${source.repo} ` +
            "while signed in, then set HF_TOKEN to a token from that account and run this again."
        : `Hugging Face refused ${file} (${response.status}). Set HF_TOKEN and try again.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`${file}: HTTP ${response.status} from ${url}`);
  }
  // A server that ignored the Range header is sending the whole file again.
  const resuming = have > 0 && response.status === 206;

  let written = resuming ? have : 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => {
    written += chunk.length;
    const now = Date.now();
    if (now - lastReport > 5000) {
      lastReport = now;
      const pct = ((written / source.bytes) * 100).toFixed(0);
      console.log(`    ${file}: ${gb(written)} of ${gb(source.bytes)} (${pct}%)`);
    }
  });
  await pipeline(body, createWriteStream(partial, { flags: resuming ? "a" : "w" }));

  const size = statSync(partial).size;
  if (size !== source.bytes) {
    throw new Error(
      `${file} finished at ${size} bytes, expected ${source.bytes}. ` +
        "Run this again to resume it.",
    );
  }
  // Only reached for a conflicting file when --replace named it: theirs is
  // kept beside the new one rather than overwritten. A mislinked one is only
  // a second name for another source, so it is simply replaced.
  if (existsSync(target) && statSync(target).size !== source.bytes) {
    renameSync(target, `${target}.old`);
  }
  renameSync(partial, target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.comfy && args.modelsDirs.length === 0) {
    console.error(
      "Pass --comfy <your ComfyUI folder> (the one containing main.py and models/),\n" +
        "or --models-dir <path> if your models live elsewhere (extra_model_paths.yaml).",
    );
    process.exit(2);
  }
  // New files go to the first root: the install's own models/, or the first
  // --models-dir when there is no --comfy.
  const roots = [
    ...(args.comfy ? [resolve(args.comfy, "models")] : []),
    ...args.modelsDirs.map((dir) => resolve(dir)),
  ];
  const modelsDir = roots[0];
  if (!existsSync(modelsDir)) {
    console.error(`No models folder at ${modelsDir}. Is --comfy the ComfyUI folder?`);
    process.exit(2);
  }
  const paths: SearchPath = new Map();
  for (const root of roots) addRoot(paths, root);
  const extra = args.comfy ? addExtraModelPaths(paths, resolve(args.comfy)) : [];
  const elsewhere = [...roots.slice(1), ...extra];

  const byWorkflow = requiredByWorkflow();

  // No selection: show what each choice costs and what is already there.
  if (args.workflows.length === 0 && args.extras.length === 0) {
    console.log(`Models folder: ${modelsDir}`);
    for (const dir of elsewhere) console.log(`Also looking in: ${dir}`);
    console.log("\nWorkflows (--workflows, comma-separated, or all):");
    for (const workflow of WORKFLOWS) {
      const files = [...(byWorkflow.get(workflow.id) ?? [])];
      const missing = files.filter((f) => !isPresent(paths, f));
      const bytes = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
      console.log(
        `  ${workflow.id.padEnd(18)} ${workflow.name.padEnd(20)} ` +
          (missing.length ? `${missing.length} file(s) missing, ${gb(bytes)}` : "all present"),
      );
    }
    console.log("\nExtras (--extras):");
    for (const [id, extra] of Object.entries(EXTRAS)) {
      const missing = extra.files.filter((f) => !isPresent(paths, f));
      const bytes = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
      console.log(
        `  ${id.padEnd(18)} ${extra.what} — ` +
          (missing.length ? gb(bytes) : "present"),
      );
    }
    console.log(
      "\nFiles shared between workflows are counted under each; downloading several\n" +
        "costs less than the sum. Add --dry-run to see the exact total first.",
    );
    return;
  }

  const wanted = new Set<string>();
  const ids =
    args.workflows.includes("all") ? WORKFLOWS.map((w) => w.id) : args.workflows;
  for (const id of ids) {
    const files = byWorkflow.get(id);
    if (!files) {
      console.error(`Unknown workflow "${id}". Known: ${WORKFLOWS.map((w) => w.id).join(", ")}`);
      process.exit(2);
    }
    files.forEach((f) => wanted.add(f));
  }
  for (const id of args.extras) {
    const extra = EXTRAS[id];
    if (!extra) {
      console.error(`Unknown extra "${id}". Known: ${Object.keys(EXTRAS).join(", ")}`);
      process.exit(2);
    }
    extra.files.forEach((f) => wanted.add(f));
  }
  for (const file of args.skip) wanted.delete(file);

  const absent = [...wanted].filter((f) => !isPresent(paths, f));

  // Someone's own copy under the right name and the wrong size. Downloading
  // would replace it (or shadow it), so it is left alone unless --replace
  // names it.
  const replaceAll = args.replace.includes("all");
  const conflicts = absent
    .map((file) => ({ file, at: conflictFor(paths, file) }))
    .filter((c): c is { file: string; at: string } => c.at !== null)
    .filter((c) => !replaceAll && !args.replace.includes(c.file));

  // The same file under another name, or in a subfolder: linked, not fetched.
  const bySize = args.link ? filesBySize(paths) : new Map<number, string[]>();
  const linkable = absent
    .filter((file) => !conflicts.some((c) => c.file === file))
    .map((file) => ({ file, from: sameSizeElsewhere(bySize, file) }))
    .filter((l): l is { file: string; from: string } => l.from !== null);

  const missing = absent.filter(
    (f) => !conflicts.some((c) => c.file === f) && !linkable.some((l) => l.file === f),
  );
  const total = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
  const free = (() => {
    const stats = statfsSync(modelsDir);
    return stats.bavail * stats.bsize;
  })();

  console.log(`Models folder: ${modelsDir}`);
  for (const dir of elsewhere) console.log(`Also looking in: ${dir}`);
  console.log(`${wanted.size - absent.length} of ${wanted.size} file(s) already present.`);
  for (const { file, from } of linkable) {
    console.log(`  link ${MODEL_SOURCES[file].folder}/${file}  ← same file, found as ${from}`);
  }
  for (const { file, at } of conflicts) {
    console.log(
      `  KEEP ${at}  — has the right name but not the right size (${gb(statSync(at).size)}, expected ${gb(MODEL_SOURCES[file].bytes)})`,
    );
  }
  for (const file of missing) {
    const source = MODEL_SOURCES[file];
    console.log(
      `  get  ${source.folder}/${file}  ${gb(source.bytes)}${source.gated ? "  (gated: needs HF_TOKEN)" : ""}`,
    );
  }
  console.log(`To download: ${gb(total)}. Free on that drive: ${gb(free)}.`);

  // A dry run reports and succeeds: it is asking, not trying.
  const fail = () => process.exit(args.dryRun ? 0 : 1);
  if (total > free) {
    console.error("\nNot enough free space. Choose fewer workflows, or use --skip.");
    fail();
  }
  const gated = missing.filter((f) => MODEL_SOURCES[f].gated);
  if (gated.length > 0 && !process.env.HF_TOKEN) {
    console.error(
      `\n${gated.join(", ")} is gated and HF_TOKEN is not set. Accept the licence at ` +
        `https://huggingface.co/${MODEL_SOURCES[gated[0]].repo}, create a read token at ` +
        "https://huggingface.co/settings/tokens, set HF_TOKEN, and run this again — " +
        "or add --skip for it to download everything else.",
    );
    fail();
  }
  if (conflicts.length > 0) {
    console.error(
      `\n${conflicts.length} file(s) on this machine have the right name and the wrong size — ` +
        "probably your own copies, an older or newer revision. Nothing has been downloaded.\n" +
        "To use the versions this app was made with, run again with --replace " +
        `${conflicts.map((c) => c.file).join(",")}. Each is downloaded into ${modelsDir}, which ` +
        "ComfyUI searches first; a copy of yours in that same folder is kept as <name>.old, and " +
        "copies elsewhere — another install's folders — are left exactly as they are.\n" +
        "To keep yours, --skip them instead; the workflows may not run with them.",
    );
    fail();
  }
  if (args.dryRun) return;

  for (const { file, from } of linkable) {
    const problem = linkInto(modelsDir, file, from);
    console.log(
      problem
        ? `  could not link ${file} (${problem}); it will be downloaded instead`
        : `  linked ${file} → ${from}`,
    );
    if (problem) missing.push(file);
  }
  if (missing.length === 0) {
    console.log("\nAll files in place. Restart ComfyUI if it was running, then run pnpm check:nodes.");
    return;
  }

  const failures: string[] = [];
  for (const [i, file] of missing.entries()) {
    console.log(`\n[${i + 1}/${missing.length}] ${file}`);
    try {
      await download(modelsDir, file);
      console.log("    done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    FAILED: ${message}`);
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed: ${failures.join(", ")}. Run the same command again to retry.`);
    process.exit(1);
  }
  console.log("\nAll files in place. Restart ComfyUI if it was running, then run pnpm check:nodes.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
