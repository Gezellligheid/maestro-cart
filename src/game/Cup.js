export const CUP_RACES = 4;
export const CUP_POINTS = [15, 12, 10, 8, 6, 4, 2, 1];

/**
 * Grand Prix: four races in a row, points per finishing place, and a trophy podium for the
 * overall top three after the last race. Kept by the solo player / host; clients get the table.
 */
export class Cup {
  constructor() {
    this.race = 0;
    this.rows = new Map(); // slot -> { slot, name, look, points, last }
  }

  get over() {
    return this.race >= CUP_RACES;
  }

  nextRace() {
    this.race++;
  }

  /** order: [{ slot, name, look }] in finishing order (DNFs at the end score nothing). */
  score(order, finishedCount) {
    order.forEach((e, i) => {
      let row = this.rows.get(e.slot);
      if (!row) {
        row = { slot: e.slot, name: e.name, look: e.look, points: 0, last: 0 };
        this.rows.set(e.slot, row);
      }
      row.name = e.name;
      row.look = e.look;
      row.last = i < finishedCount ? CUP_POINTS[i] || 0 : 0;
      row.points += row.last;
    });
  }

  /** Overall table, best first (ties: better result in the latest race). */
  table() {
    return [...this.rows.values()].sort((a, b) => b.points - a.points || b.last - a.last);
  }
}
