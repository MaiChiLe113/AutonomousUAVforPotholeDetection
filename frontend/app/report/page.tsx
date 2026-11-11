// Old link: /report -> /resident/report, /report?tab=mine -> /resident/reports.

import { redirect } from "next/navigation";

import { RESIDENT_ROUTES } from "@/lib/config";

export default async function OldReportPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  redirect(tab === "mine" ? RESIDENT_ROUTES.reports : RESIDENT_ROUTES.newReport);
}
