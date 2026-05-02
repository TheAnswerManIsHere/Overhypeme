import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface ResponsiveColumn<T> {
  key: string;
  header: ReactNode;
  /** Renders the desktop table cell content. */
  cell: (row: T) => ReactNode;
  /** Optional separate label for the mobile card. Falls back to `header`. */
  mobileLabel?: ReactNode;
  /** Optional override for the mobile value. Falls back to `cell`. */
  mobileValue?: (row: T) => ReactNode;
  /** th + td className for the desktop table. */
  className?: string;
  /** Force a column to be hidden in the mobile card layout (e.g. status badge handled in primary). */
  hideOnMobile?: boolean;
  /** Hide this column behind the per-card "Show more" toggle on mobile. */
  mobileSecondary?: boolean;
  /** Header-only className. */
  headerClassName?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  getKey: (row: T) => string | number;
  /** Optional tap target for the entire row (also applied to the mobile card). */
  onRowClick?: (row: T) => void;
  /** Renders the prominent area of the mobile card (e.g. recipient + status). */
  mobilePrimary?: (row: T) => ReactNode;
  /** Renders below the meta rows on mobile (e.g. action button). */
  mobileFooter?: (row: T) => ReactNode;
  /** Number of placeholder rows when loading. */
  loading?: boolean;
  emptyState?: ReactNode;
  /** ClassName applied to the outer wrapper of the desktop table. */
  tableContainerClassName?: string;
  /** ClassName applied to the outer wrapper of the mobile card stack. */
  mobileContainerClassName?: string;
  /** Pagination/footer content rendered after the rows on both layouts. */
  footer?: ReactNode;
}

interface MobileCardProps<T> {
  row: T;
  rowKey: string | number;
  primaryColumns: ResponsiveColumn<T>[];
  secondaryColumns: ResponsiveColumn<T>[];
  mobilePrimary?: (row: T) => ReactNode;
  mobileFooter?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
}

function renderMetaRows<T>(
  row: T,
  cols: ResponsiveColumn<T>[],
): ReactNode {
  const items: ReactNode[] = [];
  for (const c of cols) {
    const value = c.mobileValue ? c.mobileValue(row) : c.cell(row);
    if (value === null || value === undefined || value === false) continue;
    items.push(
      <div key={c.key} className="grid grid-cols-[88px_1fr] gap-2 items-start">
        <dt className="text-muted-foreground font-medium uppercase tracking-wide text-[10px] pt-0.5">
          {c.mobileLabel ?? c.header}
        </dt>
        <dd className="text-foreground min-w-0 break-words">{value}</dd>
      </div>,
    );
  }
  if (items.length === 0) return null;
  return <dl className="space-y-1.5 text-xs">{items}</dl>;
}

function MobileCard<T>({
  row,
  rowKey,
  primaryColumns,
  secondaryColumns,
  mobilePrimary,
  mobileFooter,
  onRowClick,
}: MobileCardProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const hasSecondary = secondaryColumns.length > 0;

  return (
    <li
      key={rowKey}
      className={`p-4 ${onRowClick ? "cursor-pointer active:bg-muted/30" : ""}`}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
    >
      {mobilePrimary && <div className="mb-2">{mobilePrimary(row)}</div>}
      {renderMetaRows(row, primaryColumns)}
      {hasSecondary && expanded && (
        <div className="mt-2 pt-2 border-t border-dashed border-border/60">
          {renderMetaRows(row, secondaryColumns)}
        </div>
      )}
      {hasSecondary && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-2 inline-flex items-center gap-1 min-h-[44px] px-2 -ml-2 text-xs font-medium text-primary hover:text-primary/80"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              Show {secondaryColumns.length} more field{secondaryColumns.length === 1 ? "" : "s"}
            </>
          )}
        </button>
      )}
      {mobileFooter && <div className="mt-3">{mobileFooter(row)}</div>}
    </li>
  );
}

export function ResponsiveTable<T>({
  columns,
  rows,
  getKey,
  onRowClick,
  mobilePrimary,
  mobileFooter,
  loading = false,
  emptyState,
  tableContainerClassName,
  mobileContainerClassName,
  footer,
}: ResponsiveTableProps<T>) {
  const desktopColspan = columns.length;
  const visibleOnMobile = columns.filter((c) => !c.hideOnMobile);
  const primaryColumns = visibleOnMobile.filter((c) => !c.mobileSecondary);
  const secondaryColumns = visibleOnMobile.filter((c) => !!c.mobileSecondary);

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Desktop table — hidden on small screens */}
      <div className={`hidden md:block overflow-x-auto ${tableContainerClassName ?? ""}`}>
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2.5 ${c.className ?? ""} ${c.headerClassName ?? ""}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={desktopColspan} className="px-3 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={desktopColspan} className="px-3 py-10 text-center text-muted-foreground">
                  {emptyState ?? "No records."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={getKey(row)}
                  className={`border-t border-border hover:bg-muted/20 transition-colors align-top ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2.5 ${c.className ?? ""}`}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile card stack — shown only on small screens */}
      <div className={`md:hidden ${mobileContainerClassName ?? ""}`}>
        {loading && rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-sm">
            {emptyState ?? "No records."}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const rowKey = getKey(row);
              return (
                <MobileCard
                  key={rowKey}
                  row={row}
                  rowKey={rowKey}
                  primaryColumns={primaryColumns}
                  secondaryColumns={secondaryColumns}
                  mobilePrimary={mobilePrimary}
                  mobileFooter={mobileFooter}
                  onRowClick={onRowClick}
                />
              );
            })}
          </ul>
        )}
      </div>

      {footer}
    </div>
  );
}
