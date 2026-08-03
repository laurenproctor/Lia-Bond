import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "destructive"
  | "dark";

export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-purple-600 text-white border border-purple-600 hover:bg-purple-500 active:bg-purple-600",
  secondary:
    "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:text-gray-950 active:bg-gray-100",
  ghost:
    "bg-transparent text-gray-700 border border-transparent hover:bg-gray-100 hover:text-gray-950",
  destructive:
    "bg-white text-red-600 border border-red-600/40 hover:bg-red-100 active:bg-red-100",
  dark: "bg-navy-900 text-white border border-navy-900 hover:bg-navy-800",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-lg",
  md: "h-9 px-3 text-[13px] gap-1.5 rounded-lg",
  lg: "h-11 px-4 text-sm gap-2 rounded-[10px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconPosition?: "leading" | "trailing";
  /** Renders the icon alone; `children` becomes the accessible name. */
  iconOnly?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconPosition = "leading",
  iconOnly = false,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        iconOnly && (size === "lg" ? "w-11 px-0" : size === "md" ? "w-9 px-0" : "w-8 px-0"),
        className,
      )}
      {...props}
    >
      {Icon && iconPosition === "leading" ? (
        <Icon className="size-4 shrink-0" aria-hidden />
      ) : null}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
      {Icon && iconPosition === "trailing" && !iconOnly ? (
        <Icon className="size-4 shrink-0" aria-hidden />
      ) : null}
    </button>
  );
}
