import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "quiet-danger" | "danger";
type Size = "xs" | "sm" | "md" | "lg" | "icon-sm" | "icon-md";

/**
 * One primary per screen, a raised secondary, and quiet actions for everything
 * that should be reachable without competing. Every variant keeps a hairline
 * at rest, so a quiet action still reads as a control before it is pointed at.
 */
const VARIANTS: Record<Variant, string> = {
  // The one lit control on a screen: a solid tungsten fill with dark type.
  primary:
    "bg-accent text-accent-fg border border-accent hover:bg-accent-hover hover:border-accent-hover shadow-sm",
  secondary:
    "bg-raised text-fg border border-border-strong hover:border-fg-subtle hover:bg-surface-hover",
  quiet:
    "bg-transparent text-fg-muted border border-border-default hover:border-border-strong hover:bg-surface-hover hover:text-fg",
  // Its own variant rather than an override on `quiet`: two hover:border-*
  // utilities have no defined precedence.
  "quiet-danger":
    "bg-transparent text-fg-muted border border-border-default hover:border-danger hover:bg-surface-hover hover:text-danger",
  danger:
    "bg-transparent text-danger border border-danger/50 hover:border-danger hover:bg-danger/10",
};

/**
 * `xs` sits inside another component's furniture — a section header, a day
 * divider. It shares `sm`'s type size: the two differ in density, not in how
 * readable they are.
 */
const SIZES: Record<Size, string> = {
  xs: "h-6 px-2 text-[12px] rounded-sm gap-1",
  sm: "h-7 px-2.5 text-[12px] rounded-md gap-1.5",
  md: "h-9 px-3.5 text-[13px] rounded-md gap-2",
  lg: "h-11 px-5 text-[14px] rounded-md gap-2",
  "icon-sm": "size-7 text-[12px] rounded-md",
  "icon-md": "size-9 shrink-0 text-[13px] rounded-md",
};

/** `font-sans` stated rather than inherited; see the preflight note in globals. */
const BASE = `inline-flex items-center justify-center font-sans font-medium
  transition-colors duration-150 select-none whitespace-nowrap
  disabled:opacity-45 disabled:pointer-events-none`;

/**
 * The same recipe as a class string, for the handful of controls that have to
 * be an anchor rather than a button — a download link cannot be a <button>
 * without losing what makes it a link.
 */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  className = "",
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, className })}
    >
      {loading ? <Spinner className={size === "xs" ? "size-3" : ""} /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`spin size-3.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
