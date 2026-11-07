"use client";

import { useCallback, useEffect, useState } from "react";
import type { UpdateInfo } from "@/app/api/updates/route";
import { Dot } from "@/components/ui/panel";
import { api } from "@/lib/client";

export interface Updates {
  info: UpdateInfo | null;
  /** Asks GitHub now rather than the server's six-hour answer. */
  check: () => Promise<void>;
  checking: boolean;
  /** When the last check this page asked for finished — null until one has. */
  checkedAt: number | null;
}

/**
 * This deployment's version, and any newer release. Asked live once per page
 * load — the server lets a live check through at most once a minute and hands
 * everyone else its cached answer, so opening the app is what finds a release
 * the day it is out rather than up to six hours later. `check` asks again.
 * Held by the page and handed to the header notice, the pill and the status
 * panel, so a check from the panel updates all three.
 */
export function useUpdates(): Updates {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<UpdateInfo>("/api/updates?refresh=1")
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setCheckedAt(Date.now());
        }
      })
      .catch(() => {
        // No notice is the right failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setInfo(await api<UpdateInfo>("/api/updates?refresh=1"));
      setCheckedAt(Date.now());
    } catch {
      // Leave the last answer standing.
    } finally {
      setChecking(false);
    }
  }, []);

  return { info, check, checking, checkedAt };
}

/** Where an update can be done, in one sentence. */
export function updateWhere(machineChanges: boolean | null): string {
  return machineChanges === false
    ? "App-only update: it can be deployed from any machine."
    : machineChanges === true
      ? "It also needs changes on your ComfyUI machine, so run the update there."
      : "Check the release notes for anything it needs on your ComfyUI machine.";
}

/**
 * A newer release, in the header — nothing at all while there is none. It
 * opens the status panel, which says how to update step by step: most people
 * running this have never updated an app by redeploying it, and a link to
 * release notes on GitHub does not tell them how. The dot says which kind of
 * update it is — an app-only release can be deployed from any machine, one
 * that changes what the ComfyUI machine needs has to be run there first.
 */
export function UpdateBadge({
  info,
  onOpen,
}: {
  info: UpdateInfo | null;
  onOpen: () => void;
}) {
  const latest = info?.latest;
  if (!info || !latest) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Soran’t ${latest.version} is out (this is ${info.current}). ${updateWhere(latest.machineChanges)}`}
      aria-label={`Soran’t ${latest.version} is out. How to update`}
      // On a phone the header has no room for it: the dot on the status pill
      // says the same, and opens the same panel.
      className="hidden h-8 items-center gap-2 rounded-md border border-accent/40 sm:inline-flex
        bg-accent-subtle px-2.5 text-[12px] text-fg-muted transition-colors duration-150
        hover:border-accent"
    >
      <Dot tone={latest.machineChanges === false ? "accent" : "warning"} />
      <span className="font-medium text-fg">
        Update {latest.version}
      </span>
    </button>
  );
}
