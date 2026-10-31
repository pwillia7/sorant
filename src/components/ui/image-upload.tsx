"use client";

import { ImagePlus, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import {
  CameraCapture,
  CameraIcon,
  cameraAvailable,
} from "@/components/ui/camera-capture";
import { ImageEditBar } from "@/components/ui/image-edit";
import { api, ApiError, withToken } from "@/lib/client";

interface UploadResponse {
  ref: string;
  name: string;
  subfolder: string;
  type: string;
}

/** Stay under Vercel's 4.5 MB function request-body limit, with headroom. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 2560;

interface Prepared {
  blob: Blob;
  name: string;
  /** Set when the file was rescaled, so the UI can say so rather than do it silently. */
  note?: string;
}

/**
 * Shrinks oversized images in the browser instead of letting the upload fail.
 *
 * Vercel rejects request bodies over 4.5 MB with a 413 before the handler runs,
 * and a phone photo clears that easily. Downscaling loses nothing in practice:
 * the workflow's ImageScaleToTotalPixels rescales to roughly 1 MP anyway, so a
 * 12 MP original is discarded server-side regardless.
 *
 * Re-encodes as JPEG because alpha is meaningless for a video's first frame.
 */
async function prepareForUpload(file: File): Promise<Prepared> {
  if (file.size <= MAX_UPLOAD_BYTES) return { blob: file, name: file.name };

  const bitmap = await createImageBitmap(file);
  const originalMb = (file.size / 1024 / 1024).toFixed(1);

  try {
    let edge = MAX_EDGE;
    let quality = 0.9;

    // Shrink until it fits. Two or three passes at most in practice.
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (!blob) break;

      if (blob.size <= MAX_UPLOAD_BYTES) {
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return {
          blob,
          name,
          note: `Resized from ${originalMb} MB to ${width}×${height} (${(blob.size / 1024 / 1024).toFixed(1)} MB) to fit the upload limit.`,
        };
      }

      edge = Math.round(edge * 0.75);
      quality = Math.max(0.6, quality - 0.1);
    }
  } finally {
    bitmap.close();
  }

  throw new Error(
    `That image is ${originalMb} MB and could not be shrunk below the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit. Try exporting it smaller.`,
  );
}

function WandIcon() {
  return (
    <WandSparkles className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
  );
}

/** A reference in ComfyUI's input directory, as a URL an <img> can load. */
function inputMediaUrl(ref: string): string {
  return withToken(
    `/api/media?${new URLSearchParams({
      filename: ref.split("/").pop() ?? ref,
      subfolder: ref.includes("/") ? ref.slice(0, ref.lastIndexOf("/")) : "",
      type: "input",
    })}`,
  );
}

/**
 * Uploads to ComfyUI's input directory as soon as a file is chosen, then holds
 * the returned reference as the param value. Uploading on selection rather
 * than at submit time means a bad file is caught immediately instead of
 * failing a generation the user has already committed to.
 */
export function ImageUpload({
  id,
  label,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  /** The param's own label, echoed in the camera modal's header. */
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  /**
   * Resolved in an effect rather than at render: it reads `navigator`, which
   * does not exist on the server, and a control that appeared only after
   * hydration would be a mismatch.
   */
  const [canUseCamera, setCanUseCamera] = useState(false);
  useEffect(() => setCanUseCamera(cameraAvailable()), []);
  /**
   * Read off the loaded image. Worth showing here because in this workflow the
   * output video inherits the image's dimensions.
   */
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  /**
   * The pictures this slot has held through editing: the one that was
   * uploaded, then each edit in the order it was made. Clicking one puts it
   * back, which is the whole of undo and redo. Anything that changes the slot
   * from outside — a new upload, Remove, a remembered value — starts it over.
   */
  const [versions, setVersions] = useState<string[]>(value ? [value] : []);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  /** Held down on Compare: the original is showing in place of the edit. */
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    setVersions((current) =>
      !value ? [] : current.includes(value) ? current : [value],
    );
    if (!value) setEditOpen(false);
  }, [value]);

  // Appended whichever version it was made from: the strip is everything made,
  // in order, and going back to an earlier one never throws a later one away.
  const edited = useCallback(
    (ref: string) => {
      setVersions((current) => [...current.filter((v) => v !== ref), ref]);
      onChange(ref);
    },
    [onChange],
  );

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNote(null);
    setDimensions(null);
    try {
      const prepared = await prepareForUpload(file);

      const form = new FormData();
      form.append("file", prepared.blob, prepared.name);
      // api() deliberately leaves the Content-Type off FormData so the browser
      // can set the multipart boundary itself.
      const result = await api<UploadResponse>("/api/upload", {
        method: "POST",
        body: form,
      });

      onChange(result.ref);
      if (prepared.note) setNote(prepared.note);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not upload that image.",
      );
    } finally {
      setUploading(false);
    }
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void upload(file);
  };

  // ComfyUI can serve the file straight back from its input directory, so the
  // preview is the actual uploaded image rather than a local object URL.
  const original = versions[0];
  const showingOriginal = comparing && !!original && original !== value;
  const previewUrl = value
    ? inputMediaUrl(showingOriginal ? original : value)
    : null;

  // `relative` for the same reason as the audio picker: it contains the
  // `sr-only` file input, which is absolutely positioned.
  return (
    <div className="relative flex min-w-0 flex-col gap-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={disabled || uploading || editBusy}
        aria-describedby={describedBy}
        onChange={(event) => pick(event.target.files)}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !uploading && !editBusy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && !uploading && !editBusy) pick(event.dataTransfer.files);
        }}
        className={`relative overflow-hidden rounded-lg border transition-colors
          ${previewUrl ? "border-solid" : "border-dashed"}
          ${
            dragging
              ? "border-accent bg-accent-subtle/30"
              : previewUrl
                ? "border-border-default bg-bg-subtle"
                : "border-border-strong bg-bg-subtle"
          } ${disabled ? "opacity-50" : ""}`}
      >
        {previewUrl ? (
          <div className="relative">
            {/* Not next/image: this is proxied through our own route, and the
                dimensions are unknown until ComfyUI has the file.

                Sized by its own aspect ratio rather than w-full: forcing full
                width caps a portrait image at max-height and pads the rest with
                background, which reads as the image not fitting its container. */}
            <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt={showingOriginal ? "The original picture" : "Selected first frame"}
              onLoad={(event) => {
                if (showingOriginal) return;
                setDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              /*
                A remembered reference can outlive the file — ComfyUI's input
                directory gets cleared, or the box is rebuilt. Catching it here
                turns a wasted generation ("Value not in list") into an
                obvious prompt to re-upload.
              */
              onError={() => {
                // The original gone while comparing is not the slot's picture
                // gone: let go of Compare and leave the slot as it is.
                if (showingOriginal) {
                  setComparing(false);
                  return;
                }
                onChange("");
                setDimensions(null);
                setError(
                  "That image is no longer on the ComfyUI server. Upload it again.",
                );
              }}
              className={`mx-auto block h-auto max-h-64 w-auto max-w-full object-contain
                transition-opacity ${editBusy ? "opacity-60" : ""}`}
            />
            {!editOpen && !disabled && !uploading ? (
              <Button
                variant="secondary"
                size="xs"
                icon={<WandIcon />}
                className="absolute right-2 top-2 shadow-sm"
                title="Change something in this picture"
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
            ) : null}
            {original && original !== value ? (
              // Held rather than toggled: letting go is the way back, so the
              // edit can never be left looking like the original by accident.
              <Button
                variant="secondary"
                size="xs"
                className="absolute bottom-2 left-2 touch-none shadow-sm"
                title="Hold to see the original"
                onPointerDown={() => setComparing(true)}
                onPointerUp={() => setComparing(false)}
                onPointerLeave={() => setComparing(false)}
                onPointerCancel={() => setComparing(false)}
                onContextMenu={(event) => event.preventDefault()}
              >
                {showingOriginal ? "Original" : "Hold to compare"}
              </Button>
            ) : null}
            </div>

            {editOpen && value ? (
              <ImageEditBar
                id={`${id}-edit`}
                source={value}
                onEdited={edited}
                onBusyChange={setEditBusy}
                onClose={() => setEditOpen(false)}
              />
            ) : null}

            {versions.length > 1 ? (
              <div
                className="flex gap-1.5 overflow-x-auto border-t border-border-default px-3 py-2"
                role="group"
                aria-label="Versions of this picture"
              >
                {versions.map((ref, index) => (
                  <button
                    key={ref}
                    type="button"
                    disabled={editBusy}
                    aria-pressed={ref === value}
                    aria-label={index === 0 ? "Original" : `Edit ${index}`}
                    title={index === 0 ? "Original" : `Edit ${index}`}
                    onClick={() => onChange(ref)}
                    className={`relative size-12 shrink-0 overflow-hidden rounded border
                      transition-colors disabled:opacity-50 ${
                        ref === value
                          ? "border-accent ring-2 ring-accent/30"
                          : "border-border-default hover:border-border-strong"
                      }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={inputMediaUrl(ref)}
                      alt=""
                      className="size-full object-cover"
                    />
                    {index === 0 ? (
                      <span className="absolute inset-x-0 bottom-0 bg-black/55 text-center text-[9px] leading-3 text-white">
                        orig
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-2 border-t border-border-default px-3 py-2">
              {/* min-w-0 is what actually lets `truncate` work: a flex item
                  defaults to min-width:auto and would otherwise refuse to
                  shrink below the filename, pushing the buttons out. */}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
                {value}
              </span>
              {dimensions ? (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  {dimensions.width}×{dimensions.height}
                </span>
              ) : null}
              <div className="ml-auto flex shrink-0 gap-2">
                {/* Icon-only here, captioned in the empty state below. Three
                    labelled buttons in a 320px column squeeze the filename
                    beside them down to nothing, and the filename is the part
                    that says which image this is. */}
                {canUseCamera ? (
                  <Button
                    variant="quiet"
                    size="xs"
                    icon={<CameraIcon />}
                    aria-label="Replace with a photo"
                    title="Replace with a photo"
                    disabled={disabled || uploading || editBusy}
                    onClick={() => setCameraOpen(true)}
                  />
                ) : null}
                <Button
                  variant="quiet"
                  size="xs"
                  disabled={disabled || uploading || editBusy}
                  onClick={() => inputRef.current?.click()}
                >
                  Replace
                </Button>
                <Button
                  variant="quiet-danger"
                  size="xs"
                  disabled={disabled || uploading || editBusy}
                  onClick={() => {
                    onChange("");
                    setError(null);
                    setNote(null);
                    setDimensions(null);
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={disabled || uploading || editBusy}
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 px-4 py-8
                text-center transition-colors hover:bg-surface-hover disabled:pointer-events-none"
            >
              {uploading ? (
                <>
                  <Spinner className="size-5 text-fg-muted" />
                  <span className="text-[13px] text-fg-muted">Uploading…</span>
                </>
              ) : (
                <>
                  <ImagePlus className="size-7 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                  <span className="text-[13px] font-medium text-fg">
                    Drop an image or click to choose
                  </span>
                  <span className="text-[12px] text-fg-subtle">
                    PNG, JPEG or WebP — anything oversized is resized to fit
                  </span>
                </>
              )}
            </button>

            {canUseCamera ? (
              <div
                className="flex justify-center border-t border-border-default
                  px-3 py-2"
              >
                <Button
                  variant="quiet"
                  size="xs"
                  icon={<CameraIcon />}
                  disabled={disabled || uploading || editBusy}
                  onClick={() => setCameraOpen(true)}
                >
                  Take a photo
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        subtitle={label}
        // Straight into the same handler a file picked off disk goes through,
        // so the size guard, the upload and the preview are all one path.
        onCapture={(file) => void upload(file)}
      />

      {error ? (
        <p className="text-[12px] leading-snug text-danger">{error}</p>
      ) : note ? (
        <p className="text-[12px] leading-snug text-fg-subtle">{note}</p>
      ) : null}
    </div>
  );
}
