import { Star } from "lucide-react";

/**
 * The favourite mark, in one place because two components draw it — the row in
 * the history and the finished result on the stage — and a star that was hollow
 * in one and solid in the other would read as two different states.
 *
 * Filled when on, outlined when off. That is the whole signal: colour alone
 * would not survive the muted palette these sit in, and a second glyph would
 * make the off state look like something other than the same control.
 */
export function StarIcon({
  filled,
  className = "size-3.5",
}: {
  filled: boolean;
  className?: string;
}) {
  return (
    <Star className={`shrink-0 ${className}`} fill={filled ? "currentColor" : "none"} strokeWidth={1.75} aria-hidden="true" />
  );
}
