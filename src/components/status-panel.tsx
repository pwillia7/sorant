"use client";

import type { Health } from "@/components/connection-pill";
import { useState } from "react";
import { updateWhere, type Updates } from "@/components/update-badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Dot } from "@/components/ui/panel";
import type { CompatReport } from "@/lib/compat";
import { COMFY_TESTED, comfyVersionStatus, olderComfyMessage } from "@/lib/comfy-version";
import type { WorkflowSummary } from "@/lib/workflows/types";

const UPDATING =
  "https://github.com/pwillia7/sorant/blob/main/README.md#updating";

/** The same prompt as the README's, for any coding agent. */
const AGENT_PROMPT =
  "Update Soran't to the latest release by following the \"Updating an existing install\" section of docs/agent-setup.md. Work out first whether it needs changes on my ComfyUI machine, and ask me before restarting ComfyUI or deploying.";

/**
 * Everything the header pill knows, opened from it: the ComfyUI connection,
 * whether that machine has what the workflows need, and this app's version
 * with a way to check for a newer one. A panel rather than the tooltip it
 * replaces, because a tooltip is invisible on a phone — and a version number
 * is something people go looking for only when they need it.
 */
export function StatusPanel({
  open,
  onClose,
  health,
  compat,
  updates,
  workflows,
}: {
  open: boolean;
  onClose: () => void;
  health: Health | null;
  compat: CompatReport | null;
  updates: Updates;
  workflows: WorkflowSummary[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="Status">
      <Section title="ComfyUI">
        <ComfyStatus health={health} />
      </Section>
      <Section title="Your ComfyUI machine">
        <MachineStatus compat={compat} health={health} workflows={workflows} />
      </Section>
      <Section title="Soran’t">
        <VersionStatus updates={updates} />
      </Section>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[12px] font-semibold text-fg-subtle">
        {title}
      </h3>
      <div className="mt-2 text-[13px] leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}

function Row({ tone, children }: { tone: "success" | "warning" | "danger" | "neutral" | "accent"; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2">
      <Dot tone={tone} />
      <span className="text-fg">{children}</span>
    </p>
  );
}

function ComfyStatus({ health }: { health: Health | null }) {
  if (!health) return <Row tone="neutral">Checking…</Row>;
  if (health.configured === false) return <Row tone="danger">Not set up: COMFY_URL is missing.</Row>;
  if (!health.reachable) return <Row tone="danger">Can’t reach ComfyUI.</Row>;
  if (health.authorized === false) return <Row tone="danger">ComfyUI refused this app’s token.</Row>;

  const busy = (health.queueRunning ?? 0) > 0;
  const versionStatus = comfyVersionStatus(health.comfyuiVersion);
  const details = [
    health.comfyuiVersion ? `ComfyUI ${health.comfyuiVersion}` : null,
    health.device,
    health.vramFreeMb && health.vramTotalMb
      ? `${(health.vramFreeMb / 1024).toFixed(1)} of ${(health.vramTotalMb / 1024).toFixed(1)} GB VRAM free`
      : null,
    busy ? "generating now" : null,
    `${health.queuePending ?? 0} queued`,
  ].filter(Boolean);

  return (
    <>
      <Row tone={busy ? "warning" : "success"}>{busy ? "Busy" : "Ready"}</Row>
      <p className="mt-1 pl-4">{details.join(" · ")}</p>
      {versionStatus === "older" ? (
        <p className="mt-1 pl-4 text-warning">{olderComfyMessage(health.comfyuiVersion!)}</p>
      ) : versionStatus === "newer" ? (
        <p className="mt-1 pl-4">
          Newer than Soran’t has been tested on (through {COMFY_TESTED.testedThrough}). It should be fine; say so if
          something looks wrong.
        </p>
      ) : null}
      {health.secure === false ? (
        <p className="mt-1 pl-4 text-warning">
          Connected over plain HTTP, so traffic to ComfyUI is not encrypted.
        </p>
      ) : null}
    </>
  );
}

function MachineStatus({
  compat,
  health,
  workflows,
}: {
  compat: CompatReport | null;
  health: Health | null;
  workflows: WorkflowSummary[];
}) {
  if (!compat) {
    return health?.reachable ? (
      <Row tone="neutral">Checking what it has…</Row>
    ) : (
      <Row tone="neutral">Can’t check until ComfyUI is reachable.</Row>
    );
  }

  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const blocked = workflows.filter((w) => (compat.workflows[w.id]?.blocking.length ?? 0) > 0);
  const partial = workflows.filter(
    (w) => !blocked.includes(w) && (compat.workflows[w.id]?.modes.length ?? 0) > 0,
  );

  if (blocked.length === 0 && partial.length === 0) {
    return (
      <Row tone="success">
        Has everything your workflows need
        {compat.incomplete ? " (some checks timed out; asking again shortly)" : ""}.
      </Row>
    );
  }

  return (
    <>
      <Row tone={blocked.length > 0 ? "warning" : "neutral"}>
        {blocked.length > 0
          ? `Missing what ${blocked.length === 1 ? "one workflow needs" : `${blocked.length} workflows need`}.`
          : "Every workflow runs, but some modes won’t."}
      </Row>
      <ul className="mt-1 flex flex-col gap-1 pl-4">
        {[...blocked, ...partial].map((w) => {
          const status = compat.workflows[w.id];
          const problem = status.blocking[0] ?? status.modes[0]?.problems[0];
          return (
            <li key={w.id}>
              <span className="text-fg">{names.get(w.id)}</span>
              {status.blocking.length === 0 ? ` (${status.modes.map((m) => m.mode).join(", ")})` : ""}
              : missing {problem.name}. {problem.fix}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function VersionStatus({ updates }: { updates: Updates }) {
  const { info, check, checking, checkedAt } = updates;
  const latest = info?.latest;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p>
          Version <span className="font-mono text-fg">{info?.current ?? "…"}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={() => void check()} loading={checking}>
          Check for updates
        </Button>
      </div>
      {latest ? (
        <UpdateGuide
          version={latest.version}
          url={latest.url}
          machineChanges={latest.machineChanges}
        />
      ) : checkedAt ? (
        <p className="mt-2">You’re up to date.</p>
      ) : null}
    </>
  );
}

/**
 * How to update, spelled out. Updating this app means redeploying it, which
 * nothing else people install asks of them, and having an agent do it is new
 * to most — so the panel gives the prompt to paste and the steps by hand, in
 * the order that keeps the app from getting ahead of the ComfyUI machine.
 */
function UpdateGuide({
  version,
  url,
  machineChanges,
}: {
  version: string;
  url: string;
  machineChanges: boolean | null;
}) {
  const machineFirst = machineChanges !== false;
  const link = "text-accent underline underline-offset-2";
  const code = "rounded bg-surface px-1 font-mono text-[12px] text-fg";

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent-subtle/40 p-3">
      <div>
        <Row tone={machineChanges === false ? "accent" : "warning"}>{version} is out.</Row>
        <p className="mt-1 pl-4">
          {updateWhere(machineChanges)}{" "}
          <a href={url} target="_blank" rel="noreferrer" className={link}>
            What’s new
          </a>
        </p>
      </div>

      <div>
        <p className="font-medium text-fg">Easiest: have a coding agent do it</p>
        <p className="mt-1">
          Open Claude Code, Codex, Cursor or another coding agent in the folder you
          cloned Soran’t into
          {machineFirst ? ", on your ComfyUI machine," : ""} and paste this. It
          checks what the update needs, does it, and asks before restarting
          anything or deploying. In Claude Code, <span className={code}>/update</span>{" "}
          does the same.
        </p>
        <div className="mt-2 flex items-start gap-2">
          <p className="min-w-0 flex-1 rounded-md border border-border-default bg-bg p-2 font-mono text-[12px] leading-relaxed text-fg">
            {AGENT_PROMPT}
          </p>
          <CopyButton text={AGENT_PROMPT} />
        </div>
      </div>

      <div>
        <p className="font-medium text-fg">Or by hand</p>
        <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5">
          {machineFirst ? (
            <>
              <li>
                On your ComfyUI machine, in your Soran’t folder:{" "}
                <span className={code}>git pull</span> then{" "}
                <span className={code}>pnpm install</span>.
              </li>
              <li>
                Make the changes under <span className="text-fg">ComfyUI machine changes</span>{" "}
                in the{" "}
                <a href={url} target="_blank" rel="noreferrer" className={link}>
                  release notes
                </a>
                : a ComfyUI update, node packs to install or update, models to
                download with <span className={code}>pnpm models:download</span>.
              </li>
              <li>
                Restart ComfyUI, then run <span className={code}>pnpm check:nodes</span>.
                Go on once it reports nothing missing.
              </li>
            </>
          ) : (
            <li>
              In your Soran’t folder, on any computer:{" "}
              <span className={code}>git pull</span> then{" "}
              <span className={code}>pnpm install</span>.
            </li>
          )}
          <li>
            Deploy the app. If Vercel builds from your GitHub fork, open the fork on
            GitHub and press <span className="text-fg">Sync fork</span>; Vercel deploys
            it. Otherwise run <span className={code}>vercel deploy --prod</span> in that
            folder.
          </li>
          <li>Reload this page. This notice goes away once the new version is live.</li>
        </ol>
        <p className="mt-2">
          <a href={UPDATING} target="_blank" rel="noreferrer" className={link}>
            The full guide
          </a>
        </p>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // No clipboard (an insecure context): the text is there to select.
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
