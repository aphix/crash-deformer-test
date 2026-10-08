import type { LookData } from "../net/look-codec.ts";
import { NO_CAR_PICK, NO_PERSON_PICK, type CarPick, type PersonPick } from "../present/look-pick.ts";
import { CAR_SPRAY, packSpray, PERSON_SPRAY, SprayBitmap, unpackSpray } from "../present/spray.ts";

/** A player's look as worn: the picks and both spray bitmaps, drawn. */
export type PlayerLook = { car: CarPick; person: PersonPick; carSpray: SprayBitmap; personSpray: SprayBitmap };

/** Where this browser keeps its spray between visits (its picks ride the URL). */
const SPRAY_KEY = { car: "crush.spray.car", person: "crush.spray.person" } as const;
export type SprayTarget = keyof typeof SPRAY_KEY;

/**
 * Every player's look this browser draws: its own (`mine`: picked in the garage, the spray kept in localStorage) and each
 * netplay peer's, by car (`MSG.look`).
 */
export class PlayerLooks {
  readonly mine: PlayerLook = { car: { ...NO_CAR_PICK }, person: { ...NO_PERSON_PICK }, carSpray: new SprayBitmap(CAR_SPRAY), personSpray: new SprayBitmap(PERSON_SPRAY) };
  private readonly theirs = new Map<number, PlayerLook>();

  constructor() {
    if (typeof localStorage === "undefined") return;
    for (const target of ["car", "person"] as const) {
      const text = localStorage.getItem(SPRAY_KEY[target]);
      if (text === null) continue;
      const bitmap = this.sprayOf(target);
      bitmap.load(unpackSpray(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)), bitmap.texels.length));
    }
  }

  sprayOf(target: SprayTarget): SprayBitmap {
    return target === "car" ? this.mine.carSpray : this.mine.personSpray;
  }

  /** The look car `car` wears: this browser's on its own car `own`, else a peer's, else none. */
  of(car: number, own: number): PlayerLook | null {
    return car === own ? this.mine : (this.theirs.get(car) ?? null);
  }

  /** Car `car` takes a peer's look, or (null) none. */
  wear(car: number, look: LookData | null): void {
    this.drop(car);
    if (!look) return;
    const worn: PlayerLook = { car: look.car, person: look.person, carSpray: new SprayBitmap(CAR_SPRAY), personSpray: new SprayBitmap(PERSON_SPRAY) };
    worn.carSpray.load(look.carSpray);
    worn.personSpray.load(look.personSpray);
    this.theirs.set(car, worn);
  }

  /** Car `car`'s peer look off (every one when `car` is omitted), its bitmaps freed. */
  drop(car?: number): void {
    for (const [k, look] of this.theirs) {
      if (car !== undefined && k !== car) continue;
      look.carSpray.dispose();
      look.personSpray.dispose();
      this.theirs.delete(k);
    }
  }

  /** The cars wearing a peer's look. */
  peerCars(): IterableIterator<number> {
    return this.theirs.keys();
  }

  /** This browser's look as `MSG.look` carries it. */
  data(): LookData {
    return { car: this.mine.car, person: this.mine.person, carSpray: this.mine.carSpray.texels, personSpray: this.mine.personSpray.texels };
  }

  /** Keep `target`'s spray for the next visit. */
  save(target: SprayTarget): void {
    const bytes = packSpray(this.sprayOf(target).texels);
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
    localStorage.setItem(SPRAY_KEY[target], btoa(text));
  }

  dispose(): void {
    this.drop();
    this.mine.carSpray.dispose();
    this.mine.personSpray.dispose();
  }
}
