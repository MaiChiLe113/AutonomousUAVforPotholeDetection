"use client";

// Slim top bar (app name, Resident | Monitor switch, Sign out) over a positioned <main>.
// Nothing else: no settings, profile or extra menus. Hidden on the sign-in page and when signed out.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { APP, ROLE_HOME } from "@/lib/config";
import { signOut, switchRole, useSession } from "@/lib/session";
import type { Role } from "@/lib/types";

import { Icon } from "./ui/Icon";
import { SegmentedControl } from "./ui/SegmentedControl";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "resident", label: "Resident" },
  { value: "monitor", label: "Monitor" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session } = useSession();
  const showBar = !!session && pathname !== "/";

  function onSwitch(role: Role) {
    switchRole(role);
    router.push(ROLE_HOME[role]);
  }

  function onSignOut() {
    signOut();
    router.replace("/");
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      {showBar && session && (
        <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:px-4">
          <Link href={ROLE_HOME[session.role]} className="flex h-11 min-w-0 items-center gap-2 font-semibold text-slate-900">
            <span className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-white sm:flex">
              <Icon name="drone" size={16} />
            </span>
            <span className="truncate text-[15px]">{APP.name}</span>
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <SegmentedControl ariaLabel="Role" size="sm" options={ROLE_OPTIONS} value={session.role} onChange={onSwitch} />
            <button
              type="button"
              onClick={onSignOut}
              title={`Sign out ${session.name}`}
              className="tap-target flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-accent sm:px-3"
            >
              <Icon name="signout" size={18} />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </button>
          </div>
        </header>
      )}
      <main className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
    </div>
  );
}
