"use client";

import { LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Dot } from "@/components/ui/panel";

export interface Health {
  reachable: boolean;
  configured?: boolean;
  authorized?: boolean;
  secure?: boolean;
  error?: string;
  queueRunning?: number;
  queuePending?: number;
  device?: string;
  vramTotalMb?: number;
  vramFreeMb?: number;
}

/**
 * The GPU box's health, polled slowly — it is a reassurance indicator, not
 * something to hammer the endpoint over. Held by the page and handed to both
 * the pill and the notice, so they agree and the endpoint is polled once.
 */
export function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const next = await api<Health>("/api/health");
        if (!cancelled) setHealth(next);
      } catch {
        if (!cancelled) setHealth({ reachable: false });
      }
    };

    check();
    const id = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return health;
}

/**
 * The header's one-word summary of the GPU box. A button: it opens the status
 * panel, which says the rest — the tooltip is kept for a quick look on desktop.
 * With a newer release out it wears a dot in its corner, since the panel is
 * also where updating is explained, and the pill is what people click.
 */
export function ConnectionPill({
  health,
  onOpen,
  update,
}: {
  health: Health | null;
  onOpen: () => void;
  /** The newer release's version, when there is one. */
  update?: string | null;
}) {
  const busy = (health?.queueRunning ?? 0) > 0;
  const unauthorized = health?.reachable === true && health.authorized === false;

  const label = !health
    ? "Checking…"
    : health.configured === false
      ? "Not set up"
      : !health.reachable
      ? "Offline"
      : unauthorized
        ? "Auth failed"
        : busy
          ? "Busy"
          : "Ready";

  const insecure = health?.secure === false;

  const title = health?.reachable && !unauthorized
    ? [
        insecure ? "Connected over plain HTTP — traffic is not encrypted" : null,
        health.device,
        health.vramFreeMb && health.vramTotalMb
          ? `${(health.vramFreeMb / 1024).toFixed(1)} / ${(health.vramTotalMb / 1024).toFixed(1)} GB VRAM free`
          : null,
        `${health.queuePending ?? 0} queued`,
      ]
        .filter(Boolean)
        .join(" · ")
    : (health?.error ?? "Waiting for the first health check");

  return (
    <button
      type="button"
      onClick={onOpen}
      title={update ? `${title}\nSoran’t ${update} is out — open to update` : title}
      aria-label={`ComfyUI: ${label}.${update ? ` Soran’t ${update} is out.` : ""} Open status`}
      className="relative inline-flex items-center gap-2 rounded-md border border-border-default
        bg-surface h-8 px-2.5 text-[12px] text-fg-muted transition-colors duration-150
        hover:border-border-strong hover:bg-surface-hover"
    >
      <Dot
        tone={
          !health
            ? "neutral"
            : !health.reachable || unauthorized
              ? "danger"
              : busy
                ? "warning"
                : "success"
        }
        pulse={busy || !health}
      />
      <span className="font-medium text-fg">{label}</span>
      {/* Unlocked padlock while the ComfyUI leg is unencrypted. */}
      {insecure && health?.reachable ? (
        <LockOpen
          className="size-3 text-warning"
         
          aria-label="Unencrypted connection to ComfyUI"
          role="img"
        />
      ) : null}
      {health?.reachable && !unauthorized && (health.queuePending ?? 0) > 0 ? (
        <span className="tabular-nums">
          <span className="sm:hidden">+{health.queuePending}</span>
          <span className="hidden sm:inline">· {health.queuePending} queued</span>
        </span>
      ) : null}
      {update ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-bg"
        />
      ) : null}
    </button>
  );
}

const TROUBLESHOOTING =
  "https://github.com/pwillia7/sorant/blob/main/docs/setup.md#troubleshooting";

/**
 * What is wrong with the connection, and the likely fix, in the page rather
 * than in the pill's tooltip — a tooltip is invisible on a phone and to anyone
 * who does not think to hover, which on a first run is everyone. Nothing while
 * the box is fine, or before the first answer.
 */
export function ConnectionNotice({ health }: { health: Health | null }) {
  if (!health || (health.reachable && health.authorized !== false)) return null;

  const [headline, fix] =
    health.configured === false
      ? [
          "This app is not connected to a ComfyUI yet.",
          "Set COMFY_URL — in .env.local when running locally, or in the Vercel project's environment variables — then restart or redeploy.",
        ]
      : health.reachable
        ? [
            "ComfyUI refused this app's token.",
            "COMFY_API_TOKEN must be the token from ComfyUI-Login: the first line of login/PASSWORD in the ComfyUI folder. In .env.local write every $ as \\$; in Vercel, paste it as it is.",
          ]
        : [
            "Can't reach ComfyUI.",
            "Check that ComfyUI is running and that COMFY_URL points at it. A deployed app needs a public address — localhost only works when the app runs on the same machine.",
          ];

  return (
    <div
      role="status"
      className="shrink-0 border-b border-danger/40 bg-danger/10 px-4 py-2.5
        text-[12px] leading-relaxed text-fg-muted"
    >
      <p className="font-medium text-fg">{headline}</p>
      <p className="mt-1">
        {fix}{" "}
        <a
          href={TROUBLESHOOTING}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          Troubleshooting
        </a>
      </p>
      {/* The server's own message names the address it tried, which is the
          one detail the fix above cannot. The others would only repeat it. */}
      {health.error && !health.reachable && health.configured !== false ? (
        <p className="mt-1 font-mono text-fg-subtle">{health.error}</p>
      ) : null}
    </div>
  );
}

