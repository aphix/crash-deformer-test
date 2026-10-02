import { useStoredString } from "@/components/use-stored-string";
import { DRIVER_CARS } from "@/game/match/types";

/** The player's name and car type (a `DRIVER_CARS` id), kept in localStorage; `CrashLab` mirrors them into the engine. */
export function useDriver(): { name: string; car: string; setName: (name: string) => void; setCar: (car: string) => void } {
  const [name, setName] = useStoredString("crush.driver.name", "", "");
  const [car, setCar] = useStoredString("crush.driver.car", DRIVER_CARS[0]!.id, DRIVER_CARS[0]!.id);
  return { name, car, setName, setCar };
}
