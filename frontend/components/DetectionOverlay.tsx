"use client";

// SCRUM-29: report photo with one box per detection. box_xyxy is in pixels of the original image, so the
// boxes are placed in % of the image's natural size and stay aligned at any rendered width.

import { useState } from "react";

import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { classLabel, formatConfidence } from "@/lib/format";
import type { Detection } from "@/lib/types";

export interface DetectionOverlayProps {
  /** Report.photo_url (a /media path) or an absolute URL. */
  photoUrl: string;
  detections: Detection[];
  /** Box drawn emphasised (e.g. the row the user points at). */
  activeId?: number | null;
  onBoxClick?: (id: number) => void;
  alt?: string;
  className?: string;
}

interface NaturalSize {
  src: string;
  w: number;
  h: number;
}

export default function DetectionOverlay({ photoUrl, detections, activeId = null, onBoxClick, alt = "Report photo", className }: DetectionOverlayProps) {
  const src = mediaUrl(photoUrl);
  const [size, setSize] = useState<NaturalSize | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const natural = size && size.src === src ? size : null;

  if (failed === src) {
    return (
      <div className={cn("flex aspect-[4/3] w-full items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500", className)}>
        Photo could not be loaded
      </div>
    );
  }

  return (
    <div className={cn("relative w-full overflow-hidden rounded-xl bg-slate-100", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- backend media (SVG/JPEG), sized by its natural size */}
      <img
        src={src}
        alt={alt}
        className="block h-auto w-full"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) setSize({ src, w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setFailed(src)}
      />
      {natural &&
        detections.map((d, i) => {
          const [x1, y1, x2, y2] = d.box_xyxy;
          const left = (Math.min(x1, x2) / natural.w) * 100;
          const top = (Math.min(y1, y2) / natural.h) * 100;
          const width = (Math.abs(x2 - x1) / natural.w) * 100;
          const height = (Math.abs(y2 - y1) / natural.h) * 100;
          const active = d.id === activeId;
          const labelInside = top < 8; // no room above the box: put the tag inside
          const tag = `${i + 1} · ${classLabel(d.cls)} ${formatConfidence(d.confidence)}`;
          const boxClass = cn(
            "absolute rounded-sm border-2",
            d.flagged_wrong ? "border-dashed border-slate-300" : active ? "border-accent" : "border-amber-400",
            active && "ring-2 ring-white/70",
            onBoxClick && "cursor-pointer",
          );
          const style = { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
          const label = (
            <span
              className={cn(
                "absolute left-[-2px] max-w-[220px] truncate rounded px-1 text-[10px] leading-4 font-semibold whitespace-nowrap",
                labelInside ? "top-0" : "top-0 -translate-y-full",
                d.flagged_wrong ? "bg-slate-300 text-slate-700 line-through" : active ? "bg-accent text-white" : "bg-amber-400 text-slate-900",
              )}
            >
              {tag}
            </span>
          );
          return onBoxClick ? (
            <button key={d.id} type="button" className={boxClass} style={style} onClick={() => onBoxClick(d.id)} aria-label={`Detection ${tag}`}>
              {label}
            </button>
          ) : (
            <div key={d.id} className={boxClass} style={style} aria-label={`Detection ${tag}`}>
              {label}
            </div>
          );
        })}
    </div>
  );
}
