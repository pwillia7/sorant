import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * A file control collapsed to one line until it is asked for: "Add a clip",
 * "Add a picture". See `compact` on the params that use it.
 *
 * The row still takes a drop, so dragging a file onto it works without
 * opening it first; a click opens the full control, a drop opens it and
 * uploads.
 */
export function AddFileRow({
  label,
  icon,
  disabled,
  onOpen,
  onFiles,
}: {
  label: string;
  /** Beside the label; a plus where nothing more specific fits. */
  icon?: ReactNode;
  disabled?: boolean;
  onOpen: () => void;
  onFiles: (files: FileList) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onOpen();
        if (!disabled) onFiles(event.dataTransfer.files);
      }}
      className={`flex w-full items-center gap-2 rounded-lg border border-dashed
        px-3 py-2.5 text-left text-[13px] transition-colors
        disabled:pointer-events-none disabled:opacity-50
        ${
          dragging
            ? "border-accent bg-accent-subtle/30 text-fg"
            : "border-border-strong bg-bg-subtle text-fg-muted hover:border-border-default hover:text-fg"
        }`}
    >
      {icon ?? <Plus aria-hidden="true" className="size-4 text-fg-subtle" />}
      <span>{label}</span>
    </button>
  );
}
