import { Siren } from "lucide-react";
import type { RaceHud } from "@/game/match/types";

/** Centre-screen BUSTED banner: the police stopped your car (`BUST`); it shows until the camera moves on to the field. */
export function BustedBanner({ race }: { race: RaceHud }) {
  if (!race.you?.busted || race.spectating !== null) return null;
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl bg-signal-red px-6 py-3 text-fg shadow-lg" role="alert">
      <p className="flex items-center gap-3 font-display text-4xl font-semibold uppercase leading-none tracking-widest sm:text-6xl">
        <Siren className="size-8 sm:size-12" />
        Busted
      </p>
      <p className="text-sm font-medium sm:text-base">The police stopped you: out of the race</p>
    </div>
  );
}
