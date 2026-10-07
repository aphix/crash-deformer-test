List of preinstalled tools/packages in the Vercel build image (Amazon Linux 2023): is rustc / cargo / rustup preinstalled or not? Can 'curl https://sh.rustup.rs | sh -y' plus 'rustup target add wasm32-unknown-unknown' run in Vercel installCommand/buildCommand, and what are the Vercel build time limit (45 min) and build machine CPU/memory? Cite vercel.com/docs/builds/build-image and build limits docs.

The Vercel build image is based on Amazon Linux 2023, and the docs say some packages are preinstalled via `dnf`, but the snippet available here does **not** list `rustc`, `cargo`, or `rustup` as preinstalled, so those should be treated as **not guaranteed preinstalled** from the cited docs alone[5].

Yes, `curl https://sh.rustup.rs | sh -y` followed by `rustup target add wasm32-unknown-unknown` can run in Vercel `installCommand`/`buildCommand` in principle, but that installation step will consume build time and must finish within Vercel’s build limits[2][7]. Vercel’s build timeout is **45 minutes per deployment/build step**, and the standard build machine is **4 CPUs and 8 GB memory** on Pro/Enterprise, while Hobby uses **2 CPUs and 8 GB memory**[2][3][7].

## Practical takeaway
- `rustc` / `cargo` / `rustup`: **not shown as preinstalled** in the cited build-image docs[5].
- Rust via `rustup`: **possible during the build**, but it increases build time and can fail if it pushes the build past the 45-minute cap[2][7].
- Build machine resources: **4 vCPUs / 8 GB** for standard Pro/Enterprise builds; **2 vCPUs / 8 GB** on Hobby[2][3][8].

If you want, I can turn this into a copy-paste Vercel config recommendation for Rust/Wasm builds.

[1] Limits (https://www.vercel.reviews/docs/limits)
[2] Builds (https://vercel.com/docs/builds)
[3] Troubleshooting Build Errors (https://vercel.com/docs/deployments/troubleshoot-a-build)
[4] Additional resources (https://vercel.com/docs/limits/fair-use-guidelines)
[5] Build image overview - Vercel (https://vercel.com/docs/builds/build-image)
[6] Execution (https://inetgeek.com/hosting/vercel/)
[7] Build step did not complete within the maximum of 45 minutes - Vercel (https://vercel.com/kb/guide/troubleshooting-build-error-build-step-did-not-complete-within-45-minutes)
[8] Managing Builds (https://vercel.com/docs/builds/managing-builds)
[9] How do I reduce my build time with Next.js on Vercel? (https://vercel.com/kb/guide/how-do-i-reduce-my-build-time-with-next-js-on-vercel)
[10] vercel/sandbox - GitHub (https://github.com/vercel/sandbox)
[11] Topics tagged builds - Vercel Community (https://community.vercel.com/tag/builds/56)
[12] Legacy Usage & Pricing for Functions (https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing)
[13] Vercel Pricing in 2026: Plans, Credits, and What You'll Actually Pay (https://flexprice.io/blog/vercel-pricing-breakdown)
[14] Vercel Hobby Plan (https://vercel.com/docs/plans/hobby)
[15] Deployment's build step did not complete within the maximum of 45min · vercel · Discussion #4529 (https://github.com/orgs/vercel/discussions/4529)
