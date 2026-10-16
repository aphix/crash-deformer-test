import * as THREE from "three";
import { makeStationSurface, STATION_SURFACE_STYLES } from "./minigame-surface-art.ts";

/**
 * The long jump station in station-local coordinates (+x throw, x = 0 the lip at the jersey barrier, y from the pad): the grey
 * asphalt of the start pad (yellow bars), the hill down, the run-up and the 7 degree incline up to the barrier. The sand, kerb and
 * distance signs past the barrier are the attract range's (`makeRangeArt`), which stays shown; the barrier is the engine's.
 */
export function makeLongJumpArt(): THREE.Group {
  const art = new THREE.Group();
  art.name = "long-jump";
  art.add(makeStationSurface("longJump", STATION_SURFACE_STYLES.longJump));
  return art;
}
