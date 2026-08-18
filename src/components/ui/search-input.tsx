"use client";

import { useId, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SearchInputProps {
  label: string;
  placeholder?: string;
  defaultValue?: string;
  /**
   * Makes the input controlled.
   *
   * Optional so the uncontrolled callers stay as they are. It exists because a
   * caller that can *reset* the search — a "Clear filters" button, a URL the
   * person navigated to — needs the box to follow, and an input holding its own
   * state cannot be told to. Supply this and `onChange` together.
   */
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function SearchInput({
  label,
  placeholder = "Search…",
  defaultValue = "",
  value: controlledValue,
  onChange,
  className,
}: SearchInputProps) {
  const id = useId();
  const [internalValue, setInternalValue] = useState(defaultValue);

  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  function update(next: string) {
    // The internal copy is still kept in sync when uncontrolled; when
    // controlled the parent owns it and writing here would fight them.
    if (!isControlled) setInternalValue(next);
    onChange?.(next);
  }

  return (
    <div className={cn("relative min-w-0", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
        aria-hidden
      />
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => update(event.target.value)}
        className="h-9 w-full rounded-lg border border-gray-300 bg-white pr-8 pl-9 text-[13px] text-gray-950 placeholder:text-gray-400 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => update("")}
          className="absolute top-1/2 right-2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="size-3.5" aria-hidden />
          <span className="sr-only">Clear search</span>
        </button>
      ) : null}
    </div>
  );
}
