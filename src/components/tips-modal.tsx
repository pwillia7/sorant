"use client";

import { Modal } from "@/components/ui/modal";
import type { WorkflowTips } from "@/lib/workflows/tips";

/**
 * A workflow's guide: how to use it, then the detail. Opened from the Guide
 * button in the prompt bar or the settings panel, never on its own — it is for
 * whoever goes looking, and the controls' own help covers the rest.
 *
 * The quick start comes first and is numbered: what to put where, in order.
 * Everything after it is reference, read when something did not come out as
 * expected. The credit is shown only where the advice has a source to credit.
 */
export function TipsModal({
  open,
  onClose,
  title,
  subtitle,
  tips,
}: {
  open: boolean;
  onClose: () => void;
  /** The workflow's name. */
  title: string;
  /** The workflow as it will run, with its switches. */
  subtitle?: string;
  tips: WorkflowTips;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`How to use ${title}`}
      subtitle={subtitle && subtitle !== title ? subtitle : undefined}
      footer={
        tips.source ? (
          <a
            href={tips.source.href}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-fg-subtle transition-colors hover:text-accent"
          >
            {tips.source.label}
          </a>
        ) : undefined
      }
    >
      {tips.quickStart?.length ? (
        <section className="rounded-lg border border-border-default bg-bg-subtle p-3.5">
          <h3 className="mb-2 text-[12px] font-semibold text-fg">Quick start</h3>
          <ol className="flex flex-col gap-1.5">
            {tips.quickStart.map((step, index) => (
              <li key={step} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-subtle font-mono text-[11px] text-fg"
                >
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {tips.sections.map((section) => (
        <section key={section.heading}>
          <h3 className="mb-2 text-[12px] font-semibold text-fg-subtle">{section.heading}</h3>
          <ul className="flex flex-col gap-2">
            {section.items.map((item) => (
              <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-subtle" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Modal>
  );
}
