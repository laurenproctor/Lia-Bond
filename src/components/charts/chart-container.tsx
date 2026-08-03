import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { CardHeader } from "@/components/ui/card";

export interface ChartLegendItem {
  label: string;
  color: string;
  /** Optional value shown beside the label; keeps identity off colour alone. */
  value?: string;
}

export interface ChartContainerProps {
  title: string;
  description?: string;
  hint?: string;
  actions?: ReactNode;
  legend?: ChartLegendItem[];
  /** Fixed plot height. Charts never size themselves from content. */
  height?: number;
  children: ReactNode;
  /** Accessible fallback: the same numbers as text for screen readers. */
  summary?: string;
  className?: string;
  footer?: ReactNode;
}

/**
 * The frame every chart sits in: title, legend, fixed-height plot area, and a
 * text summary. Charts themselves only draw marks.
 */
export function ChartContainer({
  title,
  description,
  hint,
  actions,
  legend,
  height = 240,
  children,
  summary,
  className,
  footer,
}: ChartContainerProps) {
  return (
    <section className={cn("lia-card flex min-w-0 flex-col p-5", className)}>
      <CardHeader
        title={title}
        description={description}
        hint={hint}
        actions={actions}
      />

      {legend && legend.length > 0 ? (
        <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {legend.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-1.5 text-[12.5px] text-gray-700"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: item.color }}
                aria-hidden
              />
              {item.label}
              {item.value ? (
                <span className="font-medium text-gray-500 tabular-nums">
                  {item.value}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 min-w-0" style={{ height }}>
        {children}
      </div>

      {summary ? <p className="sr-only">{summary}</p> : null}
      {footer ? <div className="mt-3">{footer}</div> : null}
    </section>
  );
}
