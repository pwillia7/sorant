"use client";

import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * A help text as the field shows it: a line under the control, and the rest a
 * click away.
 *
 * Every control used to carry its whole help, two to five lines of it, which
 * put more words in the sidebar than controls — 643 of them on Reference to
 * Video — and buried the controls among their explanations. The help itself
 * is unchanged; what is shown first is its opening sentence, or the param's
 * own `hint` where that sentence does not stand alone.
 *
 * A help that opens "Optional." says so as a tag beside the label instead,
 * which is where someone scanning for what they must fill in looks.
 */
export function splitHelp(
  help: string | undefined,
  hint: string | undefined,
): { optional: boolean; short: string; more: string | null } {
  let text = (help ?? "").trim();
  const optional = /^Optional[.:]\s/.test(text) || text === "Optional.";
  if (optional) text = text.replace(/^Optional[.:]\s*/, "");
  if (!text) return { optional, short: hint ?? "", more: null };
  if (hint) return { optional, short: hint, more: text === hint ? null : text };
  if (text.length <= 110) return { optional, short: text, more: null };
  // The first sentence: a full stop before a capital, a digit or an opening
  // mark, so "e.g." and "0.5 MP" do not end it.
  const first = text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(<])/)[0];
  return { optional, short: first, more: first === text ? null : text };
}

/**
 * Label + control + help/error, with the label wired to the control by id so
 * clicking it focuses the input and screen readers announce the pairing.
 */
export function Field({
  id,
  label,
  help,
  hint,
  note,
  error,
  trailing,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  /** See `splitHelp`. */
  hint?: string;
  /**
   * A consequence of the current value, shown under the help rather than in
   * place of it — the help says what the control is for at every setting, and
   * this says what this setting additionally does. Marked out by colour because
   * its appearing is the information; a line that read like the help would just
   * look as though the help had grown.
   */
  note?: string;
  error?: string;
  /** Sits opposite the label, typically the live value of a slider. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { optional, short, more } = splitHelp(help, hint);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <label
            htmlFor={id}
            className="text-[13px] font-medium tracking-[-0.01em] text-fg"
          >
            {label}
          </label>
          {optional ? (
            <span className="text-[11px] text-fg-subtle">Optional</span>
          ) : null}
          {more ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls={`${id}-more`}
              aria-label={open ? `Less about ${label}` : `More about ${label}`}
              title={open ? "Less" : "More about this"}
              className={`grid size-5 shrink-0 place-items-center rounded-full transition-colors
                ${open ? "text-accent" : "text-fg-subtle hover:text-fg"}`}
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {trailing}
      </div>

      {/*
        The control wires its own aria-describedby to the ids below — each input
        component takes it as a prop. This wrapper only renders the messages.
      */}
      {children}

      {error ? (
        <p id={`${id}-error`} className="text-[12px] leading-snug text-danger">
          {error}
        </p>
      ) : open && more ? (
        <p
          id={`${id}-help`}
          className="rounded-r-md border-l-2 border-accent bg-bg-subtle px-3 py-2
            text-[12px] leading-relaxed text-fg-muted"
        >
          <span id={`${id}-more`}>{more}</span>
        </p>
      ) : short ? (
        <p id={`${id}-help`} className="text-[12px] leading-snug text-fg-subtle">
          {short}
        </p>
      ) : null}

      {/*
        Outside the error/help chain: a note is about the value rather than
        about the control, so it stands whether or not the field is also
        explaining or complaining.
      */}
      {note ? (
        <p
          id={`${id}-note`}
          className="flex items-baseline gap-1.5 text-[12px] leading-snug text-fg-muted"
        >
          <span
            aria-hidden="true"
            className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-accent"
          />
          {note}
        </p>
      ) : null}
    </div>
  );
}
