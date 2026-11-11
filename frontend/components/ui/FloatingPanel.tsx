"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon } from "./Icon";

export interface FloatingPanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Back arrow before the title: a link (backHref) or a handler (onBack). */
  backHref?: string;
  onBack?: () => void;
  /** Small element at the right of the header (a StatusBadge, a close button…). */
  headerRight?: ReactNode;
  /** Pinned under the scrolling body (primary actions). Stays visible when the phone sheet is collapsed. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Phone bottom sheet starts collapsed (header + footer only). Default false. */
  defaultCollapsed?: boolean;
  className?: string;
}

/**
 * Google Maps style panel over the full-bleed map.
 * ≥ 768 px: white card on the left (380 px wide, max full height, body scrolls).
 * < 768 px: bottom sheet across the full width (max 70% height) with a handle to collapse / expand.
 * Place it inside the positioned <main> next to <MapView>.
 */
export function FloatingPanel({
  title,
  subtitle,
  backHref,
  onBack,
  headerRight,
  footer,
  children,
  defaultCollapsed = false,
  className,
}: FloatingPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();
  const hasHeader = title || subtitle || backHref || onBack || headerRight;

  const back = backHref ? (
    <Link href={backHref} aria-label="Back" className="tap-target -ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100">
      <Icon name="back" />
    </Link>
  ) : onBack ? (
    <button type="button" onClick={onBack} aria-label="Back" className="tap-target -ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100">
      <Icon name="back" />
    </button>
  ) : null;

  return (
    <section
      className={cn(
        "animate-sheet-in absolute z-10 flex min-w-0 flex-col overflow-hidden bg-white shadow-float-lg",
        // phone: bottom sheet
        "inset-x-0 bottom-0 max-h-[70%] rounded-t-2xl",
        // desktop: left card
        "md:inset-x-auto md:top-4 md:bottom-auto md:left-4 md:max-h-[calc(100%-2rem)] md:w-[380px] md:rounded-xl",
        className,
      )}
    >
      {/* Sheet handle (phones only); 44 px tall on touch screens (NFR-02) */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        className="flex h-6 w-full shrink-0 items-center justify-center pointer-coarse:h-11 md:hidden"
      >
        <span className="h-1 w-10 rounded-full bg-slate-300" />
      </button>

      {hasHeader && (
        <header className="flex min-w-0 shrink-0 items-start gap-2 px-4 pb-3 md:pt-4">
          {back}
          <div className="min-w-0 flex-1 pt-1">
            {title && <h1 className="truncate text-lg leading-tight font-semibold text-slate-900">{title}</h1>}
            {subtitle && <div className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</div>}
          </div>
          {headerRight && <div className="shrink-0 pt-1">{headerRight}</div>}
        </header>
      )}

      <div
        id={bodyId}
        className={cn(
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-4",
          !hasHeader && "md:pt-4",
          collapsed && "hidden md:block",
        )}
      >
        {children}
      </div>

      {footer && <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
    </section>
  );
}

export interface PanelSectionProps {
  title?: ReactNode;
  /** Small element on the right of the section title. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Titled group inside a FloatingPanel, separated by a hairline. */
export function PanelSection({ title, action, children, className }: PanelSectionProps) {
  return (
    <section className={cn("min-w-0 border-t border-slate-100 py-3 first:border-t-0 first:pt-0", className)}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
