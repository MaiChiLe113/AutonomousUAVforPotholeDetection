"use client";

// UC-01 Sign in: name + role card (Resident / UAV Monitor), no password. Plus "Reset demo".

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Banner } from "@/components/ui/Banner";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { resetDemo } from "@/lib/api";
import { cn } from "@/lib/cn";
import { APP, ROLE_HOME, ROLE_LABEL } from "@/lib/config";
import { clearMyReports, signIn, useSession } from "@/lib/session";
import type { Role } from "@/lib/types";

const ROLES: { role: Role; icon: IconName; text: string }[] = [
  { role: "resident", icon: "pin", text: "Pin a pothole, send a photo and follow its status." },
  { role: "monitor", icon: "drone", text: "Review reports, approve flight plans and track the UAV." },
];

export default function SignInPage() {
  const { session } = useSession();
  // Prefill with the signed-in name once the session has loaded (user edits win).
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? session?.name ?? "";
  const [nameError, setNameError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function choose(role: Role) {
    if (!name.trim()) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    signIn(name, role);
    router.push(ROLE_HOME[role]);
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md min-w-0">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-white shadow-float">
            <Icon name="drone" size={26} />
          </span>
          <h1 className="text-2xl font-semibold text-slate-900">{APP.name}</h1>
          <p className="mt-1 text-sm text-slate-500">Smart City UAV for Pothole Detection</p>
        </div>

        <form
          className="rounded-xl bg-white p-5 shadow-float"
          onSubmit={(e) => {
            e.preventDefault();
            choose(session?.role ?? "resident");
          }}
        >
          <label htmlFor="name" className="block text-sm font-medium text-slate-700">
            Your name
          </label>
          <input
            id="name"
            ref={nameRef}
            value={name}
            onChange={(e) => {
              setTyped(e.target.value);
              if (e.target.value.trim()) setNameError(false);
            }}
            autoComplete="name"
            placeholder="e.g. Alex Nguyen"
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? "name-error" : undefined}
            className={cn(
              "mt-1 block h-11 w-full rounded-lg border px-3 text-base text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:outline-none",
              nameError ? "border-red-400 focus:ring-red-200" : "border-slate-300 focus:border-accent focus:ring-accent/20",
            )}
          />
          {nameError && (
            <p id="name-error" className="mt-1 text-xs text-red-700">
              Enter your name to continue.
            </p>
          )}

          <p className="mt-5 mb-2 text-sm font-medium text-slate-700">Continue as</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((r) => (
              <button
                key={r.role}
                type="button"
                onClick={() => choose(r.role)}
                className="group flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-col"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent group-hover:bg-white">
                  <Icon name={r.icon} size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{ROLE_LABEL[r.role]}</span>
                  <span className="mt-0.5 block text-sm text-slate-500">{r.text}</span>
                </span>
              </button>
            ))}
          </div>
        </form>

        <ResetDemo />
      </div>
    </div>
  );
}

function ResetDemo() {
  const [step, setStep] = useState<"idle" | "confirm" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function reset() {
    setStep("busy");
    try {
      await resetDemo();
      clearMyReports();
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }

  return (
    <div className="mt-6 text-center text-sm">
      {step === "confirm" ? (
        <p className="text-slate-600">
          Reset all demo data?{" "}
          <button type="button" onClick={reset} className="tap-target font-medium text-red-700 hover:underline">
            Reset
          </button>{" "}
          ·{" "}
          <button type="button" onClick={() => setStep("idle")} className="tap-target font-medium text-slate-600 hover:underline">
            Cancel
          </button>
        </p>
      ) : step === "busy" ? (
        <p className="inline-flex items-center gap-2 text-slate-500">
          <Spinner size={14} /> Resetting demo data…
        </p>
      ) : (
        <button type="button" onClick={() => setStep("confirm")} className="tap-target text-slate-500 hover:text-slate-800 hover:underline">
          Reset demo
        </button>
      )}
      {step === "done" && (
        <Banner tone="success" className="mt-3 text-left">
          Demo data reset.
        </Banner>
      )}
      {step === "error" && (
        <Banner tone="danger" className="mt-3 text-left">
          Could not reset: {error}
        </Banner>
      )}
    </div>
  );
}
