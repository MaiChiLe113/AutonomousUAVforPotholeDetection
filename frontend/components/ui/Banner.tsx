import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon, type IconName } from "./Icon";

export type BannerTone = "info" | "success" | "warning" | "danger";

const TONES: Record<BannerTone, { box: string; icon: IconName }> = {
  info: { box: "border-blue-200 bg-blue-50 text-blue-900", icon: "info" },
  success: { box: "border-green-200 bg-green-50 text-green-900", icon: "check" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: "alert" },
  danger: { box: "border-red-200 bg-red-50 text-red-900", icon: "alert" },
};

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Optional button / link on the right. */
  action?: ReactNode;
  className?: string;
}

/** Inline message: errors, "Signal lost", "Battery low – return home", results. */
export function Banner({ tone = "info", title, children, action, className }: BannerProps) {
  const t = TONES[tone];
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn("flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2.5 text-sm", t.box, className)}>
      <Icon name={t.icon} size={18} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
