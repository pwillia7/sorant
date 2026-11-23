import type { ComfyGraph } from "@/lib/comfy";
import type { ParamValue } from "./types";

/**
 * The script: lines the user has written out, said word for word.
 *
 * A quoted line in the prompt is a request. The director is told to keep the
 * user's words verbatim, and a capable one mostly does — but the local 27B,
 * handed a 24-word run-on, dropped two words and cut the sentence in half
 * across two `<d>` tags joined by "followed immediately by", and the take came
 * back with gibberish at the join (run 19e5ed84, 2026-11-23).
 *
 * So the words never pass through the director at all. It is shown the lines,
 * so it can stage and time them, but it writes a placeholder in each `<d>` —
 * `{{LINE_1}}` — and the graph swaps the user's exact text in afterwards, on
 * the way from the director to the video model. What the model reads is the
 * user's words whatever the director did with them, which no instruction can
 * promise.
 *
 * The swap is ComfyUI's core `RegexReplace`, one per line, chained. Static
 * rather than spliced per run: an unused one has its own placeholder as the
 * replacement and changes nothing, so the graph is the same shape on every run
 * and there is no `finalize` branch for a check to miss. Regex rather than
 * `StringReplace` so a director that writes `{{ line_1 }}` still matches.
 *
 * Client-safe: the form imports the parser and the counts for its meter.
 */

/** As many lines as a 15-second clip has any business holding. */
export const MAX_SCRIPT_LINES = 6;

/**
 * The numbers the meter warns at — the director's own dialogue budget, so the
 * form and the director agree. See `LENGTH_RULES` in minimax-common.ts for
 * where they come from.
 */
export const SCRIPT_WORDS_PER_15S = 20;
export const SCRIPT_WORDS_PER_LINE = 10;

export interface ScriptLine {
  /** Who says it, where the user wrote "Name: words". */
  speaker?: string;
  /** The words, exactly as typed, minus any quotes wrapped round the line. */
  words: string;
}

/**
 * One line per row. A short name before a colon is the speaker — "Gordon:
 * Hey there." — and anything longer, or with a quote in it, is part of the
 * line: "Note to self: buy milk" said by somebody is still a line.
 */
export function parseScript(text: string): ScriptLine[] {
  return text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const named = /^([^:"“”]{1,40}?)\s*:\s+(.+)$/.exec(row);
      const speaker = named && named[1].trim().split(/\s+/).length <= 4 ? named[1].trim() : undefined;
      const words = unquote(speaker ? named![2] : row);
      return speaker ? { speaker, words } : { words };
    })
    .filter((line) => line.words !== "");
}

/** Quotes round the whole line are how people write a line, not part of it. */
function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = /^["“'‘](.*)["”'’]$/.exec(trimmed);
  return (quoted ? quoted[1] : trimmed).trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** What the director writes inside the `<d>` tag in place of line `n`. */
export const scriptToken = (n: number): string => `{{LINE_${n}}}`;

/** Matches the token loosely — case, spaces, a missing underscore. */
const tokenPattern = (n: number): string => `\\{\\{\\s*LINE[\\s_]*${n}\\s*\\}\\}`;

/** The node that swaps line `n` in. */
export const scriptNodeId = (n: number): string => `lines:${n}`;

/**
 * Python's `re.sub` reads backslashes in the replacement as escapes and group
 * references, so a line with one in it would be mangled or refused.
 */
const literalReplacement = (text: string): string => text.replace(/\\/g, "\\\\");

/**
 * The chain of swaps, reading `source` — the director's output — and ending at
 * the node whose output the video model should read instead.
 */
export function scriptNodes(source: [string, number]): {
  nodes: ComfyGraph;
  output: [string, number];
} {
  const nodes: ComfyGraph = {};
  let from: [string, number] = source;
  for (let n = 1; n <= MAX_SCRIPT_LINES; n++) {
    nodes[scriptNodeId(n)] = {
      class_type: "RegexReplace",
      inputs: {
        string: from,
        regex_pattern: tokenPattern(n),
        // Unused, the placeholder replaces itself. Written per run by the
        // script param — see `scriptTargets`.
        replace: scriptToken(n),
        case_insensitive: true,
        multiline: false,
        dotall: false,
        count: 0,
      },
      _meta: { title: `Your line ${n}` },
    };
    from = [scriptNodeId(n), 0];
  }
  return { nodes, output: from };
}

/** The `replace` input of each swap, written from the script param. */
export function scriptTargets(param: string) {
  return Array.from({ length: MAX_SCRIPT_LINES }, (_, index) => {
    const n = index + 1;
    return {
      node: scriptNodeId(n),
      input: "replace",
      transform: (_value: ParamValue, values: Record<string, ParamValue>) => {
        const line = parseScript(String(values[param] ?? ""))[index];
        return line ? literalReplacement(line.words) : scriptToken(n);
      },
    };
  });
}

/**
 * The director's half: the lines, what to write instead of them, and the
 * rules that keep them whole. Empty with no script, so the director reads
 * exactly what it did before this existed.
 */
export function scriptDirectorBlock(
  values: Record<string, ParamValue>,
  param: string,
): string {
  const lines = parseScript(String(values[param] ?? "")).slice(0, MAX_SCRIPT_LINES);
  if (lines.length === 0) return "";

  const seconds = Number(values.duration ?? 10);
  const total = lines.reduce((sum, line) => sum + countWords(line.words), 0);
  const budget = Math.round((SCRIPT_WORDS_PER_15S * seconds) / 15);

  const listing = lines
    .map((line, index) => {
      const who = line.speaker ? `${line.speaker} says` : "Said";
      return `<d>[English] ${scriptToken(index + 1)}</d>   ← ${who}: ${line.words} (${countWords(line.words)} words)`;
    })
    .join("\n");

  const tight =
    total > budget
      ? `\n\nThat is ${total} words against a budget of about ${budget} for this length. The lines are fixed, so do not drop or shorten any of them to fit — give them the room instead: one shot or very few, little action that competes with the speech, short beats, and the first line starting within the first second.`
      : "";

  return `THE USER'S SCRIPT

The user has written out what is said in this video. These are its lines, in order, and they are everything anyone says in it. Each is shown as the exact <d> block you write for it, with what it stands for after the arrow:

${listing}

Copy each <d> block into detailed_description exactly as shown, placeholder and all — "${scriptToken(1)}", never the words themselves. The words after the arrow are there so you know what is said and can stage it; they never appear anywhere in your text. The app puts them into the placeholders afterwards, word for word, and a line you write out in full instead is a line it can no longer guarantee. Change only the language tag, where a line is not in English.

Only what is inside the tag changes. Everything outside it is written exactly as the rules above ask — the speaker, their speaker ID, how the line is delivered, and the voice reference it is spoken in wherever one belongs to that speaker — so a line with a referenced voice still names that voice on every line:

The man <Subject 1> (S1), his voice that of <Audio 1>, grinning into the phone, says warmly: <d>[English] ${scriptToken(1)}</d>

and one without a voice reference simply leaves that part out. Every placeholder appears exactly once, in order, each in its own <d> block with its own attribution. Where a line names no speaker, the user's prompt says who speaks; where it does not either, the line belongs to the person the scene is about. Where the user's prompt quotes the same words, these lines are that dialogue, not more of it.

Nobody says anything that is not in the script — no greeting, reaction or extra line of your own, whatever any rule above says about adding one. Do not repeat or paraphrase the words anywhere else either: not in the summary, the soundscape or the action.

Between two lines there is a beat — a breath, a nod, a glance — written as action. Never run two placeholders together in one sentence, and never join them with "followed immediately by" or "then continues". Shot cuts fall between lines, never across one. Time the scene to the word counts above.${tight}`;
}
