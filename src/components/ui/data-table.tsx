import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/empty-state";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  /** Cell renderer. Return a node, not a string, when the cell needs a badge. */
  cell: (row: Row) => ReactNode;
  align?: "left" | "right";
  /** Applied to both the header cell and every body cell in the column. */
  className?: string;
  /** Hidden below the `lg` breakpoint so tablet widths stay readable. */
  secondary?: boolean;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  emptyTitle = "Nothing to show yet",
  emptyDescription,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className={cn("lia-scroll w-full overflow-x-auto", className)}>
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-gray-200">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  "px-4 py-2.5 text-[12px] font-semibold tracking-wide text-gray-500 uppercase",
                  column.align === "right" ? "text-right" : "text-left",
                  column.secondary && "hidden lg:table-cell",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="transition-colors hover:bg-gray-50">
              {columns.map((column) => (
                <td
                  key={column.id}
                  className={cn(
                    "px-4 py-3 text-[13px] text-gray-700 align-middle",
                    column.align === "right" ? "text-right" : "text-left",
                    column.secondary && "hidden lg:table-cell",
                    column.className,
                  )}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
