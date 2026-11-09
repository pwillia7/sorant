"use client";

import { ArrowUp, AudioLines, BookOpen, Film, ImageIcon, Plus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Spinner } from "@/components/ui/button";
import { splitHelp } from "@/components/ui/field";
import type { ClientParam, ParamValue } from "@/lib/workflows/types";

export interface Attachment {
  param: ClientParam;
  set: boolean;
  required: boolean;
}

const KIND_ICON = { image: ImageIcon, video: Film, audio: AudioLines } as const;

/**
 * The composer, floating over the foot of the gallery: the prompt, what is
 * attached, what it will run as, and the button. Everything else about a run
 * is one press away in the settings panel — the dock carries the parts that
 * change every time.
 *
 * Attachments are chips rather than drop zones: each says whether it is
 * filled, and pressing one opens the settings at that field, where the
 * uploader, camera and editor already are. A required one that is empty is
 * drawn in the accent, so what is missing is visible before Generate refuses.
 */
export function Dock({
  menu,
  prompt,
  promptValue,
  onPromptChange,
  promptError,
  attachments,
  summary,
  onOpenSettings,
  settingsOpen,
  notice,
  onSubmit,
  submitLabel,
  busy,
  disabled,
  description,
  onOpenGuide,
}: {
  /** The workflow menu button. */
  menu: ReactNode;
  /** The workflow's prompt control, when it has one. */
  prompt?: ClientParam;
  promptValue: ParamValue | undefined;
  onPromptChange: (value: string) => void;
  promptError?: string;
  attachments: Attachment[];
  /** One line: what Generate will run. */
  summary: string;
  /** Opens the settings, at a field where one is named. */
  onOpenSettings: (fieldId?: string) => void;
  settingsOpen: boolean;
  /** Above the dock: how a hand-off filled it in, or why a run was refused. */
  notice?: ReactNode;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  disabled: boolean;
  /** Shown in place of a prompt box on a workflow that takes none. */
  description?: string;
  /** Opens the workflow's guide, where it has one. */
  onOpenGuide?: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);

  // "/" from anywhere puts the cursor in the prompt, as a search box would.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (!box.current) return;
      event.preventDefault();
      box.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const placeholder =
    prompt && "placeholder" in prompt && prompt.placeholder ? prompt.placeholder : "Describe the shot…";
  const maxLength = prompt && "maxLength" in prompt ? prompt.maxLength : undefined;
  // What the box is for, said where it is typed into. The field moved here
  // from the settings panel, and its help with it — on Character swap the box
  // is who to find in the clip, not a description of the result, and nothing
  // on screen said so.
  const hint = prompt ? splitHelp(prompt.help, prompt.hint).short : "";

  const guide = onOpenGuide ? (
    <button
      type="button"
      onClick={onOpenGuide}
      title="How to use this workflow"
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-fg-subtle
        transition-colors hover:bg-surface-hover hover:text-fg"
    >
      <BookOpen aria-hidden="true" className="size-3.5" />
      Guide
    </button>
  ) : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-6 sm:pb-5"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-auto mx-auto w-full max-w-3xl">
        {notice ? <div className="mb-2">{notice}</div> : null}

        <div
          className="rounded-2xl border border-border-strong bg-raised/95 shadow-md backdrop-blur-md
            focus-within:border-fg-subtle"
        >
          {prompt ? (
            <>
              <div className="flex items-center gap-2 px-4 pt-2.5">
                <p className="min-w-0 flex-1 truncate text-[11px] leading-6 text-fg-subtle" title={hint || undefined}>
                  <label htmlFor="dock-prompt" className="font-semibold text-fg-muted">
                    {prompt.label}
                  </label>
                  {hint ? <span id="dock-prompt-hint"> · {hint}</span> : null}
                </p>
                {guide}
              </div>
              <textarea
                ref={box}
                id="dock-prompt"
                value={typeof promptValue === "string" ? promptValue : ""}
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder={placeholder}
                maxLength={maxLength}
                rows={1}
                aria-invalid={promptError ? true : undefined}
                aria-describedby={promptError ? "dock-prompt-error" : hint ? "dock-prompt-hint" : undefined}
                className="block max-h-[34vh] min-h-[2.75rem] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-0.5
                  text-[15px] leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none [field-sizing:content]"
              />
              {promptError ? (
                <p id="dock-prompt-error" className="px-4 pb-1 text-[12px] text-danger">
                  {promptError}
                </p>
              ) : null}
            </>
          ) : description ? (
            <div className="flex items-start gap-2 px-4 pb-1 pt-3">
              <p className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-fg-muted">{description}</p>
              {guide}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
            {menu}

            {attachments.map(({ param, set, required }) => {
              const Icon = KIND_ICON[param.type as keyof typeof KIND_ICON] ?? Plus;
              return (
                <button
                  key={param.id}
                  type="button"
                  onClick={() => onOpenSettings(param.id)}
                  title={set ? `${param.label}: attached — change it in the settings` : `Add ${param.label.toLowerCase()}`}
                  className={`flex h-9 max-w-[12rem] items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors
                    ${
                      set
                        ? "border-border-strong bg-surface text-fg hover:bg-surface-hover"
                        : required
                          ? "border-dashed border-accent text-accent hover:bg-accent-subtle"
                          : "border-dashed border-border-strong text-fg-muted hover:bg-surface-hover hover:text-fg"
                    }`}
                >
                  {set ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : <Plus aria-hidden="true" className="size-3.5 shrink-0" />}
                  <span className="truncate">{param.label}</span>
                  {set ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" /> : null}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => onOpenSettings()}
              aria-expanded={settingsOpen}
              aria-controls="run-settings"
              title="All settings"
              className={`flex h-9 min-w-0 max-w-[15rem] shrink items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors
                ${settingsOpen ? "bg-accent-subtle text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg"}`}
            >
              <SlidersHorizontal aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="hidden truncate font-mono text-[11px] sm:inline">{summary || "Settings"}</span>
              <span className="sm:hidden">Settings</span>
            </button>

            <button
              type="button"
              onClick={onSubmit}
              disabled={disabled || busy}
              aria-busy={busy || undefined}
              title={`${submitLabel} (⌘↵)`}
              className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-accent pl-4 pr-3 text-[14px] font-semibold text-accent-fg
                shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <span>{submitLabel}</span>
              {busy ? <Spinner /> : <ArrowUp aria-hidden="true" className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The full settings for the workflow on the dock, sliding in from the right.
 * Not modal: the gallery stays usable beside it on a wide screen, and on a
 * phone it covers the page and closes back to it.
 */
export function SettingsPanel({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside
      ref={ref}
      id="run-settings"
      aria-label="Settings"
      inert={!open}
      className={`fixed bottom-0 right-0 top-12 z-40 flex w-full flex-col border-l border-border-strong bg-surface shadow-md
        transition-transform duration-300 ease-out sm:w-[440px]
        ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border-default px-5 py-4">
        <div className="min-w-0 flex-1">{title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="grid size-8 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-10 pt-5">{children}</div>
    </aside>
  );
}
