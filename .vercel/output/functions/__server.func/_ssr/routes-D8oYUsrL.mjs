import { i as __toESM } from "../_runtime.mjs";
import { I as require_jsx_runtime, L as require_react } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as Timer, c as Repeat, d as Orbit, f as Gauge, g as BrickWall, h as CircleDot, l as Play, m as ClipboardCopy, n as VolumeX, o as Spline, p as FoldHorizontal, r as Volume2, s as RotateCcw, t as Waypoints, u as Pause } from "../_libs/lucide-react.mjs";
import { n as clsx, t as cva } from "../_libs/class-variance-authority+clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-D8oYUsrL.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var snapshot = {
	playing: true,
	looping: true,
	showRig: false,
	showBarrier: false,
	showBalls: false,
	showCompactor: false,
	autoRotate: true,
	autoSlomo: true,
	audioOn: false,
	deformMode: "shape",
	phase: "approach",
	timeScale: 1,
	elapsed: 0,
	speedA: 0,
	speedB: 0,
	closingKph: 0,
	impactKph: null,
	eta: 0,
	cageCount: 16,
	sensorCount: 20,
	squash: .4,
	buckle: .45,
	fxDensity: .7,
	carCount: 2,
	speedMin: 0,
	speedMax: 32,
	traceSamples: 0,
	wallGap: 0,
	compactStage: "open"
};
var listeners = /* @__PURE__ */ new Set();
function getHudSnapshot() {
	return snapshot;
}
function subscribeHud(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
function publishHud(next) {
	snapshot = next;
	for (const listener of listeners) listener();
}
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
var buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[opacity,transform,background-color,color,box-shadow] duration-[var(--motion-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]", {
	variants: {
		variant: {
			default: "bg-accent text-accent-fg shadow-[var(--shadow-border)] hover:opacity-90",
			secondary: "bg-surface-2 text-fg shadow-[var(--shadow-border)] hover:bg-surface",
			ghost: "text-fg hover:bg-surface-2",
			outline: "bg-transparent text-fg shadow-[var(--shadow-border)] hover:bg-surface-2"
		},
		size: {
			default: "h-11 min-w-11 px-4",
			sm: "h-9 min-w-9 px-3 text-xs",
			icon: "h-11 w-11"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});
var Button = (0, import_react.forwardRef)(({ className, variant, size, type = "button", ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
	ref,
	type,
	className: cn(buttonVariants({
		variant,
		size
	}), className),
	...props
}));
Button.displayName = "Button";
var PHASE = {
	approach: "Approach",
	impact: "Impact",
	slowmo: "Slow-mo",
	aftermath: "Aftermath"
};
function Hud({ state, onReset, onTogglePlay, onToggleLoop, onToggleRig, onToggleBarrier, onToggleBalls, onToggleCompactor, onToggleOrbit, onToggleSlomo, onToggleAudio, onToggleDeformMode, onSquash, onBuckle, onFxDensity, onCarCount, onSpeedRange, onCopyTrace }) {
	const [copied, setCopied] = (0, import_react.useState)(false);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "pointer-events-none absolute inset-0 flex flex-col justify-between p-4 text-fg sm:p-6",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "flex items-start justify-between gap-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "max-w-[16rem] sm:max-w-sm",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "font-display text-xs font-medium uppercase tracking-[0.22em] text-muted",
						children: "Streamed deformation"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
						className: "mt-1 font-display text-3xl font-semibold leading-none tracking-tight text-balance sm:text-4xl",
						children: "Crush Stream"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 hidden max-w-xs text-pretty text-sm leading-snug text-muted sm:block",
						children: state.showCompactor ? "One car, two steel plates. They close square to the chassis — bumper, wheel-well, then the cage." : state.carCount <= 2 ? "Cars lock onto the pad. Control particles shape-match the mesh — Müller 2005, with the lattice still a toggle." : `${state.carCount} cars on the pad. Same crumple rules, now a pile-up.`
					})
				]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col items-end gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-xl bg-surface/90 px-3 py-2 shadow-[var(--shadow-border)]",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-display text-[0.65rem] uppercase tracking-[0.18em] text-subtle",
							children: "Time scale"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "font-display text-2xl font-semibold tabular-nums leading-none",
							children: [state.timeScale.toFixed(2), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "ml-0.5 text-sm font-medium text-muted",
								children: "×"
							})]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-xl bg-surface/90 px-3 py-2 shadow-[var(--shadow-border)]",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-display text-[0.65rem] uppercase tracking-[0.18em] text-subtle",
							children: "T+"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "font-display text-2xl font-semibold tabular-nums leading-none",
							children: [state.elapsed.toFixed(2), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "ml-0.5 text-sm font-medium text-muted",
								children: "s"
							})]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: cn("rounded-full px-3 py-1 font-display text-[0.7rem] uppercase tracking-[0.16em] shadow-[var(--shadow-border)]", state.phase === "slowmo" || state.phase === "impact" ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"),
						children: PHASE[state.phase]
					})
				]
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-end justify-between gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: state.showCompactor ? "Press gap" : state.carCount === 1 ? "Car" : "Lead",
						value: state.showCompactor ? `${state.wallGap.toFixed(2)} m` : `${(state.speedA * 3.6).toFixed(0)} km/h`
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "hidden text-center sm:block",
						children: [state.showCompactor ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "font-display text-sm text-muted",
							children: [
								"Stage",
								" ",
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "tabular-nums text-fg",
									children: state.compactStage === "open" ? "open" : state.compactStage === "contact" ? "crush zone" : state.compactStage === "wells" ? "wheel wells" : state.compactStage === "mid" ? "past hubs" : "max crush"
								})
							]
						}) : state.impactKph != null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "font-display text-sm text-muted",
							children: [
								"Closing impact",
								" ",
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "tabular-nums text-fg",
									children: [state.impactKph.toFixed(0), " km/h"]
								})
							]
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "font-display text-sm text-muted",
							children: [
								"Closing",
								" ",
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "tabular-nums text-fg",
									children: [state.closingKph.toFixed(0), " km/h"]
								}),
								state.eta > 0 && state.eta < 8 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "tabular-nums",
									children: [
										" · ",
										state.eta.toFixed(1),
										"s"
									]
								}) : null
							]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-1 text-[0.7rem] uppercase tracking-[0.14em] text-subtle",
							children: [
								state.sensorCount,
								" sensors · ",
								state.cageCount,
								" cages"
							]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: state.showCompactor ? "Plate speed" : state.carCount === 1 ? "Solo" : state.carCount > 2 ? "Fleet" : state.phase === "approach" ? "Second" : "Second wreck",
						value: state.showCompactor ? `${state.closingKph.toFixed(0)} km/h close` : state.carCount !== 2 ? `${state.carCount} car${state.carCount === 1 ? "" : "s"}` : `${(state.speedB * 3.6).toFixed(0)} km/h`,
						align: "right"
					})
				]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl bg-surface/90 p-2 shadow-[var(--shadow-border)]",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onReset,
						variant: "secondary",
						"aria-label": "Reset crash",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(RotateCcw, {}), "Reset"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						onClick: onTogglePlay,
						"aria-label": state.playing ? "Pause" : "Play",
						children: state.playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pause, {}), "Pause"] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Play, { className: "ml-0.5" }), "Play"] })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleLoop,
						variant: state.looping ? "default" : "secondary",
						"aria-pressed": state.looping,
						"aria-label": "Toggle loop",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Repeat, {}),
							"Loop ",
							state.looping ? "on" : "off"
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleBarrier,
						variant: state.showBarrier ? "default" : "ghost",
						"aria-pressed": state.showBarrier,
						"aria-label": "Toggle jersey barrier",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(BrickWall, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Wall ", state.showBarrier ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleBalls,
						variant: state.showBalls ? "default" : "ghost",
						"aria-pressed": state.showBalls,
						"aria-label": "Toggle ramp balls",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleDot, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Balls ", state.showBalls ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleCompactor,
						variant: state.showCompactor ? "default" : "ghost",
						"aria-pressed": state.showCompactor,
						"aria-label": "Toggle car compactor",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(FoldHorizontal, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Press ", state.showCompactor ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleRig,
						variant: state.showRig ? "default" : "ghost",
						"aria-pressed": state.showRig,
						"aria-label": "Toggle deformation rig",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Spline, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "hidden sm:inline",
							children: "Rig"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleOrbit,
						variant: state.autoRotate ? "default" : "ghost",
						"aria-pressed": state.autoRotate,
						"aria-label": "Toggle camera auto-rotate",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Orbit, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Orbit ", state.autoRotate ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleSlomo,
						variant: state.autoSlomo ? "default" : "ghost",
						"aria-pressed": state.autoSlomo,
						"aria-label": "Toggle impact slow-motion",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Timer, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Slomo ", state.autoSlomo ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleDeformMode,
						variant: state.deformMode === "shape" ? "default" : "ghost",
						"aria-pressed": state.deformMode === "shape",
						"aria-label": "Toggle shape-matching deformer",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Waypoints, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "hidden sm:inline",
							children: state.deformMode === "shape" ? "Shape" : "Lattice"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: onToggleAudio,
						variant: state.audioOn ? "default" : "ghost",
						"aria-pressed": state.audioOn,
						"aria-label": "Toggle crash audio",
						children: [state.audioOn ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Volume2, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VolumeX, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "hidden sm:inline",
							children: ["Audio ", state.audioOn ? "on" : "off"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[11rem] flex-1 items-center gap-2 px-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
								children: "Squash"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "range",
								min: 0,
								max: 1,
								step: .01,
								value: state.squash,
								onChange: (e) => onSquash(Number(e.target.value)),
								"aria-label": "Crumple squash",
								className: "h-1.5 w-full cursor-pointer accent-current"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "number",
								min: 0,
								max: 1,
								step: .01,
								value: state.squash.toFixed(2),
								onChange: (e) => onSquash(Number(e.target.value)),
								"aria-label": "Crumple squash value",
								className: "h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[11rem] flex-1 items-center gap-2 px-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
								children: "Buckle"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "range",
								min: 0,
								max: 1,
								step: .01,
								value: state.buckle,
								onChange: (e) => onBuckle(Number(e.target.value)),
								"aria-label": "Panel buckle",
								className: "h-1.5 w-full cursor-pointer accent-current"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "number",
								min: 0,
								max: 1,
								step: .01,
								value: state.buckle.toFixed(2),
								onChange: (e) => onBuckle(Number(e.target.value)),
								"aria-label": "Panel buckle value",
								className: "h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[11rem] flex-1 items-center gap-2 px-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
								children: "FX"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "range",
								min: 0,
								max: 1.2,
								step: .01,
								value: state.fxDensity,
								onChange: (e) => onFxDensity(Number(e.target.value)),
								"aria-label": "Particle density",
								className: "h-1.5 w-full cursor-pointer accent-current"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "number",
								min: 0,
								max: 1.2,
								step: .01,
								value: state.fxDensity.toFixed(2),
								onChange: (e) => onFxDensity(Number(e.target.value)),
								"aria-label": "Particle density value",
								className: "h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[10rem] flex-1 items-center gap-2 px-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
								children: "Cars"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "range",
								min: 1,
								max: 24,
								step: 1,
								value: state.carCount,
								onChange: (e) => onCarCount(Number(e.target.value)),
								"aria-label": "Number of cars",
								className: "h-1.5 w-full cursor-pointer accent-current"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "number",
								min: 1,
								max: 24,
								step: 1,
								value: state.carCount,
								onChange: (e) => onCarCount(Number(e.target.value)),
								"aria-label": "Number of cars value",
								className: "h-8 w-12 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[7.5rem] items-center gap-1 px-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
							children: "Min m/s"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "number",
							min: 0,
							max: 48,
							step: .5,
							value: state.speedMin,
							onChange: (e) => onSpeedRange(Number(e.target.value), state.speedMax),
							"aria-label": "Minimum spawn speed",
							className: "h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "flex min-w-[7.5rem] items-center gap-1 px-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle",
							children: "Max m/s"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "number",
							min: 0,
							max: 48,
							step: .5,
							value: state.speedMax,
							onChange: (e) => onSpeedRange(state.speedMin, Number(e.target.value)),
							"aria-label": "Maximum spawn speed",
							className: "h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						onClick: () => {
							Promise.resolve(onCopyTrace()).then((ok) => {
								if (!ok) return;
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1600);
							});
						},
						variant: "secondary",
						"aria-label": "Copy lattice JSON trace",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClipboardCopy, {}), copied ? "Copied" : `JSON ${state.traceSamples}`]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "ml-auto hidden items-center gap-1 pr-2 text-xs text-subtle md:flex",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gauge, { className: "size-3.5" }), "Space pause · R reset · L loop · B wall · K balls · G rig · O orbit · M slomo · U audio · Y shape"]
					})
				]
			})]
		})]
	});
}
function Stat({ label, value, align = "left" }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: cn("rounded-xl bg-surface/80 px-3 py-2 shadow-[var(--shadow-border)]", align === "right" && "text-right"),
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "font-display text-[0.65rem] uppercase tracking-[0.16em] text-subtle",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "font-display text-lg font-semibold tabular-nums leading-none sm:text-xl",
			children: value
		})]
	});
}
function CrashLab() {
	const canvasRef = (0, import_react.useRef)(null);
	const engineRef = (0, import_react.useRef)(null);
	const hud = (0, import_react.useSyncExternalStore)(subscribeHud, getHudSnapshot, getHudSnapshot);
	const [bootError, setBootError] = (0, import_react.useState)(null);
	(0, import_react.useEffect)(() => {
		if (!canvasRef.current) return;
		let cancelled = false;
		let engine = null;
		import("./engine-9QknkRP4.mjs").then(({ CrashEngine }) => {
			if (cancelled || !canvasRef.current) return;
			try {
				engine = new CrashEngine(canvasRef.current);
				engineRef.current = engine;
				engine.start();
			} catch (err) {
				const message = err instanceof Error ? err.stack ?? err.message : String(err);
				console.error("Crush Stream failed to start", err);
				if (!cancelled) setBootError(message);
			}
		}).catch((err) => {
			const message = err instanceof Error ? err.stack ?? err.message : String(err);
			console.error("Crush Stream failed to start", err);
			if (!cancelled) setBootError(message);
		});
		return () => {
			cancelled = true;
			engine?.dispose();
			engineRef.current = null;
		};
	}, []);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "relative h-dvh w-full overflow-hidden bg-bg text-fg",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("canvas", {
				ref: canvasRef,
				className: "block h-full w-full touch-none",
				"aria-label": "Crash simulation canvas"
			}),
			bootError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "absolute inset-x-4 top-1/2 z-10 -translate-y-1/2 text-center text-sm text-fg",
				children: bootError
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Hud, {
				state: hud,
				onReset: () => engineRef.current?.reset(),
				onTogglePlay: () => engineRef.current?.togglePlay(),
				onToggleLoop: () => engineRef.current?.toggleLoop(),
				onToggleRig: () => engineRef.current?.toggleRig(),
				onToggleBarrier: () => engineRef.current?.toggleBarrier(),
				onToggleBalls: () => engineRef.current?.toggleBalls(),
				onToggleCompactor: () => engineRef.current?.toggleCompactor(),
				onToggleOrbit: () => engineRef.current?.toggleOrbit(),
				onToggleSlomo: () => engineRef.current?.toggleSlomo(),
				onToggleAudio: () => engineRef.current?.toggleAudio(),
				onToggleDeformMode: () => engineRef.current?.toggleDeformMode(),
				onSquash: (v) => engineRef.current?.setSquash(v),
				onBuckle: (v) => engineRef.current?.setBuckle(v),
				onFxDensity: (v) => engineRef.current?.setFxDensity(v),
				onCarCount: (n) => engineRef.current?.setCarCount(n),
				onSpeedRange: (min, max) => engineRef.current?.setSpeedRange(min, max),
				onCopyTrace: async () => {
					const json = engineRef.current?.copyTraceJson();
					if (!json) return false;
					try {
						await navigator.clipboard.writeText(json);
						return true;
					} catch {
						const ta = document.createElement("textarea");
						ta.value = json;
						ta.style.position = "fixed";
						ta.style.left = "-9999px";
						document.body.appendChild(ta);
						ta.select();
						const ok = document.execCommand("copy");
						ta.remove();
						return ok;
					}
				}
			})
		]
	});
}
var routes_exports = /* @__PURE__ */ __exportAll({ component: () => Home });
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CrashLab, {});
}
//#endregion
export { publishHud as n, routes_exports as t };
