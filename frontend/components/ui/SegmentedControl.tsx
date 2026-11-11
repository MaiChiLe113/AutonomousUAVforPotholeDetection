"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group, e.g. "Role". */
  ariaLabel: string;
  size?: "sm" | "md";
  /** Stretch segments to fill the width (panel tabs). */
  fullWidth?: boolean;
  className?: string;
}

/** Pill switch: the top bar Resident | Monitor switch, or tabs inside a FloatingPanel. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex rounded-full bg-slate-100 p-0.5", fullWidth && "flex w-full", className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => !selected && onChange(o.value)}
            className={cn(
              "tap-target rounded-full font-medium whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              size === "sm" ? "h-7 px-3 text-xs" : "h-8 px-3.5 text-sm",
              fullWidth && "flex-1",
              selected ? "bg-white text-accent shadow-sm" : "text-slate-600 hover:text-slate-900",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
