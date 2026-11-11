"use client";

// Wrap a role's pages: <RoleGate role="monitor">...</RoleGate>.
// No session -> "/" (sign in). Other role -> that role's home, ROLE_HOME in lib/config
// (/resident/home or /monitor).

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { ROLE_HOME } from "@/lib/config";
import { useSession } from "@/lib/session";
import type { Role } from "@/lib/types";

import { LoadingState } from "./ui/Spinner";

export interface RoleGateProps {
  role: Role;
  children: ReactNode;
}

export default function RoleGate({ role, children }: RoleGateProps) {
  const router = useRouter();
  const { ready, session } = useSession();
  const target = !ready ? null : !session ? "/" : session.role !== role ? ROLE_HOME[session.role] : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (!ready || target) return <LoadingState className="absolute inset-0" text={ready ? "Redirecting…" : "Loading…"} />;
  return <>{children}</>;
}
