import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env.server";
import { handleSubmissions } from "@/lib/submissions/submissions.server";

const handle = ({ request }: { request: Request }) => handleSubmissions(request, getSql, env("SUBMISSIONS_OWNER_TOKEN"));

export const Route = createFileRoute("/api/submissions")({
  server: { handlers: { GET: handle, POST: handle } },
});
