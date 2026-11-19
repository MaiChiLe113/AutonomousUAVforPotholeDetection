"use client";

// Frame of every /monitor page: a left sidebar (Fleet, Map, Reports, History) and the page in the content pane.
// The sidebar is always on the left; under 768 px it shrinks to an icon-only rail. Pages lay themselves out with
// `absolute inset-0` inside the content pane (not the viewport). The tab is the route, so links are shareable.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MONITOR, MONITOR_ROUTES } from "@/lib/config";

import { FleetProvider } from "./fleet/FleetContext";

type Tab = (typeof MONITOR.tabs)[number];

const isActive = (tab: Tab, pathname: string) =>
  pathname === tab.href || tab.alsoUnder.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export default function MonitorShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // /fleet is only needed by the dashboard tabs; the other pages do their own requests.
  const pollFleet = pathname === MONITOR_ROUTES.fleet || pathname.startsWith(`${MONITOR_ROUTES.fleet}/`);

  return (
    <FleetProvider enabled={pollFleet}>
      <div className="absolute inset-0 flex">
        <nav aria-label="Monitor" className="flex w-14 shrink-0 flex-col gap-1 border-r border-slate-200 bg-white p-2 md:w-52 md:p-3">
          <p className="hidden px-3 pt-1 pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase md:block">Monitor</p>
          {MONITOR.tabs.map((tab) => {
            const active = isActive(tab, pathname);
            return (
              <Link
                key={tab.key}
                href={tab.href}
                title={tab.label}
                aria-label={tab.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "tap-target flex h-11 items-center justify-center gap-3 rounded-full text-sm font-medium md:justify-start md:px-3",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  active ? "bg-accent-soft text-accent" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                <Icon name={tab.icon} size={20} />
                <span className="hidden md:inline">{tab.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
      </div>
    </FleetProvider>
  );
}
