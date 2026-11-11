import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface ChipProps {
  children: ReactNode;
  /** Selected filter chip (accent outline + tint). */
  active?: boolean;
  /** Small coloured dot before the label (e.g. a status colour). */
  color?: string;
  /** Count shown after the label. */
  count?: number;
  /** When set the chip is a toggle button (aria-pressed = active); otherwise a static label. */
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function Chip({ children, active = false, color, count, onClick, title, className }: ChipProps) {
  const classes = cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors",
    active ? "border-accent bg-accent-soft text-accent" : "border-slate-300 bg-white text-slate-700",
    onClick && "tap-target",
    onClick && !active && "hover:bg-slate-50",
    onClick && "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    className,
  );
  const content = (
    <>
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />}
      {children}
      {count !== undefined && (
        <span className={cn("rounded-full px-1.5 text-xs", active ? "bg-white/70" : "bg-slate-100 text-slate-600")}>{count}</span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" aria-pressed={active} onClick={onClick} title={title} className={classes}>
        {content}
      </button>
    );
  }
  return (
    <span title={title} className={classes}>
      {content}
    </span>
  );
}

/** Horizontally scrolling row of chips that never widens the page. */
export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  // On touch screens the 44 px chip hit areas stick out 6 px above and below; extra padding keeps them
  // inside the scroll box (no clipping, no vertical scroll) and negative margins keep the layout unchanged.
  return (
    <div
      className={cn(
        "-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]",
        "pointer-coarse:-mt-1.5 pointer-coarse:-mb-0.5 pointer-coarse:pt-1.5 pointer-coarse:pb-1.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
