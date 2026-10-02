import type { CampaignRow, CampaignSnapshot, Entrant, RaceResultRow } from "./types.ts";

/** Points for 1st … 8th; 9th on scores nothing. */
export const CAMPAIGN_POINTS: readonly number[] = [10, 8, 6, 5, 4, 3, 2, 1];

/**
 * A playlist of courses raced in order with one field. Every classified car scores by its final
 * place (finished, out or DNF alike: in a no-reset race the order of elimination is the result).
 * Round 1's grid is the entrant order; every later grid is the standings, leader on pole.
 */
export class Campaign {
  readonly tracks: readonly string[];
  round = 0;
  private readonly rows: CampaignRow[];
  private readonly entry: Map<number, number>;

  /** `entrants` in round-1 grid order; each keeps its aggression for every round. */
  constructor(tracks: readonly string[], entrants: readonly Entrant[]) {
    if (tracks.length === 0) throw new Error("a campaign needs at least one track");
    this.tracks = tracks;
    this.rows = entrants.map((e) => ({ id: e.id, name: e.name, kind: e.kind, aggression: e.aggression, points: 0, wins: 0, places: [] }));
    this.entry = new Map(entrants.map((e, i) => [e.id, i]));
  }

  static restore(snap: CampaignSnapshot): Campaign {
    const byId = new Map(snap.standings.map((r) => [r.id, r]));
    const c = new Campaign(
      snap.tracks,
      snap.entry.map((id) => {
        const r = byId.get(id)!;
        return { id, name: r.name, kind: r.kind, aggression: r.aggression };
      }),
    );
    c.round = snap.round;
    for (const row of c.rows) Object.assign(row, structuredClone(byId.get(row.id)!));
    return c;
  }

  get done(): boolean {
    return this.round >= this.tracks.length;
  }

  /** Track id of the round about to be raced, null when the campaign is over. */
  get trackId(): string | null {
    return this.done ? null : this.tracks[this.round]!;
  }

  /** Car ids in grid order for the current round. */
  grid(): number[] {
    if (this.round === 0) return this.rows.map((r) => r.id);
    return this.standings().map((r) => r.id);
  }

  /** Score a finished round and move to the next. */
  record(results: readonly RaceResultRow[]): void {
    if (this.done) throw new Error("the campaign is over");
    for (const row of this.rows) row.places.push(0);
    for (const res of results) {
      const row = this.rows.find((r) => r.id === res.id);
      if (!row) continue;
      row.places[this.round] = res.place;
      row.points += CAMPAIGN_POINTS[res.place - 1] ?? 0;
      if (res.place === 1) row.wins++;
    }
    this.round++;
  }

  /** Points, then wins, then the better place in the latest round, then entry order. */
  standings(): CampaignRow[] {
    const last = this.round - 1;
    const placed = (r: CampaignRow) => (last >= 0 && r.places[last]! > 0 ? r.places[last]! : Infinity);
    return [...this.rows]
      .sort((a, b) => b.points - a.points || b.wins - a.wins || placed(a) - placed(b) || this.entry.get(a.id)! - this.entry.get(b.id)!)
      .map((r) => ({ ...r, places: [...r.places] }));
  }

  snapshot(): CampaignSnapshot {
    return { tracks: [...this.tracks], round: this.round, entry: this.rows.map((r) => r.id), standings: this.standings() };
  }
}
