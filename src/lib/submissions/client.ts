/**
 * The game's side of a submission (`submissions.server.ts`): the envelope every post carries (the running build,
 * the device, the clock, the scene and its settings) and the post itself, answered with the receipt the player keeps.
 */
import { MAX_JSON_BYTES, MAX_WIRE_BYTES, type Envelope, type Kind, type Settings } from "./kinds.ts";

const URL_PATH = `${import.meta.env?.BASE_URL ?? "/"}api/submissions`;

/** What the game says about the scene a submission came from. */
export interface SubmitContext {
  scene: string;
  settings: Settings;
}

/** The running build and the device a post comes from. */
export interface Device {
  sha: string;
  ua: string;
  screen: { w: number; h: number; dpr: number };
}

export type SubmitResult = { id: string } | { error: string };

/** What a refusal means to the player; any other status is reported by number. */
const REFUSED: Readonly<Record<number, string>> = {
  413: "too big to send",
  415: "the server refused the format",
  429: "too many submissions just now, try again in a minute",
  503: "the server is busy, try again in a minute",
  507: "the server's store is full",
};

/** This page's build and screen, as the server stores them with every submission. */
export function thisDevice(): Device {
  return {
    sha: __BUILD_SHA__,
    ua: navigator.userAgent.slice(0, 512),
    screen: { w: Math.round(screen.width) || 1, h: Math.round(screen.height) || 1, dpr: window.devicePixelRatio || 1 },
  };
}

/** A byte count a player reads: rounded up to a whole KB, or MB to a tenth past 1 MB. */
function sizeText(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** The envelope for one submission. `settings` values are flat (the server refuses nested ones). */
export function envelopeOf(kind: Kind, context: SubmitContext, payload: unknown, device: Device, now: number): Envelope {
  return { kind, sha: device.sha, at: now, ua: device.ua, screen: device.screen, scene: context.scene, settings: context.settings, payload };
}

/** What `submit` reaches the world through: tests give their own. */
interface Ports {
  fetch: typeof fetch;
  device: Device;
  now: number;
  /** Gzip the body (`CompressionStream`, in every current browser): a capture goes in a tenth of the bytes. */
  gzip: boolean;
}

/** `text` gzipped. */
async function gzipped(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Post one submission; resolves to its receipt id, or to why it did not go (never rejects: the button shows the text). */
export async function submit(kind: Kind, context: SubmitContext, payload: unknown, ports?: Partial<Ports>): Promise<SubmitResult> {
  const text = JSON.stringify(envelopeOf(kind, context, payload, ports?.device ?? thisDevice(), ports?.now ?? Date.now()));
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_JSON_BYTES[kind]) return { error: `too big to send (${sizeText(bytes)}, at most ${sizeText(MAX_JSON_BYTES[kind])})` };
  const gzip = ports?.gzip ?? typeof CompressionStream === "function";
  try {
    const body = gzip ? await gzipped(text) : text;
    const wire = typeof body === "string" ? bytes : body.length;
    if (wire > MAX_WIRE_BYTES) return { error: `too big to send (${sizeText(wire)} on the wire, at most ${sizeText(MAX_WIRE_BYTES)})` };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (gzip) headers["content-encoding"] = "gzip";
    const res = await (ports?.fetch ?? fetch)(URL_PATH, { method: "POST", headers, body });
    if (res.status !== 201) return { error: REFUSED[res.status] ?? `the server answered ${res.status}` };
    const reply: unknown = await res.json();
    return typeof reply === "object" && reply !== null && "id" in reply && typeof reply.id === "string" ? { id: reply.id } : { error: "the server sent no receipt" };
  } catch {
    return { error: "could not reach the server" };
  }
}
