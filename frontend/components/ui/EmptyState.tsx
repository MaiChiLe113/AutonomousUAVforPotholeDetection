import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: IconName;
  /** Optional call to action, e.g. <ButtonLink href={RESIDENT_ROUTES.newReport}>Report a pothole</ButtonLink> (/resident/report). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon = "info", action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-8 text-center", className)}>
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon name={icon} size={22} />
      </span>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-xs text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
