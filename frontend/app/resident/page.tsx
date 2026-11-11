// /resident -> the resident home hub.

import { redirect } from "next/navigation";

import { RESIDENT_ROUTES } from "@/lib/config";

export default function ResidentIndexPage() {
  redirect(RESIDENT_ROUTES.home);
}
