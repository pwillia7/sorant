"use client";

import { useEffect, useRef, useState } from "react";
import { useRunDirector } from "@/components/run-director";
import { Button, Spinner } from "@/components/ui/button";
import { CONTROL_BASE } from "@/components/ui/inputs";
import { useToolRun } from "@/hooks/use-tool-run";
import { REFERENCE_PARAM } from "@/lib/workflows/reference-param";
import { REWRITE_MODEL } from "@/lib/workflows/rewrite-model";

/** Must match the graph's id in src/lib/workflows/minimax-h3-image.ts. */
const WORKFLOW_ID = "minimax-h3-image";
/**
 * Big enough for an Edit afterwards and for the video models, which read a
 * picture at about 1 MP; small enough to come back in about ten seconds.
 */
const REFERENCE_MEGAPIXELS = 2;
/** The shape last chosen, kept for the next picture in any slot. */
const SHAPE_KEY = "sorant-create-shape";

/**
 * The shapes offered, as Text to Image's aspect-ratio values. A short list:
 * this is a reference, not a print, and the full eight are a click away in
 * Text to Image itself.
 */
const SHAPES = [
  { value: "9:16 (Portrait Widescreen)", label: "9:16" },
  { value: "2:3 (Portrait Photo)", label: "2:3" },
  { value: "1:1 (Square)", label: "1:1" },
  { value: "3:2 (Photo)", label: "3:2" },
  { value: "16:9 (Widescreen)", label: "16:9" },
] as const;
const DEFAULT_SHAPE = SHAPES[0].value;

function loadShape(): string {
  try {
    const stored = localStorage.getItem(SHAPE_KEY);
    return SHAPES.some((shape) => shape.value === stored) && stored
      ? stored
      : DEFAULT_SHAPE;
  } catch {
    return DEFAULT_SHAPE;
  }
}

function saveShape(value: string) {
  try {
    localStorage.setItem(SHAPE_KEY, value);
  } catch {
    // Kept for this session only.
  }
}

/**
 * A description box on a picture control, and the Text to Image run it
 * starts: MiniMax H3 Image, through the app's director, queued ahead of
 * anything rendering, and dropped into the slot as if it had been uploaded.
 * For a reference that does not exist yet — a character, a place, a first
 * frame.
 */
export function ImageCreateBar({
  id,
  onCreated,
  onBusyChange,
  onClose,
}: {
  id: string;
  /** The new picture's reference. */
  onCreated: (ref: string) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState("");
  // The default on the first render, the stored one straight after: the
  // server render has no storage, and the two must agree for hydration.
  const [shape, setShape] = useState<string>(DEFAULT_SHAPE);
  useEffect(() => setShape(loadShape()), []);
  /** The last description that finished, so another take is one click. */
  const [last, setLast] = useState<{ description: string; shape: string } | null>(
    null,
  );
  const director = useRunDirector();

  const { stage, busy, error, seconds, start, cancel } = useToolRun({
    noun: "picture",
    onDone: onCreated,
  });
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => inputRef.current?.focus(), []);

  const run = async (text: string, aspect: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setLast({ description: trimmed, shape: aspect });
    await start({
      workflowId: WORKFLOW_ID,
      params: {
        prompt: trimmed,
        aspect_ratio: aspect,
        megapixels: REFERENCE_MEGAPIXELS,
        seed: -1,
        [REFERENCE_PARAM]: true,
        // The gateway model only where the rewrite runs on the gateway, as a
        // run from the form sends it — see use-jobs.ts.
        ...(director.rewriteModel && !director.localDirector
          ? { [REWRITE_MODEL]: director.rewriteModel }
          : {}),
      },
      ...(director.localDirector
        ? { director: "local", localDirector: director.localDirector }
        : {}),
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={description}
          maxLength={1000}
          disabled={busy}
          placeholder="Describe it, e.g. a red-haired detective in a trench coat"
          aria-label="Describe the picture to create"
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            // Enter, not a <form>: this sits inside the param form, and a form
            // cannot nest in another.
            if (event.key === "Enter") {
              event.preventDefault();
              void run(description, shape);
            } else if (event.key === "Escape" && !busy) {
              onClose();
            }
          }}
          className={`${CONTROL_BASE} h-8 min-w-0 flex-1 px-2.5 text-[13px]`}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !description.trim()}
          onClick={() => void run(description, shape)}
        >
          Create
        </Button>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Close"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          ✕
        </Button>
      </div>

      <div
        className="flex flex-wrap items-center gap-1"
        role="radiogroup"
        aria-label="Shape"
      >
        <span className="mr-1 text-[11px] text-fg-subtle">Shape</span>
        {SHAPES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={shape === option.value}
            disabled={busy}
            onClick={() => {
              setShape(option.value);
              saveShape(option.value);
            }}
            className={`rounded border px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors
              disabled:opacity-50 ${
                shape === option.value
                  ? "border-accent bg-accent-subtle text-fg"
                  : "border-border-default text-fg-muted hover:border-border-strong"
              }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {stage === "waiting" || stage === "working" ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Spinner className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1" aria-live="polite">
            {stage === "waiting"
              ? `Waiting for the video that is rendering to finish — your picture is next. ${seconds}s`
              : `Creating… ${seconds}s — usually under a minute`}
          </span>
          <Button variant="quiet" size="xs" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      ) : stage === "saving" || stage === "starting" ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Spinner className="size-3.5 shrink-0" />
          <span>{stage === "saving" ? "Almost done…" : "Starting…"}</span>
        </div>
      ) : error ? (
        <p className="text-[12px] leading-snug text-danger">{error}</p>
      ) : last ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-subtle">
          <span className="min-w-0 flex-1 truncate">“{last.description}”</span>
          <Button
            variant="quiet"
            size="xs"
            title="The same description again, with new noise"
            onClick={() => void run(last.description, last.shape)}
          >
            Another take
          </Button>
        </div>
      ) : (
        <p className="text-[12px] leading-snug text-fg-subtle">
          One line is enough — a director fills in the detail. Made with MiniMax
          H3 Image, the same as Text to Image.
        </p>
      )}
    </div>
  );
}
