"use client";

import { Segmented, Slider } from "@/components/ui/inputs";
import type { ClientTurbo } from "@/lib/workflows/turbo";

/**
 * Standard or Turbo for the workflow on screen.
 *
 * A segmented control rather than the on/off Toggle the params use, because
 * neither position is the absence of the other: both are a way to run this
 * graph, and naming them both is what says so. It sits above the form rather
 * than inside the Sampling group because it moves the step range that group
 * shows, and a control cannot sensibly live inside what it reconfigures.
 *
 * That is also why it stayed out here when the other run modes folded away into
 * ModelOptions: those change how the model is run without changing what any
 * control means, and this one does not.
 *
 * The LoRA's strength sits under it, shown only while Turbo is on, for the
 * reason a content LoRA's strength sits under its switch: off, there is no
 * LoRA node for the number to be about.
 */
export function TurboSwitch({
  turbo,
  on,
  onChange,
  strength,
  onStrengthChange,
}: {
  turbo: ClientTurbo;
  on: boolean;
  onChange: (on: boolean) => void;
  /** The stored strength, or undefined for the declared default. */
  strength: number | undefined;
  onStrengthChange: (value: number) => void;
}) {
  const strengthSpec = on ? turbo.strength : undefined;
  const strengthValue = strengthSpec
    ? Math.min(
        strengthSpec.max,
        Math.max(strengthSpec.min, strength ?? strengthSpec.default),
      )
    : 0;

  return (
    <div className="mb-6 rounded-lg border border-border-default bg-bg-subtle p-3">
      <div className="flex items-center gap-3">
        <span
          className="text-[12px] font-semibold text-fg-subtle"
          id="turbo-switch-label"
        >
          Speed
        </span>

        <Segmented
          labelledBy="turbo-switch-label"
          describedBy="turbo-switch-help"
          className="ml-auto"
          value={on}
          onChange={onChange}
          options={[
            { label: "Standard", value: false },
            { label: "Turbo", value: true },
          ]}
        />
      </div>

      <p
        id="turbo-switch-help"
        className="mt-2 text-[12px] leading-relaxed text-fg-muted"
      >
        {turbo.help}
      </p>

      {strengthSpec ? (
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <label
              htmlFor="turbo-strength"
              className="text-[12px] text-fg-muted"
            >
              {strengthSpec.label}
            </label>
            <span className="ml-auto tabular-nums text-[12px] text-fg">
              {strengthValue.toFixed(2)}
            </span>
          </div>
          <div className="mt-2">
            <Slider
              id="turbo-strength"
              value={strengthValue}
              onChange={onStrengthChange}
              min={strengthSpec.min}
              max={strengthSpec.max}
              step={strengthSpec.step}
              describedBy="turbo-strength-help"
            />
          </div>
          <p
            id="turbo-strength-help"
            className="mt-2 text-[12px] leading-relaxed text-fg-muted"
          >
            {strengthSpec.help}
          </p>
        </div>
      ) : null}
    </div>
  );
}
