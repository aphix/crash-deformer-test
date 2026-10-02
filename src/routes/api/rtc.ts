import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { handleSignaling } from "@/lib/multiplayer/signaling.server";

const handle = ({ request }: { request: Request }) => handleSignaling(request, getSql);

export const Route = createFileRoute("/api/rtc")({
  server: { handlers: { GET: handle, POST: handle } },
});
