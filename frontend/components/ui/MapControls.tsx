import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon, type IconName } from "./Icon";

export interface MapControlsProps {
  children: ReactNode;
  /** Default "top-right". On phones the bottom sheet covers the bottom, so prefer the top. */
  position?: "top-right" | "bottom-right";
  className?: string;
}

/** Stack of floating map buttons (Google Maps style). Place next to <MapView> inside <main>. */
export function MapControls({ children, position = "top-right", className }: MapControlsProps) {
  return (
    <div
      className={cn(
        "absolute right-3 z-10 flex flex-col items-end gap-2",
        position === "top-right" ? "top-3" : "bottom-6 max-md:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface MapControlButtonProps {
  /** Visible text (and accessible name). */
  label: string;
  icon?: IconName;
  /** Toggle state, e.g. "Follow UAV" on (aria-pressed). Omit for plain actions like "Fit route". */
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Hide the text and show only the icon (label stays as aria-label). */
  iconOnly?: boolean;
}

export function MapControlButton({ label, icon, active, onClick, disabled, iconOnly = false }: MapControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={cn(
        "tap-target flex h-10 items-center gap-2 rounded-full bg-white text-sm font-medium shadow-float transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50",
        iconOnly ? "w-10 justify-center" : "px-4",
        active ? "text-accent ring-2 ring-accent" : "text-slate-700 hover:bg-slate-50",
      )}
    >
      {icon && <Icon name={icon} size={18} />}
      {!iconOnly && label}
    </button>
  );
}
