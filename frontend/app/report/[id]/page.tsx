// Old link: /report/[id] -> /resident/reports/[id].

import { redirect } from "next/navigation";

import { RESIDENT_ROUTES } from "@/lib/config";

export default async function OldReportStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(RESIDENT_ROUTES.report(encodeURIComponent(id)));
}
