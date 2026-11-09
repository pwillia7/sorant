"use client";

import { ChevronRight, Dices, Pin } from "lucide-react";
import { useMemo, useState } from "react";
import { AudioUpload } from "@/components/ui/audio-upload";
import { BoxPicker, inputVideoUrl } from "@/components/ui/box-picker";
import { MaskCheck } from "@/components/ui/mask-check";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ImageUpload } from "@/components/ui/image-upload";
import {
  NumberInput,
  Select,
  Slider,
  TextArea,
  TextInput,
  Toggle,
} from "@/components/ui/inputs";
import { VideoUpload } from "@/components/ui/video-upload";
import {
  paramVisible,
  pinnedValue,
  type ClientParam,
  type ParamValue,
} from "@/lib/workflows/types";

const DEFAULT_GROUP = "Settings";

/**
 * The order groups are shown in, whatever order a workflow declares them:
 * the thing the workflow works on, then what to make of it, then what comes
 * out. A workflow file is ordered by its graph — Reference to Video declared
 * its references first, which put the prompt two and a half screens down.
 * Groups not named here keep their declared order, after these.
 */
const GROUP_ORDER = ["Source", "Image", "Song", "Prompt", "Video", "References", "Voices", "Output"];
const groupRank = (group: string) => {
  const at = GROUP_ORDER.indexOf(group);
  return at === -1 ? GROUP_ORDER.length : at;
};

export function ParamForm({
  params,
  values,
  onChange,
  disabled,
  fieldError,
}: {
  params: ClientParam[];
  values: Record<string, ParamValue>;
  onChange: (id: string, value: ParamValue) => void;
  disabled?: boolean;
  /** Server-side validation error keyed to a param id. */
  fieldError?: { field?: string; message: string } | null;
}) {
  /**
   * Which groups have their advanced params showing, keyed by group name.
   *
   * Per group rather than one switch for the form, because the disclosure now
   * sits inside the group it belongs to. It used to sit under the whole form,
   * which read as a control that did nothing: the only advanced param in the
   * app is in References, near the top of the reference workflow, so pressing a
   * button at the bottom of the panel revealed a control off-screen above it.
   */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Preserve declaration order of both groups and params within them.
  //
  // A `measured`, `carried` or `written` param is dropped here rather than rendered as
  // nothing: it has no control, and leaving it in would let a group that holds
  // only those draw an empty heading.
  const groups = useMemo(() => {
    const ordered = new Map<string, ClientParam[]>();
    for (const param of params) {
      if (param.type === "measured" || param.type === "carried" || param.type === "written") {
        continue;
      }
      const key = param.group ?? DEFAULT_GROUP;
      const existing = ordered.get(key);
      if (existing) existing.push(param);
      else ordered.set(key, [param]);
    }
    // Stable: groups of one rank keep their declared order.
    return [...ordered.entries()].sort(([a], [b]) => groupRank(a) - groupRank(b));
  }, [params]);

  return (
    <div className="flex flex-col gap-7">
      {groups.map(([group, groupParams]) => {
        const open = openGroups[group] ?? false;
        // A control still waiting on another one is not advanced — it is not
        // available yet — so it is filtered out before the disclosure counts
        // what it has to reveal.
        const shown = groupParams.filter((param) => paramVisible(param, values));
        const advanced = shown.filter((param) => param.advanced);
        const visible = shown.filter((param) => open || !param.advanced);
        // Nothing at all to show, rather than nothing until the disclosure is
        // opened: a group of only advanced controls still draws its heading
        // and the disclosure, or there is no way to reach them.
        if (shown.length === 0) return null;

        return (
          // min-w-0 restates the globals.css rule at the call site: fieldset's
          // UA min-inline-size:min-content otherwise stops the whole group
          // shrinking around wide content.
          <fieldset
            key={group}
            className="flex min-w-0 flex-col gap-4"
            disabled={disabled}
          >
            {/* No heading over a group that opens on a control of the same
                name — "Prompt" above "Prompt" says it twice. Still a legend
                for the fieldset, for screen readers. */}
            <legend
              className={
                visible[0]?.label === group
                  ? "sr-only"
                  : "label-caps mb-1 text-fg-subtle"
              }
            >
              {group}
            </legend>

            {visible.map((param) => (
              <Control
                key={param.id}
                param={param}
                value={values[param.id]}
                values={values}
                // Something else is holding this control at a value — see
                // `pinnedBy`. Resolved here rather than inside the control so
                // it reads the same submission `paramVisible` just did.
                pinned={pinnedValue(param, values)}
                onChange={onChange}
                disabled={disabled}
                error={
                  fieldError && fieldError.field === param.id
                    ? fieldError.message
                    : undefined
                }
              />
            ))}

            {/* Nothing to disclose, no disclosure. Only one group in the app
                has an advanced param, so on most workflows this never draws. */}
            {advanced.length > 0 ? (
              <Disclosure
                open={open}
                onToggle={() =>
                  setOpenGroups((previous) => ({
                    ...previous,
                    [group]: !open,
                  }))
                }
              >
                {open ? "Hide advanced" : "Advanced"}
              </Disclosure>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

/** A quiet show/hide control with a chevron that turns. */
export function Disclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="quiet"
      size="xs"
      /* relative because the label inside is `sr-only`, which is
         position:absolute. Absolute boxes resolve against the nearest
         positioned ancestor, and with none they land in the initial
         containing block — outside any scroll container they happen to be
         written in, where they extend the document rather than the column
         they belong to. Positioning the button keeps it contained. */
      className="relative self-start"
      aria-expanded={open}
      onClick={onToggle}
      icon={
        <ChevronRight className={`size-3 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`} aria-hidden="true" />
      }
    >
      {children}
    </Button>
  );
}

/**
 * One control, drawn from its param. Exported for the edit bar's settings,
 * which are params of a workflow that never gets a form of its own.
 */
export function Control({
  param,
  value: stored,
  pinned,
  onChange,
  disabled,
  error,
  idPrefix = "param",
  values,
}: {
  param: ClientParam;
  value: ParamValue | undefined;
  /** The rest of the form, for a control drawn on another's value — a box on the clip. */
  values?: Record<string, ParamValue>;
  /** The value this control is held at, if it is. See `pinnedBy`. */
  pinned?: ParamValue;
  onChange: (id: string, value: ParamValue) => void;
  disabled?: boolean;
  error?: string;
  /** Keeps element ids unique where the same param id is drawn twice. */
  idPrefix?: string;
}) {
  const id = `${idPrefix}-${param.id}`;

  /**
   * A pinned control shows what will run rather than what is stored, and cannot
   * be moved off it. The stored value is untouched underneath — removing
   * whatever pinned it brings the control back with that number in it, which is
   * why this substitutes rather than writing through `onChange`.
   */
  const locked = pinned !== undefined;
  const value = locked ? pinned : stored;
  const readOnly = disabled || locked;

  /**
   * The consequence of the value that is actually set, if this control has one
   * to declare — see `noteAt`. Compared loosely against the default so an
   * untouched control still reports it: `value` is undefined until something
   * writes it, and what the run would do is the same either way.
   *
   * A pin's own line wins, because it explains both the number and why the
   * control is not taking input — which the value's note, on its own, would
   * leave looking like a control that had stopped working.
   */
  const note = locked
    ? param.pinnedBy?.note
    : param.noteAt && (value ?? param.default) === param.noteAt.value
      ? param.noteAt.text
      : undefined;

  const describedBy =
    [
      error ? `${id}-error` : param.help ? `${id}-help` : null,
      note ? `${id}-note` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  switch (param.type) {
    case "text":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <TextInput
            id={id}
            value={String(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            placeholder={param.placeholder}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );

    case "textarea":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <TextArea
            id={id}
            value={String(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            placeholder={param.placeholder}
            rows={param.rows}
            maxLength={param.maxLength}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );

    case "slider": {
      const current = Number(value ?? param.default);
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
          trailing={
            <span className="font-mono text-[12px] tabular-nums text-fg-muted">
              {current}
              {param.unit ? (
                <span className="ml-1 text-fg-subtle">{param.unit}</span>
              ) : null}
            </span>
          }
        >
          <Slider
            id={id}
            value={current}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    case "number":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
          trailing={
            param.unit ? (
              <span className="text-[12px] text-fg-subtle">{param.unit}</span>
            ) : undefined
          }
        >
          <NumberInput
            id={id}
            value={Number(value ?? param.default)}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );

    case "select": {
      // What the chosen option does, under the control: an option's own help
      // says something the label cannot, and a native dropdown has nowhere
      // to show it. A note from the workflow outranks it.
      const chosen = param.options.find(
        (option) => option.value === String(value ?? param.default),
      );
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note ?? chosen?.help}
          error={error}
        >
          <Select
            id={id}
            value={String(value ?? param.default)}
            options={param.options}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    case "toggle":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <Toggle
            id={id}
            checked={Boolean(value ?? param.default)}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );

    case "image":
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <ImageUpload
            id={id}
            label={param.label}
            compact={param.compact}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );

    case "video": {
      // Bound outside the closure so it stays narrowed to a string.
      const measures = param.measures;
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <VideoUpload
            id={id}
            label={param.label}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            onMeasure={
              measures ? (seconds) => onChange(measures, seconds) : undefined
            }
            minSeconds={param.minSeconds}
            maxSeconds={param.maxSeconds}
            longClipWarning={param.longClipWarning}
            warnOverSeconds={param.warnOverSeconds}
            maxShortEdge={param.maxShortEdge}
            maxLongEdge={param.maxLongEdge}
            budgetSeconds={param.budgetSeconds}
            compact={param.compact}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    case "audio": {
      // Bound outside the closure so it stays narrowed to a string, as in the
      // video case above.
      const measures = param.measures;
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
        >
          <AudioUpload
            id={id}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            onMeasure={
              measures ? (seconds) => onChange(measures, seconds) : undefined
            }
            noun={param.noun}
            limitNote={param.limitNote}
            compact={param.compact}
            disabled={readOnly}
            describedBy={describedBy}
          />
        </Field>
      );
    }

    case "box": {
      const clip = String(values?.[param.on] ?? "");
      if (!clip) return null;
      return (
        <Field id={id} label={param.label} help={param.help} hint={param.hint} note={note} error={error}>
          <BoxPicker
            src={inputVideoUrl(clip)}
            value={String(value ?? "")}
            onChange={(next) => onChange(param.id, next)}
            disabled={readOnly}
            label={`${param.label}: the clip's first frame`}
          />
          <div className="mt-2">
            <MaskCheck values={values ?? {}} disabled={readOnly} />
          </div>
        </Field>
      );
    }

    // Filled in by whichever control measures it — see `measures` on the video
    // param. Nothing to draw.
    case "measured":
    case "carried":
    case "written":
      return null;

    case "seed": {
      const current = Number(value ?? param.default);
      const isRandom = current < 0;
      // A real seed rather than 0 when one is fixed: 0 is as arbitrary as any
      // other, and pinning to it on every click made "fixed" mean "the same
      // number everyone gets".
      const roll = () => Math.floor(Math.random() * 2 ** 32);
      return (
        <Field
          id={id}
          label={param.label}
          help={param.help}
          hint={param.hint}
          note={note}
          error={error}
          trailing={
            <Button
              variant="quiet"
              size="xs"
              disabled={readOnly}
              icon={
                isRandom ? (
                  <Pin className="size-3.5" aria-hidden="true" />
                ) : (
                  <Dices className="size-3.5" aria-hidden="true" />
                )
              }
              onClick={() => onChange(param.id, isRandom ? roll() : -1)}
            >
              {isRandom ? "Fix a seed" : "Random each run"}
            </Button>
          }
        >
          {isRandom ? (
            <div
              className="flex h-10 items-center gap-2 rounded-md border border-dashed
                border-border-strong bg-bg-subtle px-3 text-[13px] text-fg-muted"
            >
              <Dices className="size-4 text-fg-subtle" aria-hidden="true" />
              A new seed each run
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <NumberInput
                  id={id}
                  value={current}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  onChange={(next) => onChange(param.id, next)}
                  disabled={readOnly}
                  describedBy={describedBy}
                />
              </div>
              <Button
                variant="secondary"
                size="icon-md"
                disabled={readOnly}
                onClick={() => onChange(param.id, roll())}
                title="Roll another fixed seed"
                aria-label="Roll another fixed seed"
                icon={<Dices className="size-4" aria-hidden="true" />}
              />
            </div>
          )}
        </Field>
      );
    }
  }
}
