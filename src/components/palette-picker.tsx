"use client";

import { Check, Palette as PaletteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_PALETTE, PALETTES } from "@/lib/palettes";

const STORAGE_KEY = "palette";

/**
 * The app's colours, chosen from a short list. Separate from the light/dark
 * toggle beside it: a palette is a light and a dark set, so either choice
 * works with every value of the other.
 *
 * Applied by stamping `data-palette` on <html>, which is what the CSS keys
 * on; the default stamps nothing, since bare :root already carries it. The
 * layout's pre-paint script reads the same key, so a reload does not flash
 * the default first.
 */
export function PalettePicker() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(DEFAULT_PALETTE);
  const root = useRef<HTMLDivElement>(null);

  // Read after mount: the server cannot know what this browser stored.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && PALETTES.some((palette) => palette.id === stored)) setCurrent(stored);
    } catch {
      // Storage blocked: the default stands.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (id: string) => {
    setCurrent(id);
    if (id === DEFAULT_PALETTE) delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Applies for this visit only.
    }
  };

  const name = PALETTES.find((palette) => palette.id === current)?.name ?? "Palette";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Colours: ${name}. Change`}
        title={`Colours: ${name}`}
        className="grid size-8 place-items-center rounded-md border border-border-default bg-surface text-fg-muted
          transition-colors duration-150 hover:border-border-strong hover:text-fg"
      >
        <PaletteIcon className="size-3.5" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="radiogroup"
          aria-label="Colours"
          className="absolute right-0 top-10 z-50 flex w-64 flex-col gap-0.5 rounded-xl border border-border-strong
            bg-raised p-1.5 shadow-md"
        >
          <p className="label-caps px-2 pb-1 pt-1.5 text-fg-subtle">Colours</p>
          {PALETTES.map((palette) => {
            const selected = palette.id === current;
            return (
              <button
                key={palette.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose(palette.id)}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors
                  ${selected ? "bg-accent-subtle" : "hover:bg-surface-hover"}`}
              >
                <span aria-hidden="true" className="flex h-6 w-10 shrink-0 overflow-hidden rounded border border-border-default">
                  {palette.swatches.map((color) => (
                    <span key={color} className="flex-1" style={{ background: color }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-fg">
                    {palette.name}
                    {palette.id === DEFAULT_PALETTE ? (
                      <span className="ml-1.5 text-[11px] font-normal text-fg-subtle">default</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-fg-muted">{palette.description}</span>
                </span>
                {selected ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
