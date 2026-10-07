import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import { NET_TX, type NetTx } from "@/game/net/net-ports";
import { cn } from "@/lib/utils";

/** Buttons and fields: 44 px tall on phones, 32 px from `sm`. */
const CONTROL = "h-11 sm:h-8";
/** Generated codes: 8 of these 32 characters (no I, O, 0 or 1) from `crypto.getRandomValues`, 40 bits, unguessable. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type PrivateRoomFormProps = {
  engine: RefObject<CrashEngine | null>;
  room: string;
  onRoom: (room: string) => void;
  tx: NetTx;
  onTx: (tx: NetTx) => void;
};

/** Host or join a private room by its code (an empty field hosts a generated one) over the Internet or between this browser's tabs. */
export function PrivateRoomForm({ engine, room, onRoom, tx, onTx }: PrivateRoomFormProps) {
  const start = (role: "host" | "join"): void => {
    const current = engine.current;
    if (!current) return;
    const code = room.trim().toUpperCase() || Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b & 31]).join("");
    onRoom(code);
    if (role === "host") current.net.host(code, tx);
    else current.net.join(code, tx);
  };
  return (
    <div className="space-y-1.5">
      <p className="hud-label">Private room</p>
      <label className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Room</span>
        <input
          value={room}
          onChange={(e) => onRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          placeholder="new code"
          maxLength={12}
          aria-label="Room code"
          className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2 font-display uppercase")}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Link</span>
        <select
          value={tx}
          onChange={(e) => onTx(e.target.value === NET_TX.bc ? NET_TX.bc : NET_TX.rtc)}
          aria-label="Connection"
          className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2")}
        >
          <option value={NET_TX.rtc}>Internet (WebRTC)</option>
          <option value={NET_TX.bc}>This browser (tabs)</option>
        </select>
      </label>
      <div className="flex gap-1">
        <Button className={cn(CONTROL, "flex-1 text-xs")} onClick={() => start("host")}>
          Host
        </Button>
        <Button variant="secondary" className={cn(CONTROL, "flex-1 text-xs")} disabled={!room.trim()} onClick={() => start("join")}>
          Join
        </Button>
      </div>
    </div>
  );
}
