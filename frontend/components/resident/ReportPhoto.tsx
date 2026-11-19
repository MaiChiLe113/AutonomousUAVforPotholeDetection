"use client";

// Backend report photo (Report.photo_url) with a quiet placeholder when it cannot load.
// No assumption about the file type or pixel size: thumbs and tiles crop (object-cover), "full" fits (object-contain).

import { useState } from "react";

import { Icon } from "@/components/ui";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { RESIDENT } from "@/lib/config";

export interface ReportPhotoProps {
  path: string;
  alt: string;
  /**
   * "thumb": fixed square (`size` px, default RESIDENT.listThumbPx).
   * "tile": square that fills its parent's width (photo grid).
   * "full": parent-wide, whole photo visible (detail page).
   * "large": parent-wide on a dark backdrop, up to 60% of the screen height (photo large view).
   * "banner": parent-wide strip, cropped (map popup card).
   */
  variant?: "thumb" | "tile" | "full" | "large" | "banner";
  size?: number;
  className?: string;
}

export default function ReportPhoto({ path, alt, variant = "full", size = RESIDENT.listThumbPx, className }: ReportPhotoProps) {
  const src = mediaUrl(path);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const box = {
    thumb: "shrink-0 rounded-lg border border-slate-200 bg-slate-100",
    tile: "aspect-square w-full bg-slate-100",
    full: "w-full rounded-xl border border-slate-200 bg-slate-50",
    large: "w-full bg-slate-900",
    banner: "h-32 w-full bg-slate-100",
  }[variant];
  const fit = {
    thumb: "object-cover",
    tile: "object-cover",
    full: "max-h-64 object-contain",
    large: "max-h-[60dvh] object-contain",
    banner: "object-cover",
  }[variant];
  const style = variant === "thumb" ? { width: size, height: size } : undefined;

  if (failedSrc === src) {
    return (
      <div
        role="img"
        aria-label={`${alt} (not available)`}
        style={style}
        className={cn(box, "flex items-center justify-center text-slate-400", (variant === "full" || variant === "large") && "h-40", className)}
      >
        <Icon name="photo" size={variant === "thumb" ? 18 : 28} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- photos come from the API host; no next/image remote config
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      style={style}
      className={cn(box, "block", fit, className)}
    />
  );
}
