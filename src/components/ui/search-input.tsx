"use client";

import { useId, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SearchInputProps {
  label: string;
  placeholder?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function SearchInput({
  label,
  placeholder = "Search…",
  defaultValue = "",
  onChange,
  className,
}: SearchInputProps) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);

  function update(next: string) {
    setValue(next);
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
