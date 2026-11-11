"use client";

// Photo picker with client-side checks and a preview (FR-06, SCRUM-30).
// Only a valid JPEG / PNG up to UPLOAD.maxMb reaches onChange; anything else shows an error and is never sent.

import { useEffect, useId, useRef, useState } from "react";

import { Button, Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { UPLOAD } from "@/lib/config";

export interface PhotoPickerProps {
  /** The accepted photo, or null when none / invalid. */
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

const MAX_BYTES = UPLOAD.maxMb * 1024 * 1024;

/** Error text for a file that may not be sent, or null when it is fine. */
export function photoProblem(file: File): string | null {
  if (!UPLOAD.allowedTypes.includes(file.type)) return "Choose a JPEG or PNG photo.";
  if (file.size > MAX_BYTES) return `The photo is larger than ${UPLOAD.maxMb} MB. Choose a smaller one.`;
  if (file.size === 0) return "The photo is empty. Choose another one.";
  return null;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PhotoPicker({ file, onChange, disabled = false }: PhotoPickerProps) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Object URL for the preview; revoked when the file changes or the picker unmounts.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [file]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0] ?? null;
    e.target.value = ""; // picking the same file again still fires change
    if (!chosen) return;
    const problem = photoProblem(chosen);
    setError(problem);
    onChange(problem ? null : chosen);
  }

  function remove() {
    setError(null);
    onChange(null);
  }

  return (
    <div className="min-w-0">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={UPLOAD.accept}
        onChange={pick}
        disabled={disabled}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className="peer sr-only"
      />

      {file && preview ? (
        <div className="min-w-0">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img src={preview} alt="Preview of the chosen photo" className="block max-h-56 w-full object-contain" />
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm text-slate-600" title={file.name}>
              {file.name} · {formatSize(file.size)}
            </p>
            <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>
              Change
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} disabled={disabled} aria-label="Remove photo">
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className={cn(
            "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
            error ? "border-red-300 bg-red-50/50" : "border-slate-300 bg-slate-50 hover:border-accent hover:bg-accent-soft",
            disabled && "pointer-events-none opacity-50",
          )}
        >
          <Icon name="photo" size={26} className="text-slate-500" />
          <span className="text-sm font-medium text-slate-900">Add a photo of the pothole</span>
          <span className="text-xs text-slate-500">JPEG or PNG, up to {UPLOAD.maxMb} MB</span>
        </label>
      )}

      {error && (
        <p id={errorId} role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-red-700">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}
    </div>
  );
}
