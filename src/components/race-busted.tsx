import { Siren, Skull } from "lucide-react";
import type { RaceHud } from "@/game/match/types";

/**
 * Centre-screen end-of-run banner: the police stopped your car (`BUST`), or, in Survival, the car is wrecked (engine dead or
 * upside down for good; a thrown driver has its own banner). It shows until the camera moves on.
 */
export function BustedBanner({ race }: { race: RaceHud }) {
  const you = race.you;
  if (!you || race.spectating !== null) return null;
  const wrecked = race.survival !== null && you.status === "out" && !you.busted && !you.driverOut;
  if (!you.busted && !wrecked) return null;
  const Icon = you.busted ? Siren : Skull;
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl bg-signal-red px-6 py-3 text-fg shadow-lg" role="alert">
      <p className="flex items-center gap-3 font-display text-4xl font-semibold uppercase leading-none tracking-widest sm:text-6xl">
        <Icon className="size-8 sm:size-12" />
        {you.busted ? "Busted" : "Wrecked"}
      </p>
      <p className="text-sm font-medium sm:text-base">
        {you.busted ? (race.survival ? "The cops boxed you in: the run is over" : "The police stopped you: out of the race") : "Your car is totaled: the run is over"}
      </p>
    </div>
  );
}
