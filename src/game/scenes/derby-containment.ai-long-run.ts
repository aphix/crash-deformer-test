import { containmentCases } from "./derby-containment.test-util.ts";

// Full-sanity run, not the per-commit suite: every heading across the arena (`derby-containment.test.ts` takes every fourth).
containmentCases(1);
