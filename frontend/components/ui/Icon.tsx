// Minimal inline stroke icons (no icon library, no CDN).

const PATHS = {
  back: "M19 12H5M12 19l-7-7 7-7",
  close: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  alert: "M12 3 2 21h20L12 3zM12 10v4M12 17.5v.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  locate: "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 2v3M12 19v3M2 12h3M19 12h3M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  "chevron-up": "m18 15-6-6-6 6",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-right": "m9 18 6-6-6-6",
  camera: "M3 8h4l2-3h6l2 3h4v12H3zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  signout: "M9 4H5v16h4M16 8l4 4-4 4M20 12H9",
  pin: "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  drone:
    "M5 5h4M15 5h4M7 5v3M17 5v3M9 10h6v4H9zM7 8l2 2M17 8l-2 2M7 16l2-2M17 16l-2-2M7 16v3M17 16v3M5 19h4M15 19h4",
  refresh: "M20 11a8 8 0 0 0-14.9-3.9L4 9M4 4v5h5M4 13a8 8 0 0 0 14.9 3.9L20 15M20 20v-5h-5",
  plus: "M12 5v14M5 12h14",
  play: "M7 4v16l13-8z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  photo: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Accessible label; when omitted the icon is decorative (aria-hidden). */
  label?: string;
}

export function Icon({ name, size = 20, className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
