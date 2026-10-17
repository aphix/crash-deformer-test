import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MOTOR_SOUND_CREDIT } from "@/game/present/motor-tone";
import { creditLines, loadManifest, musicBase, type MusicTrack } from "@/game/present/music-manifest";

/** An external link: a new tab, with no opener and no referrer. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-accent">
      {children}
    </a>
  );
}

/**
 * The credits: the soundtrack as its manifest credits it (each song's lines and links verbatim, so adding a song to the
 * music folder adds its credit) and the engine sound generator's MIT notice. A native `<dialog>`: Esc and the Close button
 * dismiss it, and `onClose` fires either way. A missing manifest leaves the engine credit alone.
 */
export function CreditsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tracks, setTracks] = useState<readonly MusicTrack[]>([]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadManifest(musicBase(import.meta.env)).then(
      (loaded) => {
        if (!cancelled) setTracks(loaded);
      },
      (reason: unknown) => console.warn("credits: no soundtrack", reason),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);
  const engine = MOTOR_SOUND_CREDIT;
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-label="Credits"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-1rem))] overflow-y-auto rounded-lg bg-surface p-4 text-fg shadow-[var(--shadow-border)] backdrop:bg-black/60"
    >
      <h2 className="font-display text-lg font-semibold">Credits</h2>
      {tracks.length > 0 ? (
        <section className="mt-3">
          <p className="hud-label">Soundtrack</p>
          {tracks.map((track) => (
            <div key={track.file} className="mt-2 space-y-0.5 text-xs">
              {creditLines(track).map((line) => (
                <p key={line.text + (line.url ?? "")}>
                  {line.url === null ? (
                    line.text
                  ) : (
                    <>
                      {line.text} <ExternalLink href={line.url}>{line.url}</ExternalLink>
                    </>
                  )}
                </p>
              ))}
            </div>
          ))}
        </section>
      ) : null}
      <section className="mt-3">
        <p className="hud-label">Engine sound</p>
        <p className="mt-2 text-xs">
          Engine sound: {engine.name} by {engine.author} (<ExternalLink href={engine.url}>{engine.url}</ExternalLink>), {engine.license} License (
          <ExternalLink href={engine.licenseUrl}>{engine.licenseUrl}</ExternalLink>). {engine.notice}
        </p>
      </section>
      <section className="mt-3">
        <p className="hud-label">People</p>
        <p className="mt-2 text-xs">
          The drivers' and people's bodies are edited from base models by BaseMesh3d (<ExternalLink href="https://basemesh3d.com/">https://basemesh3d.com/</ExternalLink>), TurboSquid
          Standard License.
        </p>
      </section>
      <form method="dialog" className="mt-4 flex justify-end">
        <Button type="submit" variant="secondary">
          Close
        </Button>
      </form>
    </dialog>
  );
}
