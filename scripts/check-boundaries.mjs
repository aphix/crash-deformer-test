#!/usr/bin/env node
/**
 * Structural checks for `src/` (rules in `docs/ARCHITECTURE.md`). Each check prints one count;
 * a non-zero count is a defect to fix, never a baseline to allow. Exit 1 when any count is non-zero.
 *
 *   node scripts/check-boundaries.mjs            counts only
 *   node scripts/check-boundaries.mjs --list     every violation, one per line
 *   node scripts/check-boundaries.mjs --ratchet  exit 1 only when a count rises above its cap in
 *                                                scripts/boundary-caps.json (a missing cap is 0)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LIST = process.argv.includes("--list");
const CAPS = process.argv.includes("--ratchet") ? JSON.parse(readFileSync(path.join(ROOT, "scripts/boundary-caps.json"), "utf8")) : null;

// Bounded contexts, lowest layer first: one folder each under src/game/. A production file may import its own
// context or a context on a strictly lower layer. `platform` (src/lib) is importable only by the contexts in
// PLATFORM_USERS. A new file goes into its context's folder; a new context is a new folder here and in the DAG.
const CONTEXTS = [
  ["kernel", 0, ["src/game/kernel/"]],
  ["world", 1, ["src/game/world/"]],
  ["deform", 2, ["src/game/deform/"]],
  ["vehicle", 3, ["src/game/vehicle/"]],
  ["contact", 4, ["src/game/contact/"]],
  ["scenes", 5, ["src/game/scenes/"]],
  ["ai", 6, ["src/game/ai/"]],
  ["match", 7, ["src/game/match/"]],
  ["present", 8, ["src/game/present/"]],
  ["net", 8, ["src/game/net/"]],
  // The HUD store is the read model of the whole sim and its presentation settings, so it sits above both.
  ["hud", 9, ["src/game/hud/"]],
  ["engine", 10, ["src/game/engine/"]],
  ["ui", 11, ["src/components/", "src/routes/", "src/router.tsx"]],
  ["platform", -1, ["src/lib/"]],
];
const PLATFORM_USERS = new Set(["net", "ui", "platform"]);
// Contexts that hold rules, data or decisions and never build scene-graph objects.
const SCENE_FREE = new Set(["kernel", "world", "ai", "match", "hud", "net"]);
const SCENE_GRAPH = /^(Mesh|InstancedMesh|SkinnedMesh|Object3D|Scene|Group|Line|LineSegments|LineLoop|Points|Sprite|\w+Material|\w*Geometry|\w+Light|\w*Texture|\w*Camera|WebGLRenderer|WebGLRenderTarget|\w+Helper)$/;
// Per-frame entry points (the frame flow in docs/ARCHITECTURE.md) and the per-pair/per-slice
// queries they call. Their bodies allocate nothing.
const HOT = {
  "src/game/engine/engine.ts": ["tickInner", "fixedStep", "scheduleSkins", "flushVisibleSkins", "updateCamera"],
  "src/game/engine/engine-core.ts": ["puffEngine", "fleetClosing", "contactEta"],
  "src/game/engine/engine-scenes.ts": ["stepDerby", "stackLookY"],
  "src/game/present/engine-camera.ts": ["centroid", "pushFromPosts"],
  "src/game/present/engine-pistons.ts": ["sync"],
  "src/game/engine/world-step.ts": ["stepWorld"],
  "src/game/engine/engine-race.ts": ["drive", "step", "credit", "collide", "courseHit"],
  "src/game/engine/engine-race-field.ts": ["drain"],
  "src/game/vehicle/car.ts": ["syncPose", "stepBreakage", "updateSkin"],
  "src/game/vehicle/car-parts.ts": ["syncAttachedParts", "advanceFlap", "poseParts", "followGlass", "evaluateBreakage", "stepLooseParts", "freeObjects"],
  "src/game/vehicle/loose-step.ts": ["stepLoose", "landOn"],
  "src/game/vehicle/loose-dent.ts": ["recordDent", "applyDents", "carve"],
  "src/game/deform/streamed-deform.ts": ["pullSensorsFromMasses", "bakeLocalSkin", "solveCages", "capCageCorners", "fitCagesToMasses"],
  "src/game/deform/deform-state.ts": ["stepCrush", "bakeSkin", "update", "flushSkin"],
  "src/game/deform/deform-contact.ts": ["stepStructure", "collideWith"],
  "src/game/deform/deform-solve.ts": ["stepMassSlice", "stepShapeMatch", "stepBeams", "stepSuspension"],
  "src/game/contact/sat.ts": ["physicsSlice", "sliceSpeed", "satCars", "deepestIn", "outlineNormal", "clipCarToBarrier"],
  "src/game/contact/cage-outline.ts": ["sampleField", "worldBand", "bandsMeet"],
  "src/game/contact/pair-contact.ts": ["resolveCarPair", "impulseCar", "pushCar"],
  "src/game/contact/prop-contact.ts": ["propContact", "solidContact", "sideContact", "measure", "coplanar"],
  "src/game/contact/external-contact.ts": ["partContactPair", "partContact", "faceOverlap", "shiftVelocities"],
  "src/game/vehicle/car-drive.ts": ["applyDrive", "input"],
  "src/game/vehicle/drive-input.ts": ["readIntent", "shapeDrive"],
  "src/game/match/derby.ts": ["step", "think", "consumeBoosts", "snapshotAiCar", "leader"],
  "src/game/match/session.ts": ["step", "stepCar", "gates", "reroute", "measure", "stretch", "drafting", "busting", "settle", "deadline"],
  "src/game/ai/derby-ai.ts": ["think"],
  "src/game/ai/race-ai.ts": ["think", "plan", "line", "crowded", "pickRoute", "upcoming", "pointAhead", "charge"],
  "src/game/ai/contact-guard.ts": ["guardContact"],
  "src/game/ai/traffic.ts": ["think"],
  "src/game/ai/police.ts": ["drive"],
  "src/game/ai/cop-brain.ts": ["think", "attackTarget", "pursuitSteer"],
  "src/game/ai/hunter.ts": ["drive", "update"],
  "src/game/present/pose-blend.ts": ["end", "present", "restore"],
};
const KNOB_CONTEXTS = new Set(["kernel", "world", "deform", "vehicle", "contact", "scenes", "ai"]);
const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 150;

const isTest = (f) => /\.test(-util)?\.ts$|\/test-support\.ts$/.test(f);
const contextOf = (f) => CONTEXTS.find(([, , pats]) => pats.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));

// Tracked and new (untracked, not ignored) files as they are on disk, so a lane's pre-commit gate sees its new files.
const lsFiles = (dir) =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", dir], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && existsSync(path.join(ROOT, f)));
const files = lsFiles("src").filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && f !== "src/routeTree.gen.ts");

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null;
  base = base.replace(/\?.*$/, "");
  for (const cand of [base, base.replace(/\.js$/, ".ts"), base + ".ts", base + ".tsx", base + ".js", base + "/index.ts"]) {
    if (existsSync(path.join(ROOT, cand)) && !cand.endsWith("/")) return cand;
  }
  return base;
}

const parsed = new Map();
for (const f of files) {
  const text = readFileSync(path.join(ROOT, f), "utf8");
  const kind = f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".js") || f.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind);
  const imports = [];
  const exports = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const names = [];
      let typeOnly = ts.isImportDeclaration(st) ? !!st.importClause?.isTypeOnly : st.isTypeOnly;
      const clause = ts.isImportDeclaration(st) ? st.importClause : null;
      if (clause?.name) names.push({ name: "default", local: clause.name.text, type: typeOnly });
      const bindings = ts.isImportDeclaration(st) ? clause?.namedBindings : st.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const el of bindings.elements) names.push({ name: (el.propertyName ?? el.name).text, local: el.name.text, type: typeOnly || el.isTypeOnly });
        if (bindings.elements.length && bindings.elements.every((el) => el.isTypeOnly)) typeOnly = true;
      } else if (bindings) names.push({ name: "*", local: bindings.name?.text ?? "*", type: typeOnly });
      else if (!clause && ts.isExportDeclaration(st)) names.push({ name: "*", local: "*", type: typeOnly });
      imports.push({ spec, target: resolveImport(f, spec), names, typeOnly, reexport: ts.isExportDeclaration(st), line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1 });
      if (ts.isExportDeclaration(st)) for (const n of names) if (n.name !== "*") exports.push({ name: n.local, line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1 });
      continue;
    }
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) exports.push({ name: el.name.text, line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1 });
      continue;
    }
    const line = sf.getLineAndCharacterOfPosition(st.getStart()).line + 1;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) exports.push({ name: d.name.text, line }); }
    else if (st.name && ts.isIdentifier(st.name)) exports.push({ name: st.name.text, line });
  }
  parsed.set(f, { sf, text, imports, exports, ctx: contextOf(f) });
}

const results = [];
function check(id, title, items) {
  results.push([id, title, items]);
}

// C0: every non-test production file belongs to exactly one context.
check("C0", "files outside every context", files.filter((f) => !isTest(f) && !parsed.get(f).ctx).map((f) => f));

// C1: import direction follows the layer DAG (type-only imports count: they couple the same way).
const c1 = [];
for (const [f, p] of parsed) {
  if (isTest(f) || !p.ctx) continue;
  for (const im of p.imports) {
    if (!im.target) continue;
    if (isTest(im.target)) { c1.push(`${f}:${im.line} production imports test file ${im.target}`); continue; }
    const tc = contextOf(im.target);
    if (!tc || tc[0] === p.ctx[0]) continue;
    const [name, layer] = p.ctx;
    const ok = tc[0] === "platform" ? PLATFORM_USERS.has(name) : layer > tc[1] && name !== "platform";
    if (!ok) c1.push(`${f}:${im.line} ${name}(L${layer}) -> ${tc[0]}(L${tc[1]}) ${im.target}${im.typeOnly ? " [type]" : ""} {${im.names.map((n) => n.name).join(", ")}}`);
  }
}
check("C1", "imports against the layer DAG", c1);

// C2: file-level import cycles among production files (value imports; type-only edges erase at runtime).
const graph = new Map();
for (const [f, p] of parsed) if (!isTest(f)) graph.set(f, p.imports.filter((im) => !im.typeOnly && parsed.has(im.target) && !isTest(im.target)).map((im) => im.target));
const sccs = [];
{
  let index = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set();
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) strong(v);
}
check("C2", "import cycles (strongly connected file groups)", sccs.map((c) => c.join(" <-> ")));

// C3: hot kernels (*-core.js) import nothing and never name THREE.
const c3 = [];
for (const [f, p] of parsed) {
  if (!/-core\.js$/.test(f)) continue;
  for (const im of p.imports) c3.push(`${f}:${im.line} imports ${im.spec}`);
  const visit = (n) => { if (ts.isIdentifier(n) && n.text === "THREE") c3.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} names THREE`); ts.forEachChild(n, visit); };
  visit(p.sf);
}
check("C3", "kernel purity breaks", c3);

// C4: scene-graph-free contexts never name a scene-graph class.
const c4 = [];
for (const [f, p] of parsed) {
  if (isTest(f) || !p.ctx || !SCENE_FREE.has(p.ctx[0])) continue;
  const local = new Map();
  for (const im of p.imports) if (im.spec === "three") for (const n of im.names) local.set(n.local, n.name);
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && local.get(n.expression.text) === "*" && SCENE_GRAPH.test(n.name.text)) c4.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} THREE.${n.name.text}`);
    else if (ts.isQualifiedName(n) && ts.isIdentifier(n.left) && local.get(n.left.text) === "*" && SCENE_GRAPH.test(n.right.text)) c4.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} THREE.${n.right.text}`);
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  for (const [loc, name] of local) if (name !== "*" && SCENE_GRAPH.test(name)) c4.push(`${f} imports ${name} as ${loc}`);
}
check("C4", "scene-graph names in rule/data contexts", c4);

// C5: exports nobody imports (src/** and scripts/**), and production exports only tests import.
// Route entry modules are consumed by the router.
const importers = new Map(); // target -> name -> Set(from)
const scriptFiles = lsFiles("scripts").filter((f) => /\.(mjs|ts)$/.test(f));
const importSources = [...parsed.values()].flatMap((p) => p.imports.map((im) => ({ ...im, from: p.sf.fileName })));
for (const f of scriptFiles) {
  const sf = ts.createSourceFile(f, readFileSync(path.join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
    importSources.push({ target: resolveImport(f, st.moduleSpecifier.text), names: st.importClause.namedBindings.elements.map((el) => ({ name: (el.propertyName ?? el.name).text })), from: f });
  }
}
for (const im of importSources) {
  if (!im.target) continue;
  const byName = importers.get(im.target) ?? new Map();
  for (const n of im.names) byName.set(n.name, (byName.get(n.name) ?? new Set()).add(im.from));
  importers.set(im.target, byName);
}
const c5 = [];
for (const [f, p] of parsed) {
  if (f.startsWith("src/routes/") || f === "src/router.tsx" || !p.ctx || p.ctx[0] === "platform" || isTest(f)) continue;
  const byName = importers.get(f) ?? new Map();
  if (byName.has("*")) continue;
  const idCount = new Map();
  const visit = (n) => { if (ts.isIdentifier(n) && !ts.isExportSpecifier(n.parent)) idCount.set(n.text, (idCount.get(n.text) ?? 0) + 1); ts.forEachChild(n, visit); };
  visit(p.sf);
  for (const e of p.exports) {
    const from = [...(byName.get(e.name) ?? [])];
    const ownUse = (idCount.get(e.name) ?? 0) > 1;
    if (!from.length) c5.push(`${f}:${e.line} ${e.name} ${ownUse ? "(used in own file: drop `export`)" : "(no use at all)"}`);
    else if (!ownUse && from.every((g) => isTest(g) || g.startsWith("scripts/"))) c5.push(`${f}:${e.line} ${e.name} (only tests/scripts import it: ${from.join(", ")})`);
  }
}
check("C5", "exports with no production importer", c5);

// C6: per-frame entry points allocate nothing and stay on V8's fast path: no new X, .clone(), array or object literals,
// closures, spreads, .push/.unshift (preallocate and write by index), for..of/for..in (indexed loops), try/catch, JSON.
// And, in every non-test game file, no Math.hypot (TurboFan never inlines it, so every call boxes its arguments, and
// the sim must compute the same bits on every browser: kernel/physics-core.js hypot2/hypot3 instead); and in the folders
// that feed the sim, no Math.sin or Math.cos either (V8 and SpiderMonkey round them differently, so a clip replayed in
// the other browser diverged: kernel/physics-core.js detSin/detCos instead).
const c6 = [];
for (const [f, names] of Object.entries(HOT)) {
  const p = parsed.get(f);
  if (!p) { c6.push(`${f} missing`); continue; }
  const found = new Set();
  const visit = (n, inHot) => {
    let hot = inHot;
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && names.includes(n.name.getText())) { hot = n.name.getText(); found.add(hot); }
    if (hot) {
      const at = () => `${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${hot}`;
      if (ts.isNewExpression(n)) c6.push(`${at()} new ${n.expression.getText()}`);
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const m = n.expression.name.text;
        const of = ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : "";
        if (m === "clone") c6.push(`${at()} .clone()`);
        else if (m === "push" || m === "unshift") c6.push(`${at()} .${m}()`);
        else if (of === "JSON") c6.push(`${at()} JSON.${m}`);
      } else if (ts.isArrayLiteralExpression(n)) c6.push(`${at()} array literal`);
      else if (ts.isObjectLiteralExpression(n)) c6.push(`${at()} object literal`);
      else if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) c6.push(`${at()} closure`);
      else if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) c6.push(`${at()} spread`);
      else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) c6.push(`${at()} ${ts.isForOfStatement(n) ? "for..of" : "for..in"}`);
      else if (ts.isTryStatement(n)) c6.push(`${at()} try/catch`);
    }
    ts.forEachChild(n, (c) => visit(c, hot));
  };
  visit(p.sf, null);
  for (const n of names) if (!found.has(n)) c6.push(`${f} hot entry ${n} not found (update HOT)`);
}
const SIM_FEEDING = new Set(["kernel", "world", "deform", "vehicle", "contact", "scenes", "ai", "match", "net", "engine"]);
for (const [f, p] of parsed) {
  if (isTest(f) || !f.startsWith("src/game/")) continue;
  const noTrig = p.ctx && SIM_FEEDING.has(p.ctx[0]);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === "Math") {
      const fn = n.expression.name.text;
      if (fn === "hypot" || (noTrig && (fn === "sin" || fn === "cos"))) c6.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} Math.${fn}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
check("C6", "allocations in per-frame entry points; Math.hypot in game code; Math.sin/cos in sim folders", c6);

// C7: module-level numeric knobs in sim contexts carry a comment (source or measurement). One comment may
// head a block of consecutive knob lines. An enum series (contiguous consts 0, 1, 2, ...) is not a knob.
const c7 = [];
for (const [f, p] of parsed) {
  if (isTest(f) || !p.ctx || !KNOB_CONTEXTS.has(p.ctx[0])) continue;
  const knobs = [];
  let blockCommented = false;
  let prevEnd = -1;
  for (const st of p.sf.statements) {
    const lead = ts.getLeadingCommentRanges(p.text, st.getFullStart()) ?? [];
    const trail = ts.getTrailingCommentRanges(p.text, st.getEnd()) ?? [];
    const contiguous = prevEnd >= 0 && !/\n\s*\n/.test(p.text.slice(prevEnd, st.getStart()));
    if (!ts.isVariableStatement(st)) { blockCommented = false; prevEnd = -1; continue; }
    blockCommented = lead.length > 0 || (contiguous && blockCommented);
    prevEnd = st.getEnd();
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !/^[A-Z][A-Z0-9_]+$/.test(d.name.text) || !d.initializer) continue;
      const init = d.initializer.getText().replace(/\s+as const$/, "");
      if (!/^[-+*/().\s\d_eE]+$/.test(init) || !/\d/.test(init)) continue;
      knobs.push({ line: p.sf.getLineAndCharacterOfPosition(st.getStart()).line + 1, name: d.name.text, init, ok: blockCommented || trail.length > 0, contiguous });
    }
  }
  for (let i = 0; i < knobs.length; ) {
    let j = i;
    while (j + 1 < knobs.length && knobs[j + 1].contiguous && knobs[j + 1].init === String(j + 1 - i)) j++;
    const enumRun = knobs[i].init === "0" && j > i;
    for (let k = i; k <= j; k++) if (!enumRun && !knobs[k].ok) c7.push(`${f}:${knobs[k].line} ${knobs[k].name} = ${knobs[k].init}`);
    i = enumRun ? j + 1 : i + 1;
  }
}
check("C7", "uncommented numeric knobs", c7);

// C8: size caps (production files, and functions anywhere outside tests).
const c8 = [];
for (const [f, p] of parsed) {
  if (isTest(f) || parsed.get(f).ctx?.[0] === "platform") continue;
  const lines = p.text.split("\n").length;
  if (lines > MAX_FILE_LINES) c8.push(`${f} ${lines} lines (file > ${MAX_FILE_LINES})`);
  const visit = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body) {
      const a = p.sf.getLineAndCharacterOfPosition(n.getStart()).line, b = p.sf.getLineAndCharacterOfPosition(n.getEnd()).line;
      if (b - a + 1 > MAX_FUNCTION_LINES) c8.push(`${f}:${a + 1} ${ts.isConstructorDeclaration(n) ? "constructor" : (n.name?.getText() ?? "(anonymous)")} ${b - a + 1} lines (function > ${MAX_FUNCTION_LINES})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
check("C8", "size caps exceeded", c8);

// C9: tests never deep-compare two computed values. node:assert diffs both sides on failure (Myers diff,
// O((N+M)·D)); two ~75k-element float arrays took one failing assert to 14.7 GB. One side must be a literal
// (its size is then fixed by the source); compare buffers by first-mismatch index + max |diff|, or a hash.
const DEEP = new Set(["deepEqual", "deepStrictEqual", "notDeepEqual", "notDeepStrictEqual"]);
const isLiteral = (n) =>
  ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword ||
  n.kind === ts.SyntaxKind.NullKeyword || (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)) ||
  (ts.isArrayLiteralExpression(n) && n.elements.every(isLiteral)) ||
  (ts.isObjectLiteralExpression(n) && n.properties.every((pr) => ts.isPropertyAssignment(pr) && isLiteral(pr.initializer)));
const c9 = [];
for (const [f, p] of parsed) {
  if (!/\.test\.ts$/.test(f) || (f.startsWith("src/lib/") && !f.startsWith("src/lib/multiplayer/"))) continue;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && DEEP.has(n.expression.name.text) && n.arguments.length >= 2 && !isLiteral(n.arguments[0]) && !isLiteral(n.arguments[1])) {
      c9.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.expression.name.text}(${n.arguments[0].getText().slice(0, 50)}, ${n.arguments[1].getText().slice(0, 50)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
check("C9", "test deep-compares of two computed values", c9);

// C10: no module-level mutable bindings in production game/UI code. State lives on an object the engine owns
// (a second engine, a test or a replay must not inherit it). `let` and `var` at module scope count.
const c10 = [];
for (const [f, p] of parsed) {
  if (isTest(f) || !p.ctx || p.ctx[0] === "platform") continue;
  for (const st of p.sf.statements) {
    if (!ts.isVariableStatement(st) || st.declarationList.flags & ts.NodeFlags.Const) continue;
    for (const d of st.declarationList.declarations) c10.push(`${f}:${p.sf.getLineAndCharacterOfPosition(d.getStart()).line + 1} ${d.name.getText()}`);
  }
}
check("C10", "module-level mutable bindings", c10);

// C11: no `implements` in game code, tests included (owner, 10-05). It re-declares a shape and lets each class
// re-implement the same logic; shared logic lives in a base class the others extend.
const c11 = [];
for (const [f, p] of parsed) {
  if (!f.startsWith("src/game/")) continue;
  const visit = (n) => {
    if (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword) {
      c11.push(`${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.parent.name?.text ?? "class"} ${n.getText()}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
check("C11", "implements clauses in game code", c11);

// C12/C13: one place for every magic string and number (owner, 10-07). A name, id, storage or query key, part
// name, or a tuning value typed in 2+ places drifts silently; it lives in the owning folder's constants.ts (or the
// one file that owns the concern) and everyone else imports it. Both checks ratchet from today's count.
const PLATFORM_WORDS = new Set([
  // DOM / browser events and values
  "keydown", "keyup", "message", "hashchange", "popstate", "pagehide", "pointerdown", "pointerup", "pointermove", "pointercancel",
  "pointerlockchange", "pointerlockerror", "mousemove", "fullscreenchange", "webkitfullscreenchange", "languagechange",
  "visibilitychange", "resize", "blur", "focus", "click", "error", "load", "change", "input", "contextmenu", "wheel", "copy",
  "cut", "paste", "connected", "connecting", "standard", "stylesheet", "preconnect", "rel", "navigate", "same-origin", "include",
  "gamepadconnected", "gamepaddisconnected", "http:", "https:",
  // canvas / three.js
  "position", "uv", "uv1", "color", "normal", "index", "2d", "canvas", "YXZ", "WEBGL_debug_renderer_info", "EXT_disjoint_timer_query_webgl2", "div", "textarea", "button",
  // HTTP / encodings
  "GET", "POST", "PUT", "DELETE", "content-type", "application/json", "accept", "cookie", "set-cookie", "host", "cache-control",
  "no-store", "x-forwarded-host", "Authorization", "origin", "localhost", "utf8", "utf-8", "sha256", "base64", "base64url", "hex",
  "deflate-raw",
  // language / library vocabulary
  "none", "auto", "hidden", "center", "left", "right", "top", "bottom", "middle", "string", "number", "boolean", "object", "function",
  "undefined", "custom", "default", "id", "name", "type", "value", "key", "width", "height", "length", "min", "max", "step", "on", "off",
  "true", "false", "null",
]);
const KEY_CODE = /^(Key[A-Z]|Arrow[A-Z][a-z]+|Digit\d|Enter|Escape|Space|Tab|(Shift|Control|Alt)(Left|Right)|Backspace)$/;
const ID_SHAPE = /^[A-Za-z_#/][A-Za-z0-9_.\-:/#]*$/; // an id, key or name; sentences (UI copy) have spaces and fall out
const UI_LABEL = /^[A-Z][a-z]+([ -][A-Za-z]+)*$/;
const TRIVIAL = new Set([
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "20", "24", "30", "32", "60", "64", "90",
  "100", "128", "180", "255", "256", "360", "512", "1000", "1024", "0.5", "0.25", "0.75", "1.5", "0.1", "0.01", "0.001", "16777215",
]);
const APPEARANCE = /^(roughness|metalness|opacity|color|emissive\w*|specular\w*|shininess|intensity|fog\w*|sky|ambient|clearcoat\w*|transmission|ior|thickness|alphaTest|sheen\w*|envMapIntensity|toneMappingExposure)$/;
const SHORT_KNOBS = new Set(["dt", "hx", "hy", "hz"]);
const GENERIC_NAME = /^(min|max|low|high|from|to|len|len2|sum|tmp|val|value|num|count|size|idx|index|key|id|status)$/;
const enclosingStatement = (n) => {
  let c = n.parent;
  while (c && !ts.isStatement(c)) c = c.parent;
  return c;
};
const underJsxAttribute = (n) => {
  for (let c = n.parent; c && !ts.isStatement(c); c = c.parent) if (ts.isJsxAttribute(c)) return true;
  return false;
};
// What a string handed to a call is checked against. When the callee is declared here (the calling file's own declaration
// wins, else any under that name) with a non-`string` parameter type (`keyof X`, a union), tsc rejects a typo: the argument
// is pinned. A library call is trusted for a union member (zod `.default("x")`) except the platform's string-keyed lookups
// (`startsWith`, `getObjectByName`, `Map.get` ...), where a typo is silent whatever the argument's type.
const SILENT_SINKS = new Set(["startsWith", "endsWith", "includes", "indexOf", "getObjectByName", "getObjectByProperty", "get", "has", "set", "delete", "getItem", "setItem", "removeItem", "getAttribute", "setAttribute", "getElementById", "querySelector", "querySelectorAll", "getExtension", "push", "add", "append"]);
const paramLists = new Map(); // callee name -> { file, parameters } of every function, method or constructor declared under it
const calleeOf = (n) => {
  const call = n.parent;
  if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || !call.arguments?.includes(n) || call.typeArguments?.length) return null;
  const name = ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
  if (!name) return null;
  const i = call.arguments.indexOf(n);
  const untyped = (d) => {
    const t = d.ps[i]?.type?.kind;
    return t === undefined || t === ts.SyntaxKind.StringKeyword || t === ts.SyntaxKind.AnyKeyword || t === ts.SyntaxKind.UnknownKeyword;
  };
  const decls = paramLists.get(name) ?? [];
  const here = decls.filter((d) => d.f === n.getSourceFile().fileName);
  const own = here.length ? here : decls;
  return { declared: own.length > 0, untyped: own.some(untyped), silent: SILENT_SINKS.has(name) };
};
const pinnedByCall = (n) => {
  const c = calleeOf(n);
  return c !== null && c.declared && !c.untyped;
};
const silentArgument = (n) => {
  const c = calleeOf(n);
  return c !== null && (c.declared ? c.untyped : c.silent);
};
const isClassHelperArgument = (n) => ts.isCallExpression(n.parent) && ts.isIdentifier(n.parent.expression) && ["cn", "cva"].includes(n.parent.expression.text);
const isIndexArithmetic = (n) => {
  for (let c = n.parent, prev = n; c && !ts.isStatement(c); prev = c, c = c.parent) if (ts.isElementAccessExpression(c) && c.argumentExpression === prev) return true;
  return false;
};
// The identifier a number is bound to: `name: 0.35`, `const name = 0.35`, `name < 0.35`, `x * 0.35` (-> the other operand).
const knobName = (lit) => {
  let n = lit;
  if (ts.isPrefixUnaryExpression(n.parent)) n = n.parent;
  const c = n.parent;
  if (ts.isPropertyAssignment(c) || ts.isPropertyDeclaration(c) || ts.isVariableDeclaration(c) || ts.isParameter(c) || ts.isBindingElement(c)) return c.name.getText();
  if (ts.isBinaryExpression(c)) {
    const other = c.left === n ? c.right : c.left;
    if (ts.isIdentifier(other)) return other.text;
    if (ts.isPropertyAccessExpression(other)) return other.name.text;
  }
  return null;
};
// Scope: the game, its components and the multiplayer relay. The rest of `src/lib` is platform template code, as in C9.
const inMagicScope = (f) => !isTest(f) && (!f.startsWith("src/lib/") || f.startsWith("src/lib/multiplayer/"));
const unionMembers = new Set(); // a value some string-literal union type pins: tsc catches a typo in a typed position
for (const [f, p] of parsed) {
  if (!inMagicScope(f)) continue;
  const visit = (n) => {
    if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) unionMembers.add(n.literal.text);
    const bound = (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) ? n.initializer : null;
    const fn = ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isMethodSignature(n) ? n : bound;
    if (fn && n.name && ts.isIdentifier(n.name)) paramLists.set(n.name.text, [...(paramLists.get(n.name.text) ?? []), { f, ps: fn.parameters }]);
    if (ts.isClassDeclaration(n) && n.name) for (const m of n.members) if (ts.isConstructorDeclaration(m)) paramLists.set(n.name.text, [...(paramLists.get(n.name.text) ?? []), { f, ps: m.parameters }]);
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
const strGroups = new Map();
const numGroups = new Map();
for (const [f, p] of parsed) {
  if (!inMagicScope(f)) continue;
  const where = (n) => `${f}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const v = n.text;
      const st = enclosingStatement(n);
      const exempt = !st || ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isLiteralTypeNode(n.parent) || ts.isEnumMember(n.parent) ||
        underJsxAttribute(n) || isClassHelperArgument(n) || v.length < 2 || !ID_SHAPE.test(v) || PLATFORM_WORDS.has(v) || KEY_CODE.test(v) || UI_LABEL.test(v) ||
        pinnedByCall(n) || (unionMembers.has(v) && !silentArgument(n));
      if (!exempt) strGroups.set(v, [...(strGroups.get(v) ?? []), where(n)]);
    } else if (ts.isNumericLiteral(n)) {
      const name = knobName(n);
      const v = (ts.isPrefixUnaryExpression(n.parent) && n.parent.operator === ts.SyntaxKind.MinusToken ? "-" : "") + n.text;
      const knob = name && (name.length >= 3 || SHORT_KNOBS.has(name)) && !GENERIC_NAME.test(name) && !APPEARANCE.test(name) && !/_IDX$/.test(name);
      if (knob && !TRIVIAL.has(n.text) && !isIndexArithmetic(n)) {
        const key = `${v} @ ${name}`;
        const g = numGroups.get(key) ?? [];
        g.push({ f, at: where(n) });
        numGroups.set(key, g);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
}
const c12 = [];
for (const [v, at] of strGroups) if (at.length > 1) for (const w of at) c12.push(`${w} "${v}" ×${at.length}`);
check("C12", "id-like string literals repeated in production code (one constant, imported)", c12);
const c13 = [];
for (const [key, g] of numGroups) if (new Set(g.map((o) => o.f)).size > 1) for (const o of g) c13.push(`${o.at} ${key} ×${g.length}`);
check("C13", "named numeric knobs repeated across files (one constant, imported)", c13);

// Size caps (C8) are listed but never fail the ratchet: the owner treats splitting files as clean-up paperwork after
// the lanes settle (10-05), not a merge blocker.
const REPORT_ONLY = new Set(["C8"]);
let total = 0;
let over = 0;
for (const [id, title, items] of results) {
  total += items.length;
  const cap = CAPS?.[id] ?? 0;
  const reportOnly = REPORT_ONLY.has(id);
  if (CAPS && !reportOnly && items.length > cap) over++;
  const note = reportOnly ? "  report only" : !CAPS || items.length === cap ? "" : items.length > cap ? `  ABOVE cap ${cap}` : `  below cap ${cap}: lower it in scripts/boundary-caps.json`;
  console.log(`${id} ${String(items.length).padStart(4)}  ${title}${note}`);
  if (LIST) for (const it of items) console.log(`       ${it}`);
}
console.log(`total ${total}`);
process.exitCode = (CAPS ? over : total) ? 1 : 0;
