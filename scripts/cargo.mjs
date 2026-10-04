/**
 * Run a Cargo command through `mbx` (mr-boxington: a build cache shared by every checkout and target, pruned on its
 * own) when it is installed, else through plain `cargo`. Every repo script that builds Rust calls this, so builds go
 * through mbx wherever it exists and still work where it doesn't. Builds on one box run one at a time: the command
 * holds `/tmp/crash-cargo.lock` (flock) for its whole run, so parallel worktrees queue instead of fighting over CPU.
 */
import { execFileSync, spawnSync } from "node:child_process";

const has = (bin) => !spawnSync(bin, ["--version"], { stdio: "ignore" }).error;
const CARGO = has("mbx") ? "mbx" : "cargo";
const LOCKED = has("flock");

/** `cargo(["build", "--release"], { env })` runs `mbx build --release` if mbx is on PATH, else `cargo build --release`. */
export function cargo(args, opts) {
  const [bin, argv] = LOCKED ? ["flock", ["/tmp/crash-cargo.lock", CARGO, ...args]] : [CARGO, args];
  execFileSync(bin, argv, { stdio: "inherit", ...opts });
}
