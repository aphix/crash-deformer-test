# Coding Standards

Cross-cutting design rules for Crush Stream. Each section has the rule, the rationale where it isn't obvious, and the
action to take on new code.

These are **binding rules, not suggestions.** There is no document-the-deviation escape hatch. If you find yourself
writing a comment explaining why a rule does not apply at this site, that comment IS the finding — report it with
`file:line` and stop. Do not resolve a rule/correctness collision locally.

Every exemption in this document is a **closed, named, countable inventory of sites that already exist.** No section
here grants a procedure for creating a new one, and any reading that produces one is a misreading. Every defect worth
fixing was previously somebody's documented, reasonable, commented exception. Not one was written carelessly; every
one had a comment explaining why it was fine. **An exception is an unfalsifiable claim about the future.**

### The absolutes

These hold in every file, of every type, with no site-local exception and no procedure for creating one:

- **Zero `oxlint-disable` / `eslint-disable`, in any form** (oxlint honours both spellings) — not line-scoped, not
  block, not file-level, not an `overrides[]` carve-out in `.oxlintrc.json`, not a severity downgrade from `error` to
  `warn` or `off`. Suppressing the rule and suppressing the finding are the same act. §9 is the census of what
  already exists and it is closed.
- **No casts that lie.** `as any`, `as unknown as`, `@ts-ignore` and `@ts-expect-error` hide a real mismatch; a cast is
  legitimate only downstream of a runtime guard that narrows the value. Beyond that, types are a tool, not the goal
  (repo rule): they vanish at runtime and guard nothing, so use them where they help a reader or catch a real mistake,
  and don't spend effort on type gymnastics.
- **`.forEach` is never needed. Ever** (§6) — and that includes test files.
- **No caught error is silently discarded** (§8).
- **A read state is not a data state** (§11).
- **One shared total helper, never N callers comparing literals** (§12).
- **Nothing ships red.** No skipped tests, no allow-lists, no "known failure" counts. The only parked reds are tests
  written ahead for work not yet built (a `todo` or a parked branch), and they stay parked only until the stage that
  owns them closes them (repo rule).

A finding you cannot fix is **reported, never dispositioned.** "Pre-existing", "by design", "out of scope" and
"P3 / no action" are findings, not dispositions. A declination is an exclusion unless it carries proof the condition
cannot occur.

---

## 1. async/await over `new Promise(...)` and `.then(...)` chains

### Rule

Always express asynchronous code with `async` / `await`. Never use `new Promise((resolve, reject) => ...)` or
`.then(...).catch(...)` chains unless **all** of the following hold:

- You're bridging a callback-API into a Promise (then prefer `util.promisify`)
- OR you're combining N promises in a way `Promise.all` / `Promise.race` / `Promise.allSettled` can't express
- OR you're inside a non-async context (top-level module init in a sync consumer)

### Rationale

- **Stack traces.** `await` preserves the call stack across boundaries; `.then(...)` chains lose it (you get the
  resolver location, not the caller).
- **Reading order matches execution order.** `const x = await foo(); use(x);` reads top-to-bottom;
  `.then(use).catch(handle)` reads inside-out.
- **Error handling unifies.** A single `try/catch` around an `async` block catches sync throws AND rejection.
  `.then(...).catch(...)` only catches rejection in the same chain — sync throws inside the `.then` callback bypass it.
- **Branching is natural.** `if (await x) ...` reads cleanly. The same with `.then` requires an inner closure.

### When to break the rule

Three cases legitimately need `new Promise`: wrapping an old callback-only API, an externally-resolvable promise
(event-driven), and `Promise.race`-style timeouts where the timer needs a manual reject. These are infrastructure.
Application code should never reach for `new Promise` directly.

---

## 2. Fail-fast / early returns over nested validation

### Rule

When a function has a validity check and a "real work" branch, write the invalid case first and `return` (or
`throw`, or `continue`). Don't wrap the real work in a positive-condition `if` block.

```ts
// PREFER
function process(x: Input): Output {
  if (!isValid(x)) return earlyResult;
  if (x.special) return specialPath(x);
  // ... real work, top-level (no nesting)
  return result;
}
```

### Rationale

- **Cognitive load.** Each level of nesting adds context the reader has to maintain. A flat function with five early
  returns is easier to trace than a five-deep nested branch.
- **Diff stability.** Adding a new validity check in the early-return style is a 2-line change. Adding it in the nested
  style requires re-indenting an entire block.
- **Return-type narrowing.** TypeScript's flow analysis tracks early returns better than nested branches, especially
  with `if (!x) throw;` (asserts non-null afterward without a redundant `!`).

### Action

- New code: every function with >1 condition gets an early-return audit before commit.
- Reviews: a function whose real-work block is indented past column 4 is a smell; ask whether early returns flatten it.
- Don't punish the happy path with an explicit `else` after a `return`.

---

## 3. Self-documenting names over narrating comments

### Rule

Code is written for the next human who reads it. The compiler will accept any garbage; the maintainer six months from
now will not. If we were writing for computers we would still be writing binary.

Code says what it does in its own names. If you'd write `// transform x into Y for external use`, the comment has the
function's name in it — extract `transformXIntoYForExternalUse` instead. The function name *is* the documentation; if a
function name needs a comment, the name is wrong.

Comments earn their keep only for non-obvious *why* — Carmack's fast-inverse-square-root bit hacking, weird quirks of
an external service, an invariant tied to a system you don't control, a gotcha that bit you once. **Never** for
*what* — the code is the *what*.

Comments rot faster than code. Every comment is a maintenance liability that the type checker cannot enforce. Write
fewer, shorter, sharper — or write none and rename.

Every chunk, scope, function, and line answers the same three questions: what does it DO, given what inputs, producing
what outputs? It must answer them to a mid-level reader who has never seen this codebase — even with every type
annotation stripped. If type info is the only thing carrying meaning, the names are wrong.

**Inferred types (repo rule).** Let TypeScript infer what it can infer; writing a type out again on the same line it is
inferred from is a DRY violation. If a comment or a type annotation is needed to understand a line, the names aren't
good enough yet. Don't second-guess this: annotate where it helps a reader or is required (exported signatures,
empty containers), skip it everywhere else.

### Block comments

A 3+ line comment block is a code smell. The triage:

- **Is it narrating the next N lines?** Delete. The reader can read.
- **Is it explaining a function or type?** The signature is the doc; rename if the signature isn't enough.
- **Is it explaining a magic value?** Extract a named constant, or collapse to a one-line cross-reference.
- **Is it capturing a load-bearing invariant?** Compress to one or two lines. If you can't, the invariant is probably
  misplaced — extract a function whose name *is* the invariant.
- **Is it saying "the following does X with Y to produce Z"?** That sentence IS the signature. Extract a function named
  for it, using real domain names, not letters.

The corollary applies to inline comment blocks too: if you reach for a multi-line comment to explain what the next
5–10 lines do, those lines are the body of an unnamed function. Name it and call it instead. The comment disappears;
the name survives refactors, diffs, and grep. Comments are often a duplication of the code — they can fall out of
sync, mislead readers, and give AI tools a second (possibly wrong) description of behaviour the code already describes
exactly once. One source of truth: the code itself.

### External references

Comments NEVER reference:

- **Commit hashes.** Commits get squashed, rebased, and lose attribution.
- **Spec or doc file paths.** Files move, get renamed, get archived, and the path goes stale. A future reader following
  the breadcrumb hits 404, distrusts the comment, and now distrusts every other comment around it.
- **Tool / agent transcript IDs** (e.g. `agent://...`). Those are session-local and meaningless to anyone outside that
  session.

If a comment captures load-bearing context (a contract, a tradeoff, an invariant), encode it in the code itself — by
name, by type, by a test that fails if the contract breaks. The test name + assertion is the canonical record; a
passing test is the proof.

### Names

- Names carry semantic weight, not just length. The fix for `x` and `y` is to name what they actually are
  (`closingSpeed`, `wheelContactNormal`), not to phoneticise the letters.
- No abbreviations: `context`, not `ctx`. `event`, not `evt`. `pendingEntries`, not `tmp`.
- Methods are verbs that state usage: `flushPendingFrames()` over `flush()`.
- Booleans / state read like questions: `isAirborne`, `initialized`, `hasParams`.
- Names earn their own legibility — a reader of a call site understands what's happening without consulting the type
  definitions.

### Action

- New code: extract narrating comments into function names. Rename abbreviations as you touch the file.
- Code review: if a reviewer needs to read the type signature to understand a parameter name, the parameter name is
  wrong.

---

## 4. Vertical whitespace

One blank line between top-level declarations, between functions, between class methods, between large multi-line
object/array blocks. Never two. Inside a function body, blank lines mark *phases* of the function (validate args →
prep state → do work → assemble result), not every statement boundary.

---

## 5. One place for every constant, magic numbers and strings (repo rule + addendum)

Magic numbers: avoid them. Use well-named constants at the top of the file if that's the only place they're needed.
A magic number or string lives in exactly one place and everything else uses it by reference or import. Shared ones go
in a `constants.ts` at the root of the folder that owns the concern (e.g. `src/game/vehicle/constants.ts`), not one
global dump. Index positions into flat buffers are named constants too (`buffer[SPEED_INDEX] = speed`).

DRY: if the same batch of lines is duplicated more than 3 times within a file or many times across many files, that's
a good indicator of something to extract and modularize into utils/helpers.

---

## 6. `for...of` over `.forEach()`

### Rule

Use `for (const x of xs)` for iteration. Never `xs.forEach(callback)`. In per-frame / per-step hot paths use an
indexed `for` loop (repo rule, §13).

### Rationale

1. **`await` does the right thing in the body.** Inside `for...of`, iteration pauses for `await`. Inside `forEach`, the
   callback is fire-and-forget — the outer function returns before any iteration has finished, exceptions escape the
   call stack into nowhere, and the array's sequential semantics are silently lost.
2. **`return` / `break` / `continue` work normally.** `return` inside `forEach` returns from the *callback*, not the
   enclosing function — so an early-exit guard becomes a no-op that keeps the loop running. `break` and `continue` are
   syntax errors inside `forEach`.
3. **Stack traces point at the loop.** A throw inside a `for...of` body lands on the actual `for` line.
4. **Shared lexical scope.** Variables declared above the loop are in scope inside it; TypeScript narrowing flows
   through; the loop body reads at the same indent as its surroundings.
5. **Symmetric with other languages.** `for (const x of xs)` matches Python `for x in xs`, Rust `for x in &xs`.

`.map`, `.filter`, `.reduce`, `.flatMap`, `.some`, `.every`, `.find`, `.findIndex` are NOT covered by this rule — those
return values and carry meaningful functional semantics (outside hot paths). The ban is on `forEach` specifically.

### Action

- Enforced by oxlint `unicorn/no-array-for-each` at `error`, test files included. There is no test-file exemption and
  no suppression may be written for this rule.

---

## 7. Code lands with its user-actionable flow

Any code that does not directly contribute to a user-facing — and user-controllable — component is
self-flagellation. Don't write it.

The failure mode is shipping infrastructure ahead of UI: backend that affects the user invisibly with no surface they
can see, act on, or verify. Exceptions: bug fixes, refactors, and plumbing between two already-user-facing surfaces.
The test is "is this commit independently valuable to a user?" If no, what commit completes the loop, and is it
landing alongside or in the same merge?

---

## 8. Errors are never silently suppressed

### Rule

Never `} catch (err) {` without doing something with `err`. If a specific, concrete type/shape of error is expected in
a given context, then the catch block should check against the exact error expected and return/continue *only* when
it matches the expected concrete shape. It should rethrow for any unclear/unknown/unexpected shapes. Never `catch`
without an `(err)` argument. Silent `catch { ... }`, `catch (e) { /* nothing */ }` and `.catch(() => null)` promise
tails are **prohibited.** A comment explaining why this site may swallow IS the finding.

No `try/catch` in per-step / per-frame hot paths (repo rule, §13): keep the hot function free of it and put any
`try/catch` around the call from outside, in cold code. This repo is performance-sensitive; see the V8 notes in §13.

### Rationale

Silent catch arms accumulate. A codebase with dozens of them has no working signal: when a real bug starts firing
inside a swallowed arm, there's no log line, no metric, no way to know it's happening except by stepping through with
a debugger after the user complains about something downstream. The preference is loud-and-spammy over
quiet-and-broken.

---

## 9. `oxlint-disable` / `eslint-disable` suppression policy — CLOSED CENSUS

### Rule

`oxlint-disable` is **prohibited in every form** — and so is its `eslint-disable` spelling, which oxlint honours
identically — and so is every construct that buys the same silence: file-level, block, next-line and line comments, an
`overrides[]` entry in `.oxlintrc.json` that turns a rule off, and a severity downgrade from `error` to `warn`.

**There is no justification format, no reviewer test, and no architectural-argument bar that admits a new one.** A
comment explaining why the rule cannot be satisfied here IS the finding. If a rule genuinely cannot be satisfied,
report it with `file:line`: the remediation is a structural change to the code, or one decided tree-wide idiom, never a
local silence.

### Rationale

Lint rules encode real invariants. Silencing one hides a problem: a stale closure, a missing type, a suppressed type
error, an unobserved rejection.

### The census that exists today (closed)

Out of scope (generated or template code this repo doesn't edit): `src/routeTree.gen.ts` (TanStack Router output) and
the pre-wired template helpers in `src/lib/` (`auth/`, `app-data/`, `og/`, `db.ts`, `preview-*`, `env.server.ts`,
`error-component.tsx`). In our own code, including `src/lib/multiplayer/`: `as unknown as` casts in a few game files
and in tests reaching private fields are legacy debt, not a sanctioned pattern. Touching a file that carries one:
remove it while you are there, or report why the structural fix is a separate change.

---

## 10. Test structure: Given / When / Then

### Rule

Every test must express a complete behavioural contract using the BDD structure: **Given** (context) → **When**
(action) → **Then** (observable outcome). The test output alone — without reading the code — must tell a reader
exactly what the system does and why the test exists.

`describe` labels: `given <noun phrase describing starting state>`. `it` labels: `when <action>, then <expected
outcome>`. Both labels must be readable without the source file open.

### Parametrize same-shaped cases

When several tests share the same body and differ only by inputs + expected output, drive them from an array of
pure-data cases with one shared loop body. The case objects MUST be flat data only — no functions, no closures, no
test bodies inside a case object. A case whose shape genuinely differs stays its own `it()` — don't force it into the
table with a special-case branch. Prefer asserting the exact full expected object over spot-checking one field.

### Assertions must discriminate

**An action whose success is indistinguishable from its absence is not an action.** The same holds for an assertion:
if it passes when the code under test never runs, it proves nothing and it will pass forever.

- **Every absence assertion passes when NOTHING HAPPENS.** Never let one stand alone. Pair it with a POPULATED
  companion in the same test that a not-running path fails.
- **An assertion can only discriminate producers whose outputs differ.** If two different producers satisfy the
  expected value equally, add a second, orthogonal observation.
- **A red test proves a pin bites.** Break the line deliberately, watch the pin fail for the RIGHT reason, restore it.
  A pin never observed red is a claim, not a gate.

### A measurement is a reading at a timestamp

A green suite, a probe result, or a `file:line` is true of the tree as it stood when you ran it. **Any subsequent edit
to the construct it measured invalidates it — including your own, including a pure rename.** Re-run before quoting
the result as a standing fact. A zero-hit search for a construct you believe exists is a TOOLING RESULT, not an
absence. **A control that cannot fail is not a control.**

---

## 11. Four states, two families: a read state is not a data state

Every surface that fetches something has FOUR states: `loading` and `failed` (READ family: our request is in flight /
did not complete) and `ready` and `absent` (DATA family: the read completed and returned rows / returned none). **Only
a DATA state may claim anything about what the user has.** Empty-state copy belongs to `absent` only; retry belongs to
`failed` only. A boolean pair is not a four-state model; use a discriminated union.

---

## 12. One shared total, never N callers comparing literals

When several call sites need the same derived quantity — a count, a total, a formatted label, a threshold or status
comparison — the quantity gets ONE named helper and every site calls it. N sites each recomputing it, or each comparing
against its own copy of the literal, is **one missing helper, not N independent sites.** Name the helper for what it
produces, not for how it runs. A literal duplicated across call sites is the same defect as a duplicated derivation
(§5).

---

## 13. Repo rules (Crush Stream)

- **One job, one implementation.** No duplicated logic, no second code path for the same behaviour, no shims.
- **No `implements`.** Shared behaviour goes in a base class that subclasses extend.
- **Hot paths** (per sim step, per frame, per pixel): indexed `for` loops, no `.push`, no per-call allocation (no
  object or array literals, no closures), no `try/catch`, no JSON, no spread, plain functions over `this`-bound
  methods, no deep equality at runtime. Pass data through preallocated, reused out-arrays or typed arrays written and
  read by index with named index constants (the caller passes the buffer in and reads it out), never keyed objects.
  Boundaries rule C6 enforces the HOT list.
- **V8 pitfalls in hot code** (confirm a suspect with `node --trace-opt --trace-deopt` and the sampling heap profiler,
  including collected objects):
  - Measured in this repo: `Math.hypot` is never inlined by TurboFan, so its arguments box into heap numbers on every
    call. Use the kernel's `hypot2` / `hypot3`, which also give every browser the same bits.
  - Measured in this repo: doubles passed to or returned from a call TurboFan didn't inline are boxed. A function past
    the inlining budget (roughly 900 bytes of bytecode) stops being inlined; keep hot helpers small.
  - General V8 knowledge, not measured here: `try/catch` — old V8 (Crankshaft) refused to optimize any function
    containing one; TurboFan can, but the catch path still costs, so keep it out of hot functions entirely and wrap the
    call from outside.
  - General V8 knowledge, not measured here: adding or deleting properties after construction gives objects different
    shapes, and a call site that sees many shapes goes megamorphic; mixing ints and doubles in one field changes that
    field's representation and causes deopts. Build objects with all their fields up front, with consistent number
    kinds.
- **Determinism and correctness, not old bits.** The same build and inputs give the same result (replay equals live,
  netplay stays consistent), and a change must make the result more correct. A fix that changes trajectories is fine
  with a replay version bump; never bend a correct fix to keep an old digest.
- **Measure, never guess.** Write the test that proves the change before writing the change; every bug fix starts with
  a failing test that reproduces the exact symptom. Validate or falsify hypotheses with tests and measurements, not
  reasoning.
- **File and function size.** Any file over 600 lines *must* be modularized (over 500 *should* be); no function over a
  single screen height (~60 lines). Boundaries rule C8 reports 800 / 150 today.
