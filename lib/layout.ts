// Physical roof layout, matching the Enphase app's Array view: 3 rows of
// landscape panels (8, 8, 7). The gateway doesn't report positions, so:
//   - a serial string pins that microinverter to the slot
//   - null leaves the slot to be filled with the remaining panels in serial order
// To pin a panel, tap it in the Enphase app's Array view to see its serial and
// put it in the matching slot here.

export const ARRAY_ROWS: (string | null)[][] = [
  [null, "202015011110", null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, "202101033131", null, null, null, null, null],
];

export function placePanels<T extends { sn: string }>(panels: T[]): (T | null)[][] {
  const bySn = new Map(panels.map((p) => [p.sn, p]));
  const pinned = new Set(ARRAY_ROWS.flat().filter((s): s is string => !!s && bySn.has(s)));
  const rest = panels.filter((p) => !pinned.has(p.sn)).sort((a, b) => a.sn.localeCompare(b.sn));
  const rows = ARRAY_ROWS.map((row) => row.map((sn) => (sn && bySn.has(sn) ? bySn.get(sn)! : null)));
  for (const row of rows) for (let i = 0; i < row.length; i++) if (!row[i]) row[i] = rest.shift() ?? null;
  // Any panels beyond the known layout (e.g. after an expansion) go on an extra row.
  if (rest.length) rows.push(rest);
  return rows;
}
