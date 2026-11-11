import { cn } from "@/lib/cn";

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({ size = 16, className, label = "Loading" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Centered spinner with a short line of text, for loading panels and pages. */
export function LoadingState({ text = "Loading…", className }: { text?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-8 text-sm text-slate-500", className)}>
      <Spinner className="text-accent" />
      {text}
    </div>
  );
}
