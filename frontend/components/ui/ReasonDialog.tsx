"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Banner } from "./Banner";
import { Button } from "./Button";

export interface ReasonDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Textbox label. Default "Reason". */
  label?: string;
  placeholder?: string;
  /** Default "Submit". */
  submitLabel?: string;
  /** "danger" for reject actions (red submit), "primary" otherwise. Default "danger". */
  tone?: "danger" | "primary";
  /**
   * Called with the trimmed reason (never empty). The dialog shows a spinner while the promise runs,
   * calls onClose when it resolves, and shows the error message and stays open when it rejects.
   */
  onSubmit: (reason: string) => void | Promise<void>;
  onClose: () => void;
}

/** Modal with a required reason (reject report, reject plan, request plan changes). */
export function ReasonDialog(props: ReasonDialogProps) {
  // Mount the body only while open so the text and error reset each time.
  return props.open ? <DialogBody {...props} /> : null;
}

function DialogBody({
  title,
  description,
  label = "Reason",
  placeholder,
  submitLabel = "Submit",
  tone = "danger",
  onSubmit,
  onClose,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const fieldId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const trimmed = reason.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message || "Something went wrong.");
      setBusy(false);
      busyRef.current = false;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        className="animate-sheet-in w-full max-w-md min-w-0 rounded-xl bg-white p-5 shadow-float-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}

        <label htmlFor={fieldId} className="mt-4 block text-sm font-medium text-slate-700">
          {label} <span className="text-red-600">*</span>
        </label>
        <textarea
          id={fieldId}
          ref={textRef}
          required
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
          className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
        />
        {!trimmed && <p className="mt-1 text-xs text-slate-500">A reason is required.</p>}

        {error && (
          <Banner tone="danger" className="mt-3">
            {error}
          </Banner>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!trimmed}
            loading={busy}
            variant={tone === "danger" ? "destructive" : "primary"}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
