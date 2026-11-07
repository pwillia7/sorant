"use client";

import { ChevronDown } from "lucide-react";
import { useRef, type ChangeEvent, type ReactNode } from "react";

export const CONTROL_BASE = `w-full bg-raised border border-border-default rounded-md
  text-fg placeholder:text-fg-subtle transition-colors duration-150
  hover:border-border-strong focus:border-accent focus:outline-none
  focus:ring-1 focus:ring-accent disabled:opacity-50`;

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_BASE} h-9 px-3 text-[13px]`}
    />
  );
}

/** Same as TextInput but masked, and hinted to password managers. */
export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="password"
      autoComplete="current-password"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_BASE} h-9 px-3 text-[13px]`}
    />
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  describedBy,
  maxLength,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  describedBy?: string;
  maxLength?: number;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      /*
        The prompt boxes ask for 10-12 rows, which is reasonable on a desktop
        column and swallows a phone screen whole. Capping at half the viewport
        only bites on small screens — a 12-row box is well under 50vh on a
        laptop — so no breakpoint is needed.

        And it grows to fit what is in it, where the browser can
        (field-sizing), so a long prompt is read whole rather than through a
        three-line slot. Empty, it is three lines at most, whatever `rows` asks.
      */
      className={`${CONTROL_BASE} max-h-[50vh] resize-y overflow-y-auto px-3 py-2.5 text-[14px] leading-relaxed min-h-20
        [field-sizing:content]`}
      style={{ minHeight: `calc(${Math.min(rows, 3)} * 1.625em + 1.25rem)` }}
    />
  );
}

/**
 * Options in the order given, run together into the headings they declare.
 *
 * A native `optgroup` is the only division a `<select>` has, and it is the
 * right one here: the rewrite picker's headings say which models can be shown
 * the user's images, which is a thing about the run rather than a label on the
 * name. Options with no heading keep their place in the list and are rendered
 * bare, which is every other select in the app.
 *
 * Runs rather than buckets, so the grouping can never reorder the list — a
 * heading that appears twice renders twice, and the curation's own order is
 * what the user reads.
 */
function groupOptions<T extends { group?: string }>(
  options: T[],
): Array<[string | undefined, T[]]> {
  const runs: Array<[string | undefined, T[]]> = [];
  for (const option of options) {
    const last = runs[runs.length - 1];
    if (last && last[0] === option.group) last[1].push(option);
    else runs.push([option.group, [option]]);
  }
  return runs;
}

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; group?: string }>;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL_BASE} h-9 pl-3 pr-9 text-[13px] appearance-none cursor-pointer`}
      >
        {groupOptions(options).map(([heading, group]) =>
          heading === undefined ? (
            group.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          ) : (
            <optgroup key={heading} label={heading}>
              {group.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
    </div>
  );
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className={`${CONTROL_BASE} h-9 px-3 text-[13px] font-mono tabular-nums`}
    />
  );
}

export function Slider({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  describedBy,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  describedBy?: string;
}) {
  const handle = (event: ChangeEvent<HTMLInputElement>) =>
    onChange(Number(event.target.value));

  return (
    <input
      id={id}
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={handle}
    />
  );
}

export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-sm
        border transition-colors duration-200 disabled:opacity-50
        ${
          checked
            ? "bg-accent border-accent"
            : "bg-track border-border-strong hover:border-fg-subtle"
        }`}
    >
      <span
        className={`absolute h-3.5 w-3.5 rounded-[1px] shadow-sm transition-transform duration-200
          ${checked ? "translate-x-[18px] bg-accent-fg" : "translate-x-[2px] bg-fg-muted"}`}
      />
    </button>
  );
}

/**
 * A few mutually exclusive choices side by side: Speed, an upscale's size and
 * frame rate. One component so they cannot drift apart, with a radio group's
 * keyboard handling — Tab reaches the chosen one, the arrow keys move the
 * choice — which each copy of it lacked.
 */
export function Segmented<T extends string | number | boolean>({
  value,
  onChange,
  options,
  label,
  labelledBy,
  describedBy,
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>;
  /** The group's name, where nothing on screen labels it. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  className?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  // Focus goes with the choice, as in any radio group: left on the button
  // just unchosen, the next arrow press would count from the wrong place.
  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i += 1) {
      const at = (((from + step * i) % options.length) + options.length) % options.length;
      if (options[at].disabled) continue;
      onChange(options[at].value);
      buttons.current[at]?.focus();
      return;
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`flex rounded-md border border-border-default bg-bg-subtle p-0.5 ${className}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={`rounded-sm px-3 py-1 text-[12px] font-medium transition-colors duration-150
              disabled:cursor-not-allowed disabled:opacity-40
              ${selected ? "bg-raised text-fg shadow-sm ring-1 ring-border-strong" : "text-fg-subtle enabled:hover:text-fg"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
