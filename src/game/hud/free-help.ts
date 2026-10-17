/**
 * The free view's controls as the HUD's key line (" · " separated), for the keyboard and mouse, a controller, or a touch screen.
 * `FreeCam`, `readFreeInput` and the camera's pointer handlers are the behaviour this names.
 */
export function freeHelp(pad: boolean, touch: boolean): string {
  if (touch) return "drag look · two fingers pan · pinch fly · View returns";
  if (pad) return "left stick fly · right stick look · RT up · LT down · A fast · Y or Back return";
  return "W/A/S/D fly · PgUp/PgDn up/down · Shift fast · wheel speed · drag look · V or Esc return";
}
