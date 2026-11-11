import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-sm",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50",
  ghost: "bg-transparent text-accent hover:bg-accent-soft",
  danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50", // outlined: "Reject" next to "Approve"
  destructive: "bg-red-600 text-white hover:bg-red-700 shadow-sm", // solid: confirm a reject
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Icon element shown before the label (e.g. <Icon name="check" />). */
  icon?: ReactNode;
}

export function buttonClasses({ variant = "primary", size = "md", fullWidth }: Common, className?: string) {
  return cn(
    "tap-target inline-flex select-none items-center justify-center whitespace-nowrap rounded-full font-medium transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends Common, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export function Button({ variant, size, fullWidth, icon, loading, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth }, className)}
      {...rest}
    >
      {loading ? <Spinner size={14} label="Working" /> : icon}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends Common, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
}

/** A next/link styled as a Button (e.g. "Track this report"). */
export function ButtonLink({ variant, size, fullWidth, icon, className, children, href, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClasses({ variant, size, fullWidth }, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
