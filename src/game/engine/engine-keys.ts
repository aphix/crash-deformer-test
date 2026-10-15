import type { SceneId } from "../scenes/scene-id.ts";

/**
 * Keys with a job while a car is driven, followed or raced, beside the pedals, wheel, handbrake and boost in `DRIVE_KEYS`
 * (`KeyboardEvent.code`s). A scene key must be none of these or of `DRIVE_KEYS` (`engine-keys.test.ts`).
 */
export const SEAT_KEYS = {
  camera: ["KeyV", "KeyT", "KeyC"],
  previousCar: "KeyQ",
  nextCar: "KeyE",
  reset: "KeyR",
  stepOut: "Escape",
  lookBack: "Backquote",
  mouseLook: "Semicolon",
  raceView: "KeyH",
};

/** The scene picks by key: the code, the label the key list shows, and the scene. The same key again goes back to the fleet. */
export const SCENE_KEY_BINDINGS: readonly { code: string; label: string; scene: SceneId }[] = [
  { code: "Equal", label: "=", scene: "derby" },
  { code: "KeyZ", label: "Z", scene: "race" },
  { code: "Minus", label: "-", scene: "survival" },
  { code: "BracketLeft", label: "[", scene: "press" },
  { code: "KeyI", label: "I", scene: "pistons" },
  { code: "KeyN", label: "N", scene: "doors" },
  { code: "Comma", label: ",", scene: "corkscrew" },
  { code: "Slash", label: "/", scene: "stack" },
];

export const SCENE_KEY_SCENES: Readonly<Partial<Record<string, SceneId>>> = Object.fromEntries(SCENE_KEY_BINDINGS.map((binding) => [binding.code, binding.scene]));
