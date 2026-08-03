"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFilterProps {
  label: string;
  options: SelectOption[];
  defaultValue?: string;
  /** Hides the visible label and uses it as the accessible name only. */
  hideLabel?: boolean;
  onChange?: (value: string) => void;
  className?: string;
}

/**
 * A native `<select>` in a styled shell.
 *
 * Native is deliberate: it gets keyboard support, type-ahead, and mobile
 * pickers for free, which a custom listbox would have to re-earn.
 */
export function SelectFilter({
  label,
  options,
  defaultValue,
  hideLabel = true,
  onChange,
  className,
}: SelectFilterProps) {
  const id = useId();
  const [value, setValue] = useState(defaultValue ?? options[0]?.value ?? "");

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label
        htmlFor={id}
        className={cn(
          "text-[13px] font-medium text-gray-700",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </label>
      <div className="relative min-w-0">
        <select
          id={id}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onChange?.(event.target.value);
          }}
          className="h-9 w-full appearance-none rounded-lg border border-gray-300 bg-white py-0 pr-8 pl-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-gray-500"
          aria-hidden
        />
      </div>
    </div>
  );
}
