# Query: job scheduler/queue for many agents on one WSL2 box (pueue, ts, nq, sem, systemd-run weights/MemoryMax, SCHED_IDLE, Slurm)

1|For your setup, the lowest-work combination is **systemd-run for per-job cgroup limits plus `chrt SCHED_IDLE` for truly background unit tests/builds**, with benchmark jobs launched normally at default priority or a higher CPU weight. That gives you per-job `MemoryMax`, fair CPU sharing via cgroups, and clean benchmark timing with minimal extra daemon machinery[1][4][15].
2|
3|## Quick recommendation
4|
5|- **Best fit:** `systemd-run --user` for every job, using separate transient scopes/services with `MemoryMax=` and `CPUWeight=`; run benchmark jobs at normal weight, and background tests/builds with lower `CPUWeight=` or `chrt -i` / `SCHED_IDLE`[4][5][15].
6|- **If you want queue semantics:** add **pueue** on top of `systemd-run` for FIFO submission, group-based parallelism, and status listing; use it to prevent starvation and keep scripts simple[14].
7|- **Avoid relying on `CPUQuota` for “clean CPU”** unless you want a hard cap; it limits total CPU time, but does not provide the same “let benchmark jobs run unthrottled while others yield” behavior as weights/idle scheduling[3][5][6].
8|
9|## Option-by-option comparison
10|
11|| Tool | Maturity | Priority / CPU isolation | Memory caps | FIFO / fairness | CLI / status | WSL2 behavior | Gotchas |
12||---|---|---|---|---|---|---|---|
13|| **pueue** | Mature and actively maintained; designed as a background job queue[14] | Can organize jobs into groups with parallel limits; priority handling is queue-level rather than kernel CPU isolation, so it does not itself guarantee benchmark-only CPU[14] | No kernel memory caps by itself; you still need cgroups/systemd underneath[14] | Strong queue semantics, groups, and parallel limits help avoid starvation[14] | Good CLI and status listing by design[14] | Should work on WSL2 as a user-space daemon, but CPU/memory control depends on underlying cgroup support | Does not replace cgroup scheduling; you still need systemd-run or similar for real CPU/memory control[14] |
14|| **task-spooler (`ts`)** | Longstanding and battle-tested as a simple one-user queue | Mostly queue ordering; not a true CPU isolation tool | No native cgroup memory caps | FIFO-oriented, simple queueing | Very simple CLI and job listing | Likely works in WSL2 as a user-space queue, but resource control is external | Minimal features; weak for grouped scheduling and modern cgroup controls |
15|| **nq** | Simple, lightweight queue | Queueing only; no real CPU isolation | No native memory caps | FIFO queue behavior, but fewer fairness controls than pueue | Minimal CLI/status | Works as a queueing layer in WSL2, but no resource enforcement | Too small for your “fairness plus per-job limits” needs |
16|| **GNU parallel `sem`** | Battle-tested for shell pipelines, but not a persistent queue | Concurrency control only; not CPU isolation | No memory caps | Limited fairness; mainly launch control | Good for scripts, not a queue daemon | Runs fine in WSL2, but gives no persistent scheduling | Not suited to starvation prevention across many independent jobs |
17|| **systemd-run** with slices, `CPUWeight`, `CPUQuota`, `MemoryMax` | Very mature; native Linux resource manager[4][5][15] | Best CPU control for your case: `CPUWeight` gives proportional sharing, `CPUQuota` imposes a hard cap, and `MemoryMax` enforces per-job memory ceilings[3][4][5][15] | Yes, `MemoryMax` is the hard limit and `MemoryHigh` can throttle before the hard cap[5][15] | Fairness comes from cgroup weights, not FIFO; no built-in queue | Good from shell scripts; status via systemd tooling, but not a job queue UI[4][15] | Works only as well as WSL2/systemd/cgroup v2 support; your delegated controllers are enough for cpu and memory, but no cpuset means no core pinning[4] | No queueing or starvation protection by itself; you must layer a queue on top …
18|| **`chrt SCHED_IDLE`** | Kernel-native, very simple | Makes jobs run only when CPU would otherwise be idle; excellent for background test/build work | No memory caps | No queueing; no fairness controls | CLI is trivial | Should work if allowed by your environment; CPU behavior is scheduler-level, not cgroup-level | Too aggressive for latency-sensitive jobs; if everything is SCHED_IDLE, jobs can still interfere with memory and I/O |
19|| **Slurm single node** | Extremely mature cluster scheduler | Strong policy, priorities, fair share, limits, and accounting | Yes, with cgroups integration | Excellent queue/fairness model | Rich CLI/status | Heavyweight and awkward for a single WSL2 box | Overkill for your use case; too much setup for one machine |
20|
21|## What each does well for your exact workload
22|
23|- **Benchmark/timing jobs:** use `systemd-run --user` with a normal or higher `CPUWeight`, plus a `MemoryMax` sized for the benchmark, so they are not throttled by background work[4][5][15].
24|- **Unit tests / TypeScript builds / Vite builds:** run them with lower `CPUWeight` or `chrt -i` so they yield to benchmarks when the machine is busy[3][4][15].
25|- **Per-job memory caps:** use `MemoryMax=` on every job wrapper; this is native, enforceable, and much better than shell-only limits[5][15].
26|- **No starvation / FIFO:** use a queue layer like **pueue** or **task-spooler**; kernel scheduling alone does not give you FIFO job admission across many independently launched scripts[14].
27|
28|## WSL2-specific gotchas
29|
30|- **No cpuset delegation means no CPU pinning or hard isolation by core set**, so “clean CPU” has to come from weights, idle scheduling, and reducing runnable background jobs rather than reserving exact cores[4].
31|- **`CPUWeight` is the better tool than `CPUQuota` for mixed workloads** because it lets benchmarks and background jobs compete proportionally instead of hard-throttling everyone[3][5].
32|- **`MemoryMax` is still useful in WSL2** as long as your user manager has memory controller delegation; it protects the box from a single test or Chromium run eating the machine[4][5][15].
33|- **A queue daemon can survive only if systemd user sessions do**; if your WSL instance or user manager is not persistent, a pure systemd-only plan becomes brittle.
34|
35|## Best recommendation
36|
37|Use **pueue as the queue and status layer**, but execute every job through **`systemd-run --user`** so each job gets its own cgroup with `MemoryMax` and `CPUWeight`, and run benchmark jobs with normal/higher weight while background tests/builds use lower weight or `SCHED_IDLE`[4][5][14][15].
38|
39|If you want the **least new work** and the most predictable benchmark timing with no starvation, the practical stack is:
40|
41|- **Queue:** pueue
42|- **Resource control:** systemd transient scopes/services
43|- **Background jobs:** lower `CPUWeight` or `chrt SCHED_IDLE`
44|- **Benchmarks:** normal or elevated `CPUWeight`, separate `MemoryMax`
45|- **Fairness:** pueue’s queueing + systemd’s proportional CPU scheduling[4][5][14][15]
46|
47|If you want the **absolute minimum moving parts**, skip the queue daemon and use just **`systemd-run --user` wrappers** plus a small shell script that serializes benchmark jobs and submits background jobs with low weights; that is simpler, but it does not give you the same clean FIFO no-starvation behavior as pueue[4][5][15].
48|
49|[1] Managing Cgroups Via Systemd (https://oneuptime.com/blog/post/2026-03-02-how-to-use-cgroups-to-limit-process-resources-on-ubuntu/view)
50|[2] systemd-run: service transitoire avec limites et sandbox (https://data.pm/snippets/bash/systemd-run-transient-service-limites-sandbox/)
51|[3] systemd-run: ограничиваем CPU и RAM для одноразовых задач и ... (https://fastfox.pro/blog/tutorials/systemd-run-cpu-ram/)
52|[4] cgroups - ArchWiki (https://wiki.archlinux.org/title/Cgroups)
53|[5] Chapter 35. Using systemd to manage resources ... (https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/assembly_using-systemd-to-manage-resources-used-by-applications_monitoring-and-managing-system-status-and-performance)
54|[6] resource-limiting-systemd.md (https://docs.aws.amazon.com/pt_br/linux/al2027/ug/resource-limiting-systemd.md)
55|[7] Paano Limitahan ang Memory at CPU sa systemd - SSD Nodes (https://www.ssdnodes.com/learn/lang/tl/limit-process-memory-cpu-systemd)
56|[8] Limitar memoria y CPU de un proceso con systemd (https://www.ssdnodes.com/learn/lang/es/limit-process-memory-cpu-systemd)
57|[9] целенаправленное ограничение ресурсов служб Linux (https://webhosting.de/ru/systemd-%D1%83%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5-%D1%80%D0%B5%D1%81%D1%83%D1%80%D1%81%D0%B0%D0%BC%D0%B8-linux-%D0%BE%D0%B3%D1%80%D0%B0%D0%BD%D0%B8%D1%87%D0%B5%D0%BD%D0%B8%D0%B5/)
58|[10] How I Fit Limit VPS RAM and CPU with systemd - SSD Nodes (https://www.ssdnodes.com/learn/lang/pcm/limit-process-memory-cpu-systemd)
59|[11] Limiting process memory/CPU usage on linux (https://stackoverflow.com/questions/4360103/limiting-process-memory-cpu-usage-on-linux)
60|[12] pam_systemd - Freedesktop.org (https://www.freedesktop.org/software/systemd/man/latest/pam_systemd.html)
61|[13] Linux Namespaces and cgroups v2 Explained with Examples (https://cubepath.com/docs/advanced-topics/linux-namespaces-and-cgroups)
62|[14] https://raw.githubusercontent.com/Nukesor/pueue/ma... (https://raw.githubusercontent.com/Nukesor/pueue/main/CHANGELOG.md)
63|[15] Chapter 26. Configuring resource management by using ... (https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/managing_monitoring_and_updating_the_kernel/assembly_configuring-resource-management-using-systemd_managing-monitoring-and-updating-the-kernel)
64|