"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Control } from "@/components/param-form";
import { Button, Spinner } from "@/components/ui/button";
import { CONTROL_BASE } from "@/components/ui/inputs";
import { Modal } from "@/components/ui/modal";
import { api, ApiError } from "@/lib/client";
import {
  IMAGE_EDIT_DEFAULTS,
  IMAGE_EDIT_SETTINGS,
} from "@/lib/workflows/image-edit-settings";
import type { ParamValue } from "@/lib/workflows/types";

/** Must match the graph's id in src/lib/workflows/image-edit.ts. */
const WORKFLOW_ID = "image-edit";
const POLL_MS = 1000;
/**
 * Polls that find the prompt in neither the queue nor the history before the
 * edit is given up on. A just-queued prompt can miss both for a moment; this
 * long means ComfyUI restarted and forgot it.
 */
const UNKNOWN_GRACE = 20;
/**
 * The edit settings, one set for the whole app: they describe how Kontext
 * should draw, which is a taste rather than a fact about any one slot.
 */
const SETTINGS_KEY = "sorant-edit-settings";

/**
 * The stored settings, minus anything no longer declared or no longer the
 * declared type — a renamed control must not send a stale value under an id
 * the graph has stopped reading. Storage can be missing or throw (a private
 * window, blocked site data); the defaults are a complete answer either way.
 */
function loadSettings(): Record<string, ParamValue> {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const settings = { ...IMAGE_EDIT_DEFAULTS };
    for (const param of IMAGE_EDIT_SETTINGS) {
      const value = raw?.[param.id];
      if (typeof value === typeof param.default) settings[param.id] = value;
    }
    return settings;
  } catch {
    return { ...IMAGE_EDIT_DEFAULTS };
  }
}

function saveSettings(settings: Record<string, ParamValue>) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Kept for this session only. Nothing to tell anyone.
  }
}

interface StatusPayload {
  state: "queued" | "running" | "done" | "error" | "unknown";
  outputs: Array<{ filename: string; subfolder?: string; type: string }>;
  error?: string;
}

/**
 * What the status line says. Kept apart from the run itself (`job` below):
 * the poll belongs to the prompt for as long as it lives, and the status moving
 * on to "saving" must not be what stops it.
 */
type Stage = "idle" | "starting" | "waiting" | "editing" | "saving";

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError || cause instanceof Error
    ? cause.message
    : fallback;
}

/**
 * The sentence box under a picture, and the run it starts.
 *
 * An edit is the image-edit graph queued ahead of anything pending, polled
 * like any other run, then copied into ComfyUI's input directory by the same
 * route the clip hand-offs use — so what comes back is a reference a LoadImage
 * node can read, ready to drop into the slot the picture came from.
 */
export function ImageEditBar({
  id,
  source,
  onEdited,
  onBusyChange,
  onClose,
}: {
  id: string;
  /** The reference being edited — whatever the slot holds right now. */
  source: string;
  /** The edited picture's reference. */
  onEdited: (ref: string) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [instruction, setInstruction] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [job, setJob] = useState<{ promptId: string; startedAt: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The last edit that finished, so another take of it is one click. */
  const [last, setLast] = useState<{ source: string; instruction: string } | null>(
    null,
  );
  // Defaults on the first render, stored values straight after: the server
  // render has no storage, and the two must agree for hydration.
  const [settings, setSettings] = useState(IMAGE_EDIT_DEFAULTS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => setSettings(loadSettings()), []);
  const tuned = IMAGE_EDIT_SETTINGS.some(
    (param) => settings[param.id] !== param.default,
  );
  const changeSetting = (id: string, value: ParamValue) => {
    setSettings((current) => {
      const next = { ...current, [id]: value };
      saveSettings(next);
      return next;
    });
  };
  // Read through a ref so the poll below does not restart whenever the parent
  // renders a new callback.
  const onEditedRef = useRef(onEdited);
  useEffect(() => {
    onEditedRef.current = onEdited;
  }, [onEdited]);

  const busy = stage !== "idle";
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => inputRef.current?.focus(), []);

  // The elapsed counter. Only while a run is going: a second's tick is all it
  // needs, and nothing at all when idle.
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);

  const promptId = job?.promptId ?? null;

  useEffect(() => {
    if (!promptId) return;
    let stopped = false;
    let unknown = 0;

    const finish = (message: string | null) => {
      if (stopped) return;
      setJob(null);
      setStage("idle");
      setError(message);
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const status = await api<StatusPayload>(
          `/api/status?${new URLSearchParams({ promptId })}`,
        );
        if (stopped) return;

        if (status.state === "done") {
          const output = status.outputs[0];
          if (!output) return finish("The edit finished without a picture.");
          setStage("saving");
          const { ref } = await api<{ ref: string }>("/api/remix", {
            method: "POST",
            body: JSON.stringify({
              filename: output.filename,
              subfolder: output.subfolder ?? "",
              type: output.type,
            }),
          });
          if (stopped) return;
          onEditedRef.current(ref);
          setInstruction("");
          return finish(null);
        }
        if (status.state === "error") {
          return finish(status.error ?? "The edit failed.");
        }
        if (status.state === "unknown" && ++unknown > UNKNOWN_GRACE) {
          return finish("ComfyUI lost track of the edit. Try again.");
        }
        // Queued means something was already rendering when this arrived: it
        // went in at the front, so the only thing ahead of it is that run.
        setStage(status.state === "queued" ? "waiting" : "editing");
        setTimeout(poll, POLL_MS);
      } catch (cause) {
        finish(messageOf(cause, "Lost touch with the server during the edit."));
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }, [promptId]);

  const run = async (from: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError(null);
    setStage("starting");
    setLast({ source: from, instruction: trimmed });
    try {
      const { promptId: queued } = await api<{ promptId: string }>(
        "/api/generate",
        {
          method: "POST",
          body: JSON.stringify({
            workflowId: WORKFLOW_ID,
            params: {
              ...settings,
              image: from,
              instruction: trimmed,
              seed: -1,
            },
          }),
        },
      );
      const startedAt = Date.now();
      setNow(startedAt);
      setStage("editing");
      setJob({ promptId: queued, startedAt });
    } catch (cause) {
      setStage("idle");
      setError(messageOf(cause, "Could not start the edit."));
    }
  };

  const cancel = async () => {
    if (!promptId) return;
    // Back to idle straight away: the poll stops with the job, and whether
    // the cancel reached ComfyUI or not, nothing will be written to the slot.
    setJob(null);
    setStage("idle");
    await api("/api/cancel", {
      method: "POST",
      body: JSON.stringify({ promptId }),
    }).catch(() => undefined);
  };

  const seconds = job
    ? Math.max(0, Math.round((now - job.startedAt) / 1000))
    : 0;

  return (
    <div className="flex flex-col gap-2 border-t border-border-default px-3 py-2.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={instruction}
          maxLength={1000}
          disabled={busy}
          placeholder="What should change? e.g. dress them as a clown"
          aria-label="What should change in this picture"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            // Enter, not a <form>: this sits inside the param form, and a form
            // cannot nest in another.
            if (event.key === "Enter") {
              event.preventDefault();
              void run(source, instruction);
            } else if (event.key === "Escape" && !busy) {
              onClose();
            }
          }}
          className={`${CONTROL_BASE} h-8 min-w-0 flex-1 px-2.5 text-[13px]`}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !instruction.trim()}
          onClick={() => void run(source, instruction)}
        >
          Apply
        </Button>
        <Button
          variant="quiet"
          size="sm"
          aria-label={tuned ? "Edit settings (changed)" : "Edit settings"}
          title="Edit settings"
          disabled={busy}
          onClick={() => setSettingsOpen(true)}
          className="relative"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {tuned ? (
            <span
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent"
              aria-hidden="true"
            />
          ) : null}
        </Button>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Close editing"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          ✕
        </Button>
      </div>

      {stage === "waiting" || stage === "editing" ? (
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Spinner className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1" aria-live="polite">
            {stage === "waiting"
              ? `Waiting for the video that is rendering to finish — your edit is next. ${seconds}s`
              : `Editing… ${seconds}s — usually about a minute`}
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
          <span className="min-w-0 flex-1 truncate">“{last.instruction}”</span>
          <Button
            variant="quiet"
            size="xs"
            title="The same change again, from the same picture, with new noise"
            onClick={() => void run(last.source, last.instruction)}
          >
            Another take
          </Button>
        </div>
      ) : (
        <p className="text-[12px] leading-snug text-fg-subtle">
          Say it plainly — “give him a cowboy hat”, “make the car have wings”.
          Each edit starts from the picture shown.
        </p>
      )}

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Edit settings"
        subtitle="How FLUX Kontext redraws the picture. Kept for every edit."
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="quiet"
              size="sm"
              disabled={!tuned}
              onClick={() => {
                setSettings({ ...IMAGE_EDIT_DEFAULTS });
                saveSettings(IMAGE_EDIT_DEFAULTS);
              }}
            >
              Reset to defaults
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setSettingsOpen(false)}
            >
              Done
            </Button>
          </div>
        }
      >
        {IMAGE_EDIT_SETTINGS.map((param) => (
          <Control
            key={param.id}
            param={param}
            value={settings[param.id]}
            onChange={changeSetting}
            idPrefix={id}
          />
        ))}
      </Modal>
    </div>
  );
}
