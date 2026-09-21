import { createFileRoute } from "@tanstack/react-router";
import { CrashLab } from "@/components/crash-lab";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <CrashLab />;
}
