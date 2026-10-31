"use client";

import { AudioLines } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { withToken } from "@/lib/client";
import { isAudioOnly, isImageOnly, type Job } from "@/lib/jobs";
import { workflowIcon } from "../workflow-icons";

const VIDEO = /\.(mp4|webm|mov|mkv)$/i;

/**
 * A generation's frame, as a thumbnail: the picture for a still, a frame a
 * little way into a clip, and the workflow's icon for anything with nothing
 * to show yet — or nothing to show at all, a track.
 *
 * Visual work is told apart by its picture, not its prompt: "the one with the
 * hat" is a glance at a frame and a read of every line of text. The clip is
 * only asked for once the thumbnail is near the screen, since a long history
 * is dozens of them and each is a request for the file's opening bytes.
 */
export function Poster({
  job,
  className = "h-10 w-16",
  badge = true,
}: {
  job: Job;
  className?: string;
  /** The workflow's icon in the corner, where the row does not say it. */
  badge?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  const Icon = workflowIcon(job.workflowId);
  const file = job.phase === "done" ? job.outputs.find((output) => (output.type || "output") === "output") ?? job.outputs[0] : undefined;
  const audio = isAudioOnly(job);
  const still = file && isImageOnly(job);
  const clip = file && !audio && !still && VIDEO.test(file.filename);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-md border
        border-border-default bg-bg text-fg-subtle ${className}`}
    >
      {near && still ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={withToken(file.url)} alt="" className="size-full object-cover" />
      ) : near && clip ? (
        <video
          // A fraction in, so the frame is the shot rather than a black first one.
          src={`${withToken(file.url)}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          className="pointer-events-none size-full bg-black object-cover"
        />
      ) : audio ? (
        <AudioLines className="size-4" />
      ) : (
        <Icon className="size-4" />
      )}
      {badge && (still || clip) ? (
        <span className="absolute left-0.5 top-0.5 grid size-4 place-items-center rounded bg-black/55 text-white">
          <Icon className="size-2.5 stroke-2" />
        </span>
      ) : null}
    </span>
  );
}
