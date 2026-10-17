/**
 * The driven car's controls as the HUD's key line (" · " separated, outside a race), for the keyboard or a controller. The Long jump's
 * boost control is its bail, which its card names, so the line has no boost there (`boostable` false).
 */
export function driveKeys(pad: boolean, boostable: boolean): string {
  const boost = boostable ? [pad ? "X boost" : "Shift boost"] : [];
  const parts = pad
    ? ["RT gas", "LT brake, then reverse", "left stick steer", "A handbrake", ...boost, "Y view", "R3 look back", "right stick look", "LB/RB car", "D-pad ↓ recover", "Back watch"]
    : ["W gas", "S brake, then reverse", "A/D steer", "Space handbrake", ...boost, "drag look", "V view", "` look back", "R recover", "Esc watch"];
  return parts.join(" · ");
}
