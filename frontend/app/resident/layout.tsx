// Every page under /resident is for the Resident role only (RoleGate stays mounted while moving between them).

import type { ReactNode } from "react";

import RoleGate from "@/components/RoleGate";

export default function ResidentLayout({ children }: { children: ReactNode }) {
  return <RoleGate role="resident">{children}</RoleGate>;
}
