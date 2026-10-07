/** What a submission is: a bench card's JSON, a JSON trace capture, a flagged replay clip. */
export const KIND = { bench: "bench", capture: "capture", flag: "flag" } as const;
export const KINDS = [KIND.bench, KIND.capture, KIND.flag] as const;
export type Kind = (typeof KINDS)[number];

const MB = 1024 * 1024;

/**
 * The most JSON text (bytes) each kind may carry, once any gzip is undone: the server refuses more, the client does not send it. Each is
 * twice the largest real one measured (owner traces, 2026-10-04, and bench cards and a reel clip from the browser, 2026-10-07):
 *  - bench: a card is 19 kB (strip and city, measured in the browser, the HUD state included; the result alone is 11 kB), so 48 kB;
 *  - capture: 46 samples of 8 cars are 5.9 MB, 41 samples of 11 cars 6.8 MB (about 166 kB a sample), so a full capture of 96 samples
 *    (`MAX_SAMPLES`) is 16 MB, and the cap 32 MB;
 *  - flag: a clip is 95k characters in practice (measured) and the game's own limit is 300k (`CLIP_MAX_CHARS`), so 400 kB with the envelope.
 */
export const MAX_JSON_BYTES: Readonly<Record<Kind, number>> = {
  bench: 48 * 1024,
  capture: 32 * MB,
  flag: 400 * 1024,
};

/**
 * The most bytes a request may put on the wire. A capture gzips to 0.33-0.69 MB (8-20 x): a full one is about 1.5 MB, and the cap twice
 * that. A body that is not gzipped (a browser without `CompressionStream`) must fit it as it is.
 */
export const MAX_WIRE_BYTES = 3 * MB;

/** The receipt id the server returns: two groups of four, from an alphabet without 0/O, 1/I/L and U. */
export const RECEIPT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECEIPT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** Flat knobs sent with a submission: the scene's seed, the fx tier, the bench loop's session, ... */
export type Settings = Record<string, string | number | boolean | null>;

/** Everything a request carries; the server stores exactly these fields (anything else is dropped). */
export interface Envelope {
  kind: Kind;
  /** The running build's commit (`__BUILD_SHA__`). */
  sha: string;
  /** The client's clock, ms since the epoch. */
  at: number;
  ua: string;
  screen: { w: number; h: number; dpr: number };
  scene: string;
  settings: Settings;
  payload: unknown;
}
