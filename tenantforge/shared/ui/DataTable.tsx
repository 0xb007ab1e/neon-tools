/**
 * A semantic data table in the Cloudflare dashboard style: a header row, typed columns, optional
 * per-row status `Pill` and a per-row action affordance.
 *
 * It renders a real `<table>` with `<caption>`, `scope`d headers, and `<th scope="row">` for the
 * first cell when `rowHeader` is set — so it is accessible by construction. The component is generic
 * over the row type and prop-driven (columns describe how to render each cell); it holds no logic.
 *
 * @typeParam T - the row record type.
 */
export interface Column<T> {
  /** Stable column key (used for React keys). */
  readonly key: string;
  /** Column header label. */
  readonly header: string;
  /** Render the cell for a row. */
  readonly cell: (row: T) => React.ReactNode;
  /** When true, this column's cell is the row header (`<th scope="row">`). At most one column. */
  readonly isRowHeader?: boolean;
}

export function DataTable<T>(props: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  /** Stable React key for a row. */
  rowKey: (row: T, index: number) => string;
  /** Optional message shown (instead of the table) when there are no rows. */
  empty?: React.ReactNode;
}): React.ReactElement {
  if (props.rows.length === 0 && props.empty !== undefined) {
    return <p className="cf-table-empty">{props.empty}</p>;
  }
  return (
    <div className="cf-table-wrap">
      <table className="cf-table">
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={props.rowKey(row, i)}>
              {props.columns.map((c) =>
                c.isRowHeader === true ? (
                  <th key={c.key} scope="row">
                    {c.cell(row)}
                  </th>
                ) : (
                  <td key={c.key}>{c.cell(row)}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
