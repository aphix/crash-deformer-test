import { n as publishHud } from "./routes-D8oYUsrL.mjs";
import { A as Mesh, B as Quaternion, C as InstancedMesh, D as Material, E as LineSegments, F as PerspectiveCamera, G as Shape, H as RingGeometry, I as PlaneGeometry, J as TorusGeometry, K as SphereGeometry, L as PointLight, M as MeshPhysicalMaterial, N as MeshStandardMaterial, O as MathUtils, P as Object3D, R as Points, S as InstancedBufferAttribute, T as LineBasicMaterial, U as SRGBColorSpace, V as RepeatWrapping, W as Scene, Y as Vector3, _ as Float32BufferAttribute, a as Box3, b as Group, c as BufferGeometry, d as Color, f as CylinderGeometry, g as ExtrudeGeometry, h as DynamicDrawUsage, i as WebGLRenderer, j as MeshBasicMaterial, k as Matrix4, l as CanvasTexture, m as DirectionalLight, n as RoomEnvironment, o as BoxGeometry, p as DataTexture, q as SpotLight, r as PMREMGenerator, s as BufferAttribute, t as mergeGeometries, u as CircleGeometry, v as FogExp2, w as Light, x as HemisphereLight, y as GridHelper, z as PointsMaterial } from "../_libs/three.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/engine-9QknkRP4.js
/**
* Base crash-physics numbers (sedan, dry asphalt, ~50 km/h NCAP-style pulse).
*
* Pulse duration 90–150 ms (Glass 2002: ~120 ms at 56 km/h, peak ~29 g).
* Crumple travel 0.45–0.75 m. F Δt = m Δv — extending Δt cuts peak force.
* Rear mass keeps world velocity until rails yield; that pile-in is the buckle.
* Tire μ_peak ≈ 0.90, μ_slide ≈ 0.75. During the pulse the fronts scuff (~0.40).
* Restitution of a crumpled structure is ~0–0.15 (not a bounce).
*/
var CRASH = {
	pulseSec: .12,
	crushMeters: .65,
	muPeak: .9,
	muSlide: .75,
	muScuff: .4,
	grazeMps: 1.8,
	/** Hard cap — above this a mass has teleported, not crashed. */
	maxMassMps: 55
};
/**
* How easily this node yields (1 = crash-box mild steel, 0 = UHSS cage).
* Matches a typical sedan: bumper < 300 MPa, rails/doors HS, cabin UHSS/MHSS.
*/
function regionSoftness(name) {
	if (name.startsWith("bumper")) return 1;
	if (name.startsWith("wing")) return .78;
	if (name === "engineL" || name === "engineR") return .42;
	if (name.startsWith("rail")) return .3;
	if (name.startsWith("door")) return .22;
	if (name === "tank" || name === "axleR") return .34;
	if (name === "roof" || name === "cell") return .08;
	if (name.startsWith("hub")) return .06;
	return .2;
}
/** 0 below this region's yield, 1 at fatal. Closing in m/s. */
function crushGate(closing, softness) {
	const v = Math.max(0, closing);
	const min = CRASH.grazeMps + (1 - softness) * 9;
	const fatal = 7 + (1 - softness) * 26;
	if (v <= min) return 0;
	return MathUtils.clamp((v - min) / Math.max(.5, fatal - min), 0, 1);
}
/** Scale a one-shot impulse so 2000 slomo substeps ≠ 2000 wall hits. */
function dtImpulseScale(dt) {
	return MathUtils.clamp(dt * 60, .04, 1.2);
}
/** KE scale vs a 14 m/s NCAP pulse. 5 m/s is a parking bump; 22 m/s is a real crash. */
function closingKeScale(closing) {
	const v = Math.max(0, closing);
	return MathUtils.clamp(v * v / 196, 0, 2.4);
}
var TRANSFER = {
	belowMiddle: .1,
	atMiddle: .5,
	above: .62,
	packed: 1
};
/** Crush-travel bands (m) for a named mass. Soft crash-box yields farther. */
function regionCrushBands(name) {
	const max = .12 + regionSoftness(name) * .72;
	return {
		yield: max * .16,
		middle: max * .48,
		max
	};
}
/**
* Downstream force fraction for a node.
*
* Below the middle crush band the node is still eating energy (~0.1).
* Past middle, half goes through. Past max, 62% — crumple still dissipates
* unless the node is physically packed against the one behind it (100%).
*/
function forceTransfer(travel, bands, packed) {
	if (packed) return TRANSFER.packed;
	const t = Math.max(0, travel);
	if (t < bands.middle) return TRANSFER.belowMiddle;
	if (t < bands.max) return TRANSFER.atMiddle;
	return TRANSFER.above;
}
function round4(n) {
	return Math.round(n * 1e4) / 1e4;
}
function vec3(v) {
	return {
		x: round4(v.x),
		y: round4(v.y),
		z: round4(v.z)
	};
}
/** Remaining crumple travel, 1 = still a full crush zone, 0 = cabin-on-cabin. */
function leftoverCrumple(travel) {
	return MathUtils.clamp(travel / 1.5, 0, 1);
}
/**
* Rigid leftover closing after crumple has taken its share.
* `pass` is the node / face transfer fraction (0.1 / 0.5 / 0.62 / 1).
*/
function leftoverPass(remain, pass) {
	return Math.max(0, remain) * MathUtils.clamp(pass, 0, 1);
}
/** Kill NaNs and clamp |v| so a bad polar/impulse cannot light-speed the car. */
function clampSpeed(vel, max = CRASH.maxMassMps) {
	const sp2 = vel.lengthSq();
	if (!Number.isFinite(sp2)) {
		vel.set(0, 0, 0);
		return;
	}
	if (sp2 > max * max) vel.multiplyScalar(max / Math.sqrt(sp2));
}
function applyGroundFriction(vel, dt, mu, grounded) {
	if (!grounded || dt <= 0) return;
	const s = Math.hypot(vel.x, vel.z);
	if (s < 1e-5) {
		vel.x = 0;
		vel.z = 0;
		return;
	}
	const k = (s - Math.min(s, mu * 9.81 * dt)) / s;
	vel.x *= k;
	vel.z *= k;
}
function snapshotPoints(px, py, pz, life, packed, cap = 16) {
	const items = [];
	const n = life.length;
	for (let i = 0; i < n && items.length < cap; i++) {
		if (life[i] <= 0) continue;
		const y = packed ? px[i * 3 + 1] : py[i];
		if (y > 80 || y < -1) continue;
		if (packed) items.push({
			x: round4(px[i * 3]),
			y: round4(px[i * 3 + 1]),
			z: round4(px[i * 3 + 2]),
			life: round4(life[i])
		});
		else items.push({
			x: round4(px[i]),
			y: round4(py[i]),
			z: round4(pz[i]),
			life: round4(life[i])
		});
	}
	return {
		count: items.length,
		items
	};
}
/**
* Push a sphere out of an AABB and kill inbound speed on the contact axis.
* Same response for cars, jersey barriers, press platens, poles.
*/
function separateSphereFromAabb(pos, vel, radius, cx, cy, cz, hx, hy, hz) {
	const dx = pos.x - cx;
	const dy = pos.y - cy;
	const dz = pos.z - cz;
	const ox = hx + radius - Math.abs(dx);
	const oy = hy + radius - Math.abs(dy);
	const oz = hz + radius - Math.abs(dz);
	if (ox <= 0 || oy <= 0 || oz <= 0) return false;
	if (ox <= oy && ox <= oz) {
		const s = dx >= 0 ? 1 : -1;
		pos.x += s * ox;
		if (vel.x * s < 0) vel.x = 0;
	} else if (oy <= oz) {
		const s = dy >= 0 ? 1 : -1;
		pos.y += s * oy;
		if (vel.y * s < 0) vel.y *= -.2;
	} else {
		const s = dz >= 0 ? 1 : -1;
		pos.z += s * oz;
		if (vel.z * s < 0) vel.z = 0;
	}
	return true;
}
function m3() {
	return /* @__PURE__ */ new Float64Array(9);
}
function m3Id(out = m3()) {
	out[0] = 1;
	out[1] = 0;
	out[2] = 0;
	out[3] = 0;
	out[4] = 1;
	out[5] = 0;
	out[6] = 0;
	out[7] = 0;
	out[8] = 1;
	return out;
}
function m3Copy(src, out = m3()) {
	out.set(src);
	return out;
}
function m3Zero(out) {
	out.fill(0);
	return out;
}
function m3Mul(a, b, out) {
	const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
	const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8];
	out[0] = a0 * b0 + a1 * b3 + a2 * b6;
	out[1] = a0 * b1 + a1 * b4 + a2 * b7;
	out[2] = a0 * b2 + a1 * b5 + a2 * b8;
	out[3] = a3 * b0 + a4 * b3 + a5 * b6;
	out[4] = a3 * b1 + a4 * b4 + a5 * b7;
	out[5] = a3 * b2 + a4 * b5 + a5 * b8;
	out[6] = a6 * b0 + a7 * b3 + a8 * b6;
	out[7] = a6 * b1 + a7 * b4 + a8 * b7;
	out[8] = a6 * b2 + a7 * b5 + a8 * b8;
	return out;
}
function m3MulVec(m, x, y, z) {
	return [
		m[0] * x + m[1] * y + m[2] * z,
		m[3] * x + m[4] * y + m[5] * z,
		m[6] * x + m[7] * y + m[8] * z
	];
}
function m3Transpose(m, out) {
	out[0] = m[0];
	out[1] = m[3];
	out[2] = m[6];
	out[3] = m[1];
	out[4] = m[4];
	out[5] = m[7];
	out[6] = m[2];
	out[7] = m[5];
	out[8] = m[8];
	return out;
}
function m3Lerp(a, b, t, out) {
	const u = 1 - t;
	for (let i = 0; i < 9; i++) out[i] = a[i] * u + b[i] * t;
	return out;
}
function m3Det(m) {
	return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
function m3Invert(m, out) {
	const det = m3Det(m);
	if (Math.abs(det) < 1e-12) return false;
	const i = 1 / det;
	out[0] = (m[4] * m[8] - m[5] * m[7]) * i;
	out[1] = (m[2] * m[7] - m[1] * m[8]) * i;
	out[2] = (m[1] * m[5] - m[2] * m[4]) * i;
	out[3] = (m[5] * m[6] - m[3] * m[8]) * i;
	out[4] = (m[0] * m[8] - m[2] * m[6]) * i;
	out[5] = (m[2] * m[3] - m[0] * m[5]) * i;
	out[6] = (m[3] * m[7] - m[4] * m[6]) * i;
	out[7] = (m[1] * m[6] - m[0] * m[7]) * i;
	out[8] = (m[0] * m[4] - m[1] * m[3]) * i;
	return true;
}
function m3FrobeniusI(m) {
	const d0 = m[0] - 1, d4 = m[4] - 1, d8 = m[8] - 1;
	return Math.sqrt(d0 * d0 + m[1] * m[1] + m[2] * m[2] + m[3] * m[3] + d4 * d4 + m[5] * m[5] + m[6] * m[6] + m[7] * m[7] + d8 * d8);
}
function m3Finite(m) {
	for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return false;
	return true;
}
function m3MaxAbs(m) {
	let a = 0;
	for (let i = 0; i < 9; i++) a = Math.max(a, Math.abs(m[i]));
	return a;
}
/** Polar decomposition A = R S via Higham/Newton. S is the symmetric stretch. */
function m3Polar(A, R, S) {
	if (!m3Finite(A) || m3MaxAbs(A) > 12 || m3FrobeniusI(A) > 8) {
		m3Id(R);
		m3Id(S);
		return;
	}
	m3Copy(A, R);
	const inv = m3();
	const Rt = m3();
	for (let k = 0; k < 12; k++) {
		if (!m3Invert(R, inv)) {
			m3Id(R);
			m3Id(S);
			return;
		}
		m3Transpose(inv, Rt);
		for (let i = 0; i < 9; i++) R[i] = .5 * (R[i] + Rt[i]);
	}
	if (!m3Finite(R) || m3MaxAbs(R) > 4) {
		m3Id(R);
		m3Id(S);
		return;
	}
	m3Orthonormalize(R);
	if (m3Det(R) < 0) {
		R[2] = -R[2];
		R[5] = -R[5];
		R[8] = -R[8];
		m3Orthonormalize(R);
	}
	m3ClampRotation(R, .85);
	m3Transpose(R, Rt);
	m3Mul(Rt, A, S);
	S[1] = S[3] = .5 * (S[1] + S[3]);
	S[2] = S[6] = .5 * (S[2] + S[6]);
	S[5] = S[7] = .5 * (S[5] + S[7]);
	if (!m3Finite(S) || m3FrobeniusI(S) > 1.8) m3Id(S);
}
/** Gram-Schmidt on columns so Higham's iterate is a real rotation, not a flip. */
function m3Orthonormalize(R) {
	let x0 = R[0], y0 = R[3], z0 = R[6];
	let n = Math.hypot(x0, y0, z0) || 1;
	x0 /= n;
	y0 /= n;
	z0 /= n;
	let x1 = R[1], y1 = R[4], z1 = R[7];
	const d = x1 * x0 + y1 * y0 + z1 * z0;
	x1 -= d * x0;
	y1 -= d * y0;
	z1 -= d * z0;
	n = Math.hypot(x1, y1, z1) || 1;
	x1 /= n;
	y1 /= n;
	z1 /= n;
	const x2 = y0 * z1 - z0 * y1;
	const y2 = z0 * x1 - x0 * z1;
	const z2 = x0 * y1 - y0 * x1;
	R[0] = x0;
	R[3] = y0;
	R[6] = z0;
	R[1] = x1;
	R[4] = y1;
	R[7] = z1;
	R[2] = x2;
	R[5] = y2;
	R[8] = z2;
}
function m3RotationAngle(R) {
	const tr = R[0] + R[4] + R[8];
	return Math.acos(Math.min(1, Math.max(-1, (tr - 1) * .5)));
}
/** Pull R toward identity if it flipped past `maxRad` (stops inside-out mesh). */
function m3ClampRotation(R, maxRad) {
	const ang = m3RotationAngle(R);
	if (!(ang > maxRad) || ang < 1e-6) return;
	const t = maxRad / ang;
	R[0] = 1 + (R[0] - 1) * t;
	R[1] = R[1] * t;
	R[2] = R[2] * t;
	R[3] = R[3] * t;
	R[4] = 1 + (R[4] - 1) * t;
	R[5] = R[5] * t;
	R[6] = R[6] * t;
	R[7] = R[7] * t;
	R[8] = 1 + (R[8] - 1) * t;
	m3Orthonormalize(R);
}
function m3OuterAdd(px, py, pz, qx, qy, qz, w, out) {
	out[0] += w * px * qx;
	out[1] += w * px * qy;
	out[2] += w * px * qz;
	out[3] += w * py * qx;
	out[4] += w * py * qy;
	out[5] += w * py * qz;
	out[6] += w * pz * qx;
	out[7] += w * pz * qy;
	out[8] += w * pz * qz;
}
var _Apq = m3();
var _Aqq = m3();
var _tmp = m3();
var _tmp2 = m3();
var _I = m3Id();
function makeCluster(particles, idx) {
	const n = idx.length;
	const c = {
		idx: idx.slice(),
		q0x: new Float64Array(n),
		q0y: new Float64Array(n),
		q0z: new Float64Array(n),
		qx: new Float64Array(n),
		qy: new Float64Array(n),
		qz: new Float64Array(n),
		cm0x: 0,
		cm0y: 0,
		cm0z: 0,
		cmx: 0,
		cmy: 0,
		cmz: 0,
		AqqInv: m3(),
		Sp: m3Id(),
		A: m3Id(),
		R: m3Id(),
		S: m3Id(),
		M: m3Id(),
		skinM: m3Id(),
		skinInvT: m3Id(),
		skinCm0x: 0,
		skinCm0y: 0,
		skinCm0z: 0,
		skinCmx: 0,
		skinCmy: 0,
		skinCmz: 0
	};
	let msum = 0;
	for (let i = 0; i < n; i++) {
		const p = particles[idx[i]];
		c.cm0x += p.x * p.mass;
		c.cm0y += p.y * p.mass;
		c.cm0z += p.z * p.mass;
		msum += p.mass;
	}
	msum = Math.max(msum, 1e-8);
	c.cm0x /= msum;
	c.cm0y /= msum;
	c.cm0z /= msum;
	c.skinCm0x = c.skinCmx = c.cm0x;
	c.skinCm0y = c.skinCmy = c.cm0y;
	c.skinCm0z = c.skinCmz = c.cm0z;
	for (let i = 0; i < n; i++) {
		const p = particles[idx[i]];
		c.q0x[i] = c.qx[i] = p.x - c.cm0x;
		c.q0y[i] = c.qy[i] = p.y - c.cm0y;
		c.q0z[i] = c.qz[i] = p.z - c.cm0z;
	}
	rebuildAqqWeighted(c, particles);
	return c;
}
function rebuildAqqWeighted(c, particles) {
	m3Zero(_Aqq);
	for (let i = 0; i < c.idx.length; i++) {
		const p = particles[c.idx[i]];
		m3OuterAdd(c.qx[i], c.qy[i], c.qz[i], c.qx[i], c.qy[i], c.qz[i], p.mass, _Aqq);
	}
	_Aqq[0] += .001;
	_Aqq[4] += .001;
	_Aqq[8] += .001;
	if (!m3Invert(_Aqq, c.AqqInv)) m3Id(c.AqqInv);
}
function matchCluster(c, particles, beta) {
	let msum = 0;
	c.cmx = 0;
	c.cmy = 0;
	c.cmz = 0;
	for (const i of c.idx) {
		const p = particles[i];
		c.cmx += p.x * p.mass;
		c.cmy += p.y * p.mass;
		c.cmz += p.z * p.mass;
		msum += p.mass;
	}
	msum = Math.max(msum, 1e-8);
	c.cmx /= msum;
	c.cmy /= msum;
	c.cmz /= msum;
	m3Zero(_Apq);
	for (let i = 0; i < c.idx.length; i++) {
		const p = particles[c.idx[i]];
		m3OuterAdd(p.x - c.cmx, p.y - c.cmy, p.z - c.cmz, c.qx[i], c.qy[i], c.qz[i], p.mass, _Apq);
	}
	m3Mul(_Apq, c.AqqInv, c.A);
	if (!m3Finite(c.A) || m3MaxAbs(c.A) > 12) m3Id(c.A);
	m3Polar(c.A, c.R, c.S);
	m3ClampRotation(c.R, .85);
	m3Lerp(_I, c.S, beta, _tmp);
	m3Mul(c.R, _tmp, c.M);
	if (!m3Finite(c.M) || m3MaxAbs(c.M) > 8) m3Id(c.M);
	m3Mul(c.M, c.Sp, c.skinM);
	if (!m3Finite(c.skinM) || m3MaxAbs(c.skinM) > 8) m3Id(c.skinM);
	if (!m3Invert(c.skinM, _tmp)) m3Id(_tmp);
	m3Transpose(_tmp, c.skinInvT);
}
function applyPlasticity(c, particles, dt, squash, contacting, buckle = .45) {
	if (squash < .03 && buckle < .03) return;
	const yieldC = .05 + (1 - squash) * .1 + (1 - buckle) * .05;
	if (m3FrobeniusI(c.S) < yieldC) return;
	const creep = Math.min(.7, (.22 + squash * 1.1 + buckle * .5) * Math.max(dt, 1 / 120) * 8);
	m3Lerp(_I, c.S, creep, _tmp);
	m3Mul(c.Sp, _tmp, _tmp2);
	m3Copy(_tmp2, c.Sp);
	const maxE = .18 + squash * .55 + buckle * .4;
	const pe = m3FrobeniusI(c.Sp);
	if (pe > maxE) {
		const t = maxE / pe;
		m3Lerp(_I, c.Sp, t, c.Sp);
	}
	const det = m3Det(c.Sp);
	if (det > 1e-6) {
		const mix = 1 + (Math.cbrt(1 / det) - 1) * .45;
		for (let i = 0; i < 9; i++) c.Sp[i] *= mix;
	}
	if (contacting) {
		const r00 = c.R[0], r11 = c.R[4], r22 = c.R[8];
		const tr = r00 + r11 + r22;
		if (Math.acos(Math.min(1, Math.max(-1, (tr - 1) * .5))) > .08) {
			m3Lerp(_I, c.R, creep * .45, _tmp);
			for (let i = 0; i < c.idx.length; i++) {
				const [x, y, z] = m3MulVec(_tmp, c.q0x[i], c.q0y[i], c.q0z[i]);
				c.q0x[i] = x;
				c.q0y[i] = y;
				c.q0z[i] = z;
			}
		}
	}
	for (let i = 0; i < c.idx.length; i++) {
		const [x, y, z] = m3MulVec(c.Sp, c.q0x[i], c.q0y[i], c.q0z[i]);
		c.qx[i] = x;
		c.qy[i] = y;
		c.qz[i] = z;
	}
	rebuildAqqWeighted(c, particles);
}
function resetCluster(c, particles) {
	m3Id(c.Sp);
	m3Id(c.A);
	m3Id(c.R);
	m3Id(c.S);
	m3Id(c.M);
	m3Id(c.skinM);
	m3Id(c.skinInvT);
	let msum = 0;
	c.cm0x = c.cm0y = c.cm0z = 0;
	for (const i of c.idx) {
		const p = particles[i];
		c.cm0x += p.x * p.mass;
		c.cm0y += p.y * p.mass;
		c.cm0z += p.z * p.mass;
		msum += p.mass;
	}
	msum = Math.max(msum, 1e-8);
	c.cm0x /= msum;
	c.cm0y /= msum;
	c.cm0z /= msum;
	c.skinCm0x = c.skinCmx = c.cm0x;
	c.skinCm0y = c.skinCmy = c.cm0y;
	c.skinCm0z = c.skinCmz = c.cm0z;
	for (let i = 0; i < c.idx.length; i++) {
		const p = particles[c.idx[i]];
		c.q0x[i] = c.qx[i] = p.x - c.cm0x;
		c.q0y[i] = c.qy[i] = p.y - c.cm0y;
		c.q0z[i] = c.qz[i] = p.z - c.cm0z;
	}
	rebuildAqqWeighted(c, particles);
}
/** Talk pipeline: apply the cell matrix in rest-local space. */
function transformSkinPoint(c, x, y, z) {
	const [px, py, pz] = m3MulVec(c.skinM, x - c.skinCm0x, y - c.skinCm0y, z - c.skinCm0z);
	return [
		px + c.skinCmx,
		py + c.skinCmy,
		pz + c.skinCmz
	];
}
/**
* Least-squares cell matrix from rest-local vs live-local, using the
* plastic stretch Sp. Does not touch the world-space matching state.
*/
function matchSkinLocal(c, rest, local, mass, beta) {
	let msum = 0;
	c.skinCm0x = 0;
	c.skinCm0y = 0;
	c.skinCm0z = 0;
	c.skinCmx = 0;
	c.skinCmy = 0;
	c.skinCmz = 0;
	for (const i of c.idx) {
		const r = rest[i];
		const p = local[i];
		const m = mass[i];
		c.skinCm0x += r.x * m;
		c.skinCm0y += r.y * m;
		c.skinCm0z += r.z * m;
		c.skinCmx += p.x * m;
		c.skinCmy += p.y * m;
		c.skinCmz += p.z * m;
		msum += m;
	}
	msum = Math.max(msum, 1e-8);
	c.skinCm0x /= msum;
	c.skinCm0y /= msum;
	c.skinCm0z /= msum;
	c.skinCmx /= msum;
	c.skinCmy /= msum;
	c.skinCmz /= msum;
	m3Zero(_Apq);
	m3Zero(_Aqq);
	for (const i of c.idx) {
		const r = rest[i];
		const p = local[i];
		const m = mass[i];
		const [qx, qy, qz] = m3MulVec(c.Sp, r.x - c.skinCm0x, r.y - c.skinCm0y, r.z - c.skinCm0z);
		m3OuterAdd(p.x - c.skinCmx, p.y - c.skinCmy, p.z - c.skinCmz, qx, qy, qz, m, _Apq);
		m3OuterAdd(qx, qy, qz, qx, qy, qz, m, _Aqq);
	}
	_Aqq[0] += .001;
	_Aqq[4] += .001;
	_Aqq[8] += .001;
	if (!m3Invert(_Aqq, _tmp2)) m3Id(_tmp2);
	m3Mul(_Apq, _tmp2, c.A);
	if (!m3Finite(c.A) || m3MaxAbs(c.A) > 12) m3Id(c.A);
	m3Polar(c.A, c.R, c.S);
	m3ClampRotation(c.R, .85);
	m3Lerp(_I, c.S, beta, _tmp);
	m3Mul(c.R, _tmp, c.skinM);
	if (!m3Finite(c.skinM) || m3MaxAbs(c.skinM) > 4) m3Id(c.skinM);
	if (!m3Invert(c.skinM, _tmp)) m3Id(_tmp);
	m3Transpose(_tmp, c.skinInvT);
}
function stiffnessIters(squash) {
	return Math.max(2, Math.min(5, Math.round(2 + (1.05 - squash) * 3)));
}
function goalAlpha(squash) {
	return .22 + (1 - squash) * .62;
}
function deformBeta(squash) {
	return Math.max(0, squash) * .9;
}
var CAGES = [
	{
		name: "bumperFront",
		min: [
			-.74,
			.16,
			1.88
		],
		max: [
			.74,
			.54,
			2.16
		],
		absorption: .1,
		maxCrush: .95,
		maxAngle: 1.2
	},
	{
		name: "bumperRear",
		min: [
			-.72,
			.16,
			-2.14
		],
		max: [
			.72,
			.52,
			-1.86
		],
		absorption: .12,
		maxCrush: .9,
		maxAngle: 1.1
	},
	{
		name: "bonnet",
		min: [
			-.78,
			.5,
			.72
		],
		max: [
			.78,
			.78,
			1.88
		],
		absorption: .16,
		maxCrush: .88,
		maxAngle: 1.05
	},
	{
		name: "boot",
		min: [
			-.76,
			.5,
			-1.86
		],
		max: [
			.76,
			.8,
			-.7
		],
		absorption: .18,
		maxCrush: .78,
		maxAngle: .95
	},
	{
		name: "roof",
		min: [
			-.58,
			1.02,
			-.7
		],
		max: [
			.58,
			1.34,
			.56
		],
		absorption: .52,
		maxCrush: .28,
		maxAngle: .32
	},
	{
		name: "doorLeft",
		min: [
			-.9,
			.22,
			-.58
		],
		max: [
			-.42,
			1.04,
			.7
		],
		absorption: .22,
		maxCrush: .7,
		maxAngle: 1.15
	},
	{
		name: "doorRight",
		min: [
			.42,
			.22,
			-.58
		],
		max: [
			.9,
			1.04,
			.7
		],
		absorption: .22,
		maxCrush: .7,
		maxAngle: 1.15
	},
	{
		name: "wingFL",
		min: [
			-.88,
			.16,
			.72
		],
		max: [
			-.34,
			.68,
			1.86
		],
		absorption: .14,
		maxCrush: .78,
		maxAngle: .95
	},
	{
		name: "wingFR",
		min: [
			.34,
			.16,
			.72
		],
		max: [
			.88,
			.68,
			1.86
		],
		absorption: .14,
		maxCrush: .78,
		maxAngle: .95
	},
	{
		name: "wingRL",
		min: [
			-.88,
			.16,
			-1.86
		],
		max: [
			-.34,
			.68,
			-.54
		],
		absorption: .16,
		maxCrush: .72,
		maxAngle: .85
	},
	{
		name: "wingRR",
		min: [
			.34,
			.16,
			-1.86
		],
		max: [
			.88,
			.68,
			-.54
		],
		absorption: .16,
		maxCrush: .72,
		maxAngle: .85
	},
	{
		name: "chassisFront",
		min: [
			-.58,
			.16,
			.42
		],
		max: [
			.58,
			.5,
			1.76
		],
		absorption: .28,
		maxCrush: .55,
		maxAngle: .55
	},
	{
		name: "chassisCell",
		min: [
			-.66,
			.2,
			-.48
		],
		max: [
			.66,
			1.06,
			.64
		],
		absorption: .72,
		maxCrush: .16,
		maxAngle: .16
	},
	{
		name: "chassisRear",
		min: [
			-.58,
			.16,
			-1.76
		],
		max: [
			.58,
			.5,
			-.32
		],
		absorption: .3,
		maxCrush: .5,
		maxAngle: .48
	},
	{
		name: "skirtLeft",
		min: [
			-.9,
			.14,
			-1.32
		],
		max: [
			-.54,
			.36,
			1.32
		],
		absorption: .22,
		maxCrush: .42,
		maxAngle: .5
	},
	{
		name: "skirtRight",
		min: [
			.54,
			.14,
			-1.32
		],
		max: [
			.9,
			.36,
			1.32
		],
		absorption: .22,
		maxCrush: .42,
		maxAngle: .5
	},
	{
		name: "glassFront",
		min: [
			-.64,
			.68,
			.38
		],
		max: [
			.64,
			1.36,
			1.16
		],
		absorption: .48,
		maxCrush: .32,
		maxAngle: .35
	},
	{
		name: "glassRear",
		min: [
			-.6,
			.68,
			-1.38
		],
		max: [
			.6,
			1.34,
			-.58
		],
		absorption: .5,
		maxCrush: .28,
		maxAngle: .32
	}
];
var SENSORS = [
	{
		rest: [
			0,
			.36,
			2.08
		],
		radius: .42,
		part: "bumperFront",
		absorption: .08,
		maxCompression: 1,
		neighbors: [
			1,
			2,
			3
		]
	},
	{
		rest: [
			-.62,
			.36,
			1.96
		],
		radius: .36,
		part: "bumperFront",
		absorption: .1,
		maxCompression: 1,
		neighbors: [0, 4]
	},
	{
		rest: [
			.62,
			.36,
			1.96
		],
		radius: .36,
		part: "bumperFront",
		absorption: .1,
		maxCompression: 1,
		neighbors: [0, 5]
	},
	{
		rest: [
			0,
			.66,
			1.42
		],
		radius: .4,
		part: "bonnet",
		absorption: .14,
		maxCompression: 1,
		neighbors: [0, 12]
	},
	{
		rest: [
			-.72,
			.44,
			1.32
		],
		radius: .36,
		part: "wingFL",
		absorption: .12,
		maxCompression: 1,
		neighbors: [1, 6]
	},
	{
		rest: [
			.72,
			.44,
			1.32
		],
		radius: .36,
		part: "wingFR",
		absorption: .12,
		maxCompression: 1,
		neighbors: [2, 7]
	},
	{
		rest: [
			-.86,
			.56,
			.26
		],
		radius: .4,
		part: "doorLeft",
		absorption: .18,
		maxCompression: 1,
		neighbors: [
			4,
			8,
			14
		]
	},
	{
		rest: [
			.86,
			.56,
			.26
		],
		radius: .4,
		part: "doorRight",
		absorption: .18,
		maxCompression: 1,
		neighbors: [
			5,
			9,
			15
		]
	},
	{
		rest: [
			-.86,
			.4,
			-.52
		],
		radius: .36,
		part: "doorLeft",
		absorption: .2,
		maxCompression: .95,
		neighbors: [6, 10]
	},
	{
		rest: [
			.86,
			.4,
			-.52
		],
		radius: .36,
		part: "doorRight",
		absorption: .2,
		maxCompression: .95,
		neighbors: [7, 11]
	},
	{
		rest: [
			-.72,
			.44,
			-1.32
		],
		radius: .36,
		part: "wingRL",
		absorption: .14,
		maxCompression: 1,
		neighbors: [8, 13]
	},
	{
		rest: [
			.72,
			.44,
			-1.32
		],
		radius: .36,
		part: "wingRR",
		absorption: .14,
		maxCompression: 1,
		neighbors: [9, 13]
	},
	{
		rest: [
			0,
			1.2,
			.06
		],
		radius: .42,
		part: "roof",
		absorption: .48,
		maxCompression: .65,
		neighbors: [3, 19]
	},
	{
		rest: [
			0,
			.38,
			-2.08
		],
		radius: .42,
		part: "bumperRear",
		absorption: .12,
		maxCompression: 1,
		neighbors: [
			16,
			17,
			18
		]
	},
	{
		rest: [
			-.8,
			.26,
			0
		],
		radius: .32,
		part: "skirtLeft",
		absorption: .18,
		maxCompression: .9,
		neighbors: [6, 8]
	},
	{
		rest: [
			.8,
			.26,
			0
		],
		radius: .32,
		part: "skirtRight",
		absorption: .18,
		maxCompression: .9,
		neighbors: [7, 9]
	},
	{
		rest: [
			-.64,
			.36,
			-1.96
		],
		radius: .36,
		part: "bumperRear",
		absorption: .12,
		maxCompression: 1,
		neighbors: [13, 10]
	},
	{
		rest: [
			.64,
			.36,
			-1.96
		],
		radius: .36,
		part: "bumperRear",
		absorption: .12,
		maxCompression: 1,
		neighbors: [13, 11]
	},
	{
		rest: [
			0,
			.68,
			-1.38
		],
		radius: .4,
		part: "boot",
		absorption: .16,
		maxCompression: .95,
		neighbors: [13, 12]
	},
	{
		rest: [
			0,
			.6,
			.04
		],
		radius: .5,
		part: "chassisCell",
		absorption: .62,
		maxCompression: .45,
		neighbors: [
			12,
			3,
			18
		]
	}
];
var MASS_SPECS = [
	{
		name: "bumperFL",
		rest: [
			-.52,
			.38,
			2.06
		],
		mass: 9,
		radius: .28
	},
	{
		name: "bumperFR",
		rest: [
			.52,
			.38,
			2.06
		],
		mass: 9,
		radius: .28
	},
	{
		name: "engineL",
		rest: [
			-.3,
			.44,
			1.22
		],
		mass: 88,
		radius: .36
	},
	{
		name: "engineR",
		rest: [
			.3,
			.44,
			1.22
		],
		mass: 88,
		radius: .36
	},
	{
		name: "railL",
		rest: [
			-.52,
			.38,
			.68
		],
		mass: 30,
		radius: .26
	},
	{
		name: "railR",
		rest: [
			.52,
			.38,
			.68
		],
		mass: 30,
		radius: .26
	},
	{
		name: "cell",
		rest: [
			0,
			.55,
			.06
		],
		mass: 260,
		radius: .5
	},
	{
		name: "doorL",
		rest: [
			-.78,
			.56,
			.08
		],
		mass: 22,
		radius: .3
	},
	{
		name: "doorR",
		rest: [
			.78,
			.56,
			.08
		],
		mass: 22,
		radius: .3
	},
	{
		name: "roof",
		rest: [
			0,
			1.18,
			.02
		],
		mass: 32,
		radius: .36
	},
	{
		name: "tank",
		rest: [
			0,
			.4,
			-.88
		],
		mass: 48,
		radius: .32
	},
	{
		name: "axleR",
		rest: [
			0,
			.36,
			-1.4
		],
		mass: 64,
		radius: .32
	},
	{
		name: "bumperRL",
		rest: [
			-.52,
			.36,
			-2.06
		],
		mass: 8,
		radius: .26
	},
	{
		name: "bumperRR",
		rest: [
			.52,
			.36,
			-2.06
		],
		mass: 8,
		radius: .26
	},
	{
		name: "wingFL",
		rest: [
			-.68,
			.4,
			1.28
		],
		mass: 18,
		radius: .26
	},
	{
		name: "wingFR",
		rest: [
			.68,
			.4,
			1.28
		],
		mass: 18,
		radius: .26
	},
	{
		name: "hubFL",
		rest: [
			-.74,
			.32,
			1.34
		],
		mass: 26,
		radius: .28
	},
	{
		name: "hubFR",
		rest: [
			.74,
			.32,
			1.34
		],
		mass: 26,
		radius: .28
	},
	{
		name: "hubRL",
		rest: [
			-.74,
			.32,
			-1.34
		],
		mass: 26,
		radius: .28
	},
	{
		name: "hubRR",
		rest: [
			.74,
			.32,
			-1.34
		],
		mass: 26,
		radius: .28
	}
];
/** Rectangular crumple boxes at the nose and tail — no diagonal truss. */
var BEAM_SPECS = [
	[
		"bumperFL",
		"bumperFR",
		700,
		1400,
		.75
	],
	[
		"bumperFL",
		"wingFL",
		2e3,
		4200,
		.92
	],
	[
		"bumperFR",
		"wingFR",
		2e3,
		4200,
		.92
	],
	[
		"wingFL",
		"engineL",
		3800,
		8e3,
		.78
	],
	[
		"wingFR",
		"engineR",
		3800,
		8e3,
		.78
	],
	[
		"engineL",
		"engineR",
		42e3,
		9e4,
		.14
	],
	[
		"engineL",
		"railL",
		7e3,
		14e3,
		.78
	],
	[
		"engineR",
		"railR",
		7e3,
		14e3,
		.78
	],
	[
		"railL",
		"cell",
		14e3,
		28e3,
		.38
	],
	[
		"railR",
		"cell",
		14e3,
		28e3,
		.38
	],
	[
		"engineL",
		"cell",
		3500,
		8e3,
		.78
	],
	[
		"engineR",
		"cell",
		3500,
		8e3,
		.78
	],
	[
		"cell",
		"doorL",
		7e3,
		14e3,
		.5
	],
	[
		"cell",
		"doorR",
		7e3,
		14e3,
		.5
	],
	[
		"railL",
		"doorL",
		5e3,
		11e3,
		.48
	],
	[
		"railR",
		"doorR",
		5e3,
		11e3,
		.48
	],
	[
		"cell",
		"roof",
		42e3,
		98e3,
		.14
	],
	[
		"doorL",
		"roof",
		6e3,
		12e3,
		.32
	],
	[
		"doorR",
		"roof",
		6e3,
		12e3,
		.32
	],
	[
		"cell",
		"tank",
		28e3,
		7e4,
		.22
	],
	[
		"tank",
		"axleR",
		9e3,
		18e3,
		.5
	],
	[
		"doorL",
		"tank",
		4500,
		9e3,
		.4
	],
	[
		"doorR",
		"tank",
		4500,
		9e3,
		.4
	],
	[
		"wingFL",
		"railL",
		4e3,
		9e3,
		.55
	],
	[
		"wingFR",
		"railR",
		4e3,
		9e3,
		.55
	],
	[
		"railL",
		"railR",
		25e3,
		56e3,
		.18
	],
	[
		"doorL",
		"doorR",
		8e3,
		4e4,
		.12
	],
	[
		"roof",
		"engineL",
		8e3,
		18e3,
		.16
	],
	[
		"roof",
		"engineR",
		8e3,
		18e3,
		.16
	],
	[
		"bumperRL",
		"bumperRR",
		700,
		1400,
		.75
	],
	[
		"bumperRL",
		"hubRL",
		1800,
		4e3,
		.9
	],
	[
		"bumperRR",
		"hubRR",
		1800,
		4e3,
		.9
	],
	[
		"hubFL",
		"wingFL",
		9e3,
		2e4,
		.22
	],
	[
		"hubFL",
		"engineL",
		7e3,
		16e3,
		.26
	],
	[
		"hubFL",
		"railL",
		5e3,
		12e3,
		.22
	],
	[
		"hubFR",
		"wingFR",
		9e3,
		2e4,
		.22
	],
	[
		"hubFR",
		"engineR",
		7e3,
		16e3,
		.26
	],
	[
		"hubFR",
		"railR",
		5e3,
		12e3,
		.22
	],
	[
		"hubFL",
		"hubFR",
		16e3,
		36e3,
		.1
	],
	[
		"hubRL",
		"axleR",
		8e3,
		18e3,
		.24
	],
	[
		"hubRR",
		"axleR",
		8e3,
		18e3,
		.24
	],
	[
		"hubRL",
		"tank",
		5e3,
		12e3,
		.26
	],
	[
		"hubRR",
		"tank",
		5e3,
		12e3,
		.26
	],
	[
		"hubRL",
		"hubRR",
		16e3,
		36e3,
		.1
	],
	[
		"hubRL",
		"doorL",
		9e3,
		2e4,
		.2
	],
	[
		"hubRR",
		"doorR",
		9e3,
		2e4,
		.2
	]
];
var _a = new Vector3();
var _b = new Vector3();
var _c = new Vector3();
var _d = new Vector3();
var _e = new Vector3();
var _f = new Vector3();
var _n$2 = new Vector3();
var _q = new Quaternion();
var _axis = new Vector3();
var _mat = new Matrix4();
function hash01(i, salt = 1) {
	const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
	return s - Math.floor(s);
}
function trilinear(corners, u, v, w, out) {
	const c00x = corners[0].x + (corners[1].x - corners[0].x) * u;
	const c00y = corners[0].y + (corners[1].y - corners[0].y) * u;
	const c00z = corners[0].z + (corners[1].z - corners[0].z) * u;
	const c10x = corners[2].x + (corners[3].x - corners[2].x) * u;
	const c10y = corners[2].y + (corners[3].y - corners[2].y) * u;
	const c10z = corners[2].z + (corners[3].z - corners[2].z) * u;
	const c01x = corners[4].x + (corners[5].x - corners[4].x) * u;
	const c01y = corners[4].y + (corners[5].y - corners[4].y) * u;
	const c01z = corners[4].z + (corners[5].z - corners[4].z) * u;
	const c11x = corners[6].x + (corners[7].x - corners[6].x) * u;
	const c11y = corners[6].y + (corners[7].y - corners[6].y) * u;
	const c11z = corners[6].z + (corners[7].z - corners[6].z) * u;
	const c0x = c00x + (c10x - c00x) * v;
	const c0y = c00y + (c10y - c00y) * v;
	const c0z = c00z + (c10z - c00z) * v;
	const c1x = c01x + (c11x - c01x) * v;
	const c1y = c01y + (c11y - c01y) * v;
	const c1z = c01z + (c11z - c01z) * v;
	out.set(c0x + (c1x - c0x) * w, c0y + (c1y - c0y) * w, c0z + (c1z - c0z) * w);
	return out;
}
var StreamedDeformation = class {
	cageCount;
	sensorCount;
	dirty = false;
	crushAmount = 0;
	impactLocal = new Vector3();
	impactInward = new Vector3(0, 0, -1);
	massActive = false;
	drivetrainAlive = true;
	/** Both ends are crumple zones (car-compactor / two-wall squeeze). */
	bidirectional = false;
	/** Walls past the wheel midpoint — cage/rails may yield. */
	deepCrush = false;
	cages;
	sensors;
	restPos;
	influences;
	vertexCount;
	elapsed = 0;
	lastContact = -10;
	crushing = false;
	impulse = 0;
	wrinkleAmp = 0;
	helper = null;
	helperLines = null;
	helperLinePos = null;
	helperSpheres = [];
	massHelperMeshes = [];
	beamHelperLines = null;
	beamHelperPos = null;
	beamHelperColor = null;
	clusterHelperLines = null;
	clusterHelperPos = null;
	clusterHelperColor = null;
	masses;
	beams;
	cellIndex;
	_totalMass = 1;
	prevYaw = 0;
	overlapFrame = false;
	squash = .4;
	buckle = .45;
	mode = "shape";
	clusters = [];
	shapeParticles = [];
	goalX = /* @__PURE__ */ new Float64Array(0);
	goalY = /* @__PURE__ */ new Float64Array(0);
	goalZ = /* @__PURE__ */ new Float64Array(0);
	goalW = /* @__PURE__ */ new Float64Array(0);
	skinWeights = [];
	constructor(geometry) {
		const pos = geometry.getAttribute("position");
		this.vertexCount = pos.count;
		this.restPos = new Float32Array(pos.array);
		this.cages = CAGES.map((spec) => {
			const min = new Vector3(...spec.min);
			const max = new Vector3(...spec.max);
			const restCorners = [];
			const corners = [];
			for (let iz = 0; iz < 2; iz++) for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
				const p = new Vector3(ix ? max.x : min.x, iy ? max.y : min.y, iz ? max.z : min.z);
				restCorners.push(p);
				corners.push(p.clone());
			}
			return {
				spec,
				min,
				max,
				center: min.clone().add(max).multiplyScalar(.5),
				restCorners,
				corners,
				size: max.clone().sub(min)
			};
		});
		this.cageCount = this.cages.length;
		const partIndex = /* @__PURE__ */ new Map();
		this.cages.forEach((c, i) => partIndex.set(c.spec.name, i));
		this.sensors = SENSORS.map((spec) => ({
			spec,
			rest: new Vector3(...spec.rest),
			pos: new Vector3(...spec.rest),
			partIndex: partIndex.get(spec.part) ?? 12,
			compression: 0,
			target: 0,
			delay: 0,
			fired: false
		}));
		this.sensorCount = this.sensors.length;
		const nameIndex = /* @__PURE__ */ new Map();
		this.masses = MASS_SPECS.map((spec, i) => {
			nameIndex.set(spec.name, i);
			const rest = new Vector3(...spec.rest);
			return {
				name: spec.name,
				rest,
				local: rest.clone(),
				world: rest.clone(),
				vel: new Vector3(),
				mass: spec.mass,
				radius: spec.radius,
				dynamic: false,
				clipping: false,
				popped: false,
				bands: regionCrushBands(spec.name)
			};
		});
		this.cellIndex = nameIndex.get("cell") ?? 5;
		this._totalMass = 0;
		for (const m of this.masses) this._totalMass += m.mass;
		this.beams = BEAM_SPECS.map(([na, nb, kTen, yieldK, maxShorten]) => {
			const a = nameIndex.get(na);
			const b = nameIndex.get(nb);
			const rest = this.masses[a].rest.distanceTo(this.masses[b].rest);
			const restDir = this.masses[b].rest.clone().sub(this.masses[a].rest);
			if (rest > 1e-6) restDir.multiplyScalar(1 / rest);
			return {
				a,
				b,
				rest,
				plastic: rest,
				minLen: Math.max(.1, rest * (1 - maxShorten)),
				kTen,
				yieldK,
				damp: Math.sqrt(yieldK * 8),
				alive: true,
				restDir
			};
		});
		this.influences = new Array(this.vertexCount);
		const cell = partIndex.get("chassisCell") ?? 12;
		for (let i = 0; i < this.vertexCount; i++) {
			const x = this.restPos[i * 3];
			const y = this.restPos[i * 3 + 1];
			const z = this.restPos[i * 3 + 2];
			const list = [];
			for (let p = 0; p < this.cages.length; p++) {
				const cage = this.cages[p];
				const name = cage.spec.name;
				if (name === "doorLeft" || name === "doorRight" || name === "glassFront" || name === "glassRear") continue;
				const u = (x - cage.min.x) / cage.size.x;
				const v = (y - cage.min.y) / cage.size.y;
				const w = (z - cage.min.z) / cage.size.z;
				const weight = axisWeight(u) * axisWeight(v) * axisWeight(w);
				if (weight > .02) list.push({
					part: p,
					u,
					v,
					w,
					weight
				});
			}
			if (list.length === 0) {
				const cage = this.cages[cell];
				list.push({
					part: cell,
					u: MathUtils.clamp((x - cage.min.x) / cage.size.x, 0, 1),
					v: MathUtils.clamp((y - cage.min.y) / cage.size.y, 0, 1),
					w: MathUtils.clamp((z - cage.min.z) / cage.size.z, 0, 1),
					weight: 1
				});
			} else {
				list.sort((a, b) => b.weight - a.weight);
				if (list.length > 4) list.length = 4;
				let sum = 0;
				for (const inf of list) sum += inf.weight;
				for (const inf of list) inf.weight /= sum;
			}
			this.influences[i] = list;
		}
		this.shapeParticles = this.masses.map((m) => ({
			x: m.rest.x,
			y: m.rest.y,
			z: m.rest.z,
			vx: 0,
			vy: 0,
			vz: 0,
			mass: m.mass
		}));
		this.goalX = new Float64Array(this.masses.length);
		this.goalY = new Float64Array(this.masses.length);
		this.goalZ = new Float64Array(this.masses.length);
		this.goalW = new Float64Array(this.masses.length);
		this.clusters = [];
		for (const cage of this.cages) {
			const idx = this.cageClusterIndices(cage);
			if (idx.length < 3) continue;
			const left = [];
			const right = [];
			const mid = [];
			for (const i of idx) {
				const x = this.masses[i].rest.x;
				if (x < -.12) left.push(i);
				else if (x > .12) right.push(i);
				else mid.push(i);
			}
			if (Math.abs(cage.center.x) < .18 && left.length >= 3 && right.length >= 3) {
				this.clusters.push(makeCluster(this.shapeParticles, left.concat(mid)));
				this.clusters.push(makeCluster(this.shapeParticles, right.concat(mid)));
			} else this.clusters.push(makeCluster(this.shapeParticles, idx));
		}
		for (const names of [
			[
				"bumperFL",
				"wingFL",
				"engineL",
				"railL"
			],
			[
				"bumperFR",
				"wingFR",
				"engineR",
				"railR"
			],
			[
				"bumperRL",
				"doorL",
				"tank",
				"axleR"
			],
			[
				"bumperRR",
				"doorR",
				"tank",
				"axleR"
			],
			[
				"doorL",
				"roof",
				"railL",
				"cell"
			],
			[
				"doorR",
				"roof",
				"railR",
				"cell"
			]
		]) {
			const idx = names.map((n) => nameIndex.get(n)).filter((i) => i !== void 0);
			if (idx.length >= 3) this.clusters.push(makeCluster(this.shapeParticles, idx));
		}
		for (const c of this.clusters) rebuildAqqWeighted(c, this.shapeParticles);
		this.buildSkinWeights();
	}
	buildSkinWeights() {
		this.skinWeights = new Array(this.vertexCount);
		const cms = this.clusters.map((c) => {
			let x = 0, y = 0, z = 0, m = 0;
			for (const i of c.idx) {
				const p = this.masses[i];
				x += p.rest.x * p.mass;
				y += p.rest.y * p.mass;
				z += p.rest.z * p.mass;
				m += p.mass;
			}
			m = Math.max(m, 1e-8);
			return {
				x: x / m,
				y: y / m,
				z: z / m
			};
		});
		for (let i = 0; i < this.vertexCount; i++) {
			const rx = this.restPos[i * 3];
			const ry = this.restPos[i * 3 + 1];
			const rz = this.restPos[i * 3 + 2];
			const scored = [];
			for (let ci = 0; ci < this.clusters.length; ci++) {
				const cm = cms[ci];
				const d = Math.hypot(rx - cm.x, ry - cm.y, rz - cm.z);
				if (d > 1.45) continue;
				if (ry > 1.02 && cm.y < .78) continue;
				scored.push({
					ci,
					w: Math.exp(-d * 2.35)
				});
			}
			scored.sort((a, b) => b.w - a.w);
			if (scored.length > 4) scored.length = 4;
			let sum = 0;
			for (const s of scored) sum += s.w;
			if (sum > 1e-8) for (const s of scored) s.w /= sum;
			this.skinWeights[i] = scored;
		}
	}
	cageClusterIndices(cage) {
		const pad = .16;
		const idx = [];
		const side = Math.abs(cage.center.x) > .2 ? Math.sign(cage.center.x) : 0;
		for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			if (m.name.startsWith("hub")) continue;
			const p = m.rest;
			if (side !== 0 && Math.sign(p.x) !== 0 && Math.sign(p.x) !== side) continue;
			if (p.x >= cage.min.x - pad && p.x <= cage.max.x + pad && p.y >= cage.min.y - pad && p.y <= cage.max.y + pad && p.z >= cage.min.z - pad && p.z <= cage.max.z + pad) idx.push(i);
		}
		if (idx.length < 3) {
			const scored = this.masses.map((m, i) => ({
				i,
				d: m.rest.distanceTo(cage.center)
			})).filter((s) => !this.masses[s.i].name.startsWith("hub")).sort((a, b) => a.d - b.d);
			for (const s of scored) {
				if (s.d > .95) break;
				if (Math.abs(this.masses[s.i].rest.z - cage.center.z) > 1.05) continue;
				if (side !== 0 && Math.sign(this.masses[s.i].rest.x) !== side && Math.abs(this.masses[s.i].rest.x) > .12) continue;
				if (!idx.includes(s.i)) idx.push(s.i);
				if (idx.length >= 4) break;
			}
		}
		return idx;
	}
	reset() {
		this.elapsed = 0;
		this.lastContact = -10;
		this.crushing = false;
		this.impulse = 0;
		this.wrinkleAmp = 0;
		this.crushAmount = 0;
		this.dirty = false;
		this.massActive = false;
		this.drivetrainAlive = true;
		this.bidirectional = false;
		this.deepCrush = false;
		this.prevYaw = 0;
		this.overlapFrame = false;
		this.impactInward.set(0, 0, -1);
		this.impactLocal.set(0, .36, 2.1);
		for (const s of this.sensors) {
			s.compression = 0;
			s.target = 0;
			s.delay = 0;
			s.fired = false;
			s.pos.copy(s.rest);
		}
		for (const cage of this.cages) for (let i = 0; i < 8; i++) cage.corners[i].copy(cage.restCorners[i]);
		for (const m of this.masses) {
			m.local.copy(m.rest);
			m.world.copy(m.rest);
			m.vel.set(0, 0, 0);
			m.dynamic = false;
			m.clipping = false;
			m.popped = false;
		}
		for (const b of this.beams) {
			b.plastic = b.rest;
			b.alive = true;
		}
		this.syncShapeFromMasses();
		for (const c of this.clusters) resetCluster(c, this.shapeParticles);
	}
	setMode(mode) {
		this.mode = mode;
		this.syncHelperMode();
	}
	captureShapeRest() {
		for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			const p = this.shapeParticles[i];
			p.x = m.world.x;
			p.y = m.world.y;
			p.z = m.world.z;
			p.vx = m.vel.x;
			p.vy = m.vel.y;
			p.vz = m.vel.z;
			p.mass = m.mass;
		}
		for (const c of this.clusters) resetCluster(c, this.shapeParticles);
	}
	syncShapeFromMasses() {
		for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			const p = this.shapeParticles[i];
			p.x = m.world.x;
			p.y = m.world.y;
			p.z = m.world.z;
			p.vx = m.vel.x;
			p.vy = m.vel.y;
			p.vz = m.vel.z;
		}
	}
	writeShapeToMasses() {
		for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			if (!m.dynamic) continue;
			if (m.name.startsWith("hub") && !m.popped && !this.deepCrush) continue;
			const p = this.shapeParticles[i];
			m.world.set(p.x, p.y, p.z);
			m.vel.set(p.vx, p.vy, p.vz);
			if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) m.world.copy(m.rest);
			clampSpeed(m.vel);
		}
	}
	bindKinematic(group, worldVel, worldOmega) {
		group.updateMatrixWorld();
		const ox = group.position.x;
		const oz = group.position.z;
		for (const m of this.masses) {
			m.local.copy(m.rest);
			m.world.copy(m.rest).applyMatrix4(group.matrixWorld);
			m.vel.copy(worldVel);
			const rx = m.world.x - ox;
			const rz = m.world.z - oz;
			m.vel.x += -worldOmega.y * rz;
			m.vel.z += worldOmega.y * rx;
			m.dynamic = false;
		}
	}
	beginCrush(localPoint, localInward, impulse, group, worldVel, worldOmega) {
		this.impactLocal.copy(localPoint);
		this.impactInward.copy(localInward).normalize();
		this.impulse = MathUtils.clamp(impulse, 4, 70);
		this.crushing = true;
		this.massActive = true;
		this.elapsed = 0;
		this.lastContact = 0;
		this.wrinkleAmp = 0;
		this.dirty = true;
		this.bindKinematic(group, worldVel, worldOmega);
		for (const m of this.masses) m.dynamic = true;
		this.captureShapeRest();
		this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
		this.snapImpactToNearestMass();
		for (const s of this.sensors) {
			s.target = 0;
			s.compression = 0;
			s.delay = 0;
			s.fired = false;
			s.pos.copy(s.rest);
		}
	}
	/** Mark that a collision is still happening so settle/cutDrive stay off. */
	notifyContact() {
		this.lastContact = this.elapsed;
	}
	quietTime() {
		return Math.max(0, this.elapsed - this.lastContact);
	}
	/** Enable lattice masses without starting the crash cinematic (speed-bump hop). */
	armMasses(group, worldVel, worldOmega) {
		if (this.massActive) return;
		this.massActive = true;
		this.bindKinematic(group, worldVel, worldOmega);
		for (const m of this.masses) m.dynamic = true;
		this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
	}
	/** Pull impactLocal onto the nearest mass so L/R crush does not sit on the centerline. */
	snapImpactToNearestMass() {
		if (Math.abs(this.impactLocal.x) < .2) {
			let bestZ = this.impactLocal.z;
			let bestD = Infinity;
			for (const m of this.masses) {
				if (m.name === "cell" || m.name === "roof") continue;
				const dz = m.rest.z - this.impactLocal.z;
				const d = dz * dz + m.rest.x * m.rest.x * .15;
				if (d < bestD) {
					bestD = d;
					bestZ = m.rest.z;
				}
			}
			this.impactLocal.z = this.impactLocal.z * .28 + bestZ * .72;
			return;
		}
		let best = null;
		let bestD = Infinity;
		const hitSide = Math.sign(this.impactLocal.x);
		for (const m of this.masses) {
			if (m.name === "cell" || m.name === "roof") continue;
			if (hitSide !== 0 && Math.sign(m.rest.x) !== 0 && Math.sign(m.rest.x) !== hitSide) continue;
			const dx = m.rest.x - this.impactLocal.x;
			const dz = m.rest.z - this.impactLocal.z;
			const d = dx * dx + dz * dz;
			if (d < bestD) {
				bestD = d;
				best = m;
			}
		}
		if (!best) return;
		this.impactLocal.x = this.impactLocal.x * .28 + best.rest.x * .72;
		this.impactLocal.z = this.impactLocal.z * .28 + best.rest.z * .72;
	}
	get totalMass() {
		return this._totalMass;
	}
	/** Stopping impulse lands on the crumple face so the rear keeps piling in. */
	applyImpulse(nx, ny, nz, j) {
		if (!this.massActive || j === 0) return;
		const pass = this.frontTransfer();
		const weights = [];
		let wsum = 0;
		for (const m of this.masses) {
			if (!m.dynamic) {
				weights.push(0);
				continue;
			}
			let w = this.impactWeight(m);
			if (this.crumpleWeight(m) < .45) w *= pass;
			weights.push(w);
			wsum += w;
		}
		if (wsum < 1e-6) for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			if (!m.dynamic) continue;
			const w = this.crumpleWeight(m);
			weights[i] = w;
			wsum += w;
		}
		if (wsum < 1e-6) return;
		for (let i = 0; i < this.masses.length; i++) {
			const m = this.masses[i];
			if (!m.dynamic) continue;
			const dv = j * (weights[i] / wsum) / m.mass;
			m.vel.x += nx * dv;
			m.vel.y += ny * dv;
			m.vel.z += nz * dv;
			clampSpeed(m.vel);
		}
	}
	kickNearest(worldPoint, nx, ny, nz, j) {
		if (!this.massActive || j === 0) return;
		let best = null;
		let bestD = Infinity;
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			const d = m.world.distanceToSquared(worldPoint);
			if (d < bestD) {
				bestD = d;
				best = m;
			}
		}
		if (!best) return;
		best.vel.x += nx * j / best.mass;
		best.vel.y += ny * j / best.mass;
		best.vel.z += nz * j / best.mass;
	}
	kickNearestHub(worldPoint, jUp) {
		if (!this.massActive || jUp === 0) return null;
		let best = null;
		let bestD = Infinity;
		for (const m of this.masses) {
			if (!m.dynamic || !m.name.startsWith("hub")) continue;
			const d = m.world.distanceToSquared(worldPoint);
			if (d < bestD) {
				bestD = d;
				best = m;
			}
		}
		if (!best) {
			this.kickNearest(worldPoint, 0, 1, 0, jUp);
			return null;
		}
		best.vel.y += jUp / best.mass;
		if (jUp / best.mass > .9) this.popHub(best);
		return best.name;
	}
	hubPopped(name) {
		return !!this.masses.find((n) => n.name === name)?.popped;
	}
	popHub(m) {
		m.popped = true;
	}
	massLocal(name) {
		return this.massByName(name).local;
	}
	massWorld(name) {
		return this.massByName(name).world;
	}
	/** Extra XZ drag once contact has ended — same Coulomb as the tires. */
	dragGround(dt, amount) {
		if (!this.massActive || amount <= 0) return;
		const mu = CRASH.muSlide * (.35 + amount * 1.25);
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			applyGroundFriction(m.vel, dt, mu, true);
		}
	}
	cutDrive(dt) {
		if (!this.massActive || this.drivetrainAlive) return;
		const k = Math.pow(.55, Math.min(dt, .05));
		for (const m of this.masses) {
			if (!m.name.startsWith("hub")) continue;
			m.vel.x *= k;
			m.vel.z *= k;
		}
	}
	/** Engine/rails shifted enough that the drivetrain would be toast. */
	updateDrivetrain() {
		if (!this.drivetrainAlive || !this.massActive) return;
		const el = this.massByName("engineL");
		const er = this.massByName("engineR");
		const travel = Math.max(el.local.distanceTo(el.rest), er.local.distanceTo(er.rest));
		const bonnet = this.partCompression("bonnet");
		if (travel > .1 || bonnet > .28) this.drivetrainAlive = false;
	}
	massByName(name) {
		for (const m of this.masses) if (m.name === name) return m;
		return this.masses[this.cellIndex];
	}
	/** How much of this mass belongs to the crumple zone facing the impact (0 = cell, 1 = bumper). */
	crumpleWeight(m) {
		if (m.name === "cell" || m.name === "roof") return 0;
		if (m.name.startsWith("hub")) return 0;
		if (m.name.startsWith("bumper")) return 1;
		const along = -(m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z);
		let w = MathUtils.clamp(along / 1.55, 0, 1);
		if ((m.name === "doorL" || m.name === "doorR") && Math.abs(this.impactInward.z) > Math.abs(this.impactInward.x)) w = Math.min(w, .15);
		return w;
	}
	nodePacked(m) {
		if (m.local.distanceTo(m.rest) >= m.bands.max * .97) return true;
		const ix = this.impactInward.x;
		const iz = this.impactInward.z;
		const alongM = -(m.rest.x * ix + m.rest.z * iz);
		for (const beam of this.beams) {
			const a = this.masses[beam.a];
			const b = this.masses[beam.b];
			if (a !== m && b !== m) continue;
			const other = a === m ? b : a;
			if (-(other.rest.x * ix + other.rest.z * iz) >= alongM - .04) continue;
			if (!beam.alive) continue;
			if (m.world.distanceTo(other.world) <= beam.minLen + .03 || beam.plastic <= beam.minLen + .012) return true;
		}
		return false;
	}
	nodeTransfer(m) {
		return forceTransfer(m.local.distanceTo(m.rest), m.bands, this.nodePacked(m));
	}
	/** Weighted transfer of the crumple face currently taking the hit. */
	frontTransfer() {
		let sum = 0;
		let wsum = 0;
		for (const m of this.masses) {
			const w = this.impactWeight(m);
			if (w < .05) continue;
			sum += this.nodeTransfer(m) * w;
			wsum += w;
		}
		return wsum > 1e-6 ? sum / wsum : .1;
	}
	/** 1 at the hit corner, ~0 on the opposite side of the same axle. */
	cornerWeight(m) {
		const hitX = this.impactLocal.x;
		if (Math.abs(hitX) < .2) return 1;
		const lat = Math.abs(m.rest.x - hitX);
		const hitSide = Math.sign(hitX);
		const nodeSide = Math.sign(m.rest.x);
		const opposite = nodeSide !== 0 && nodeSide !== hitSide;
		return Math.exp(-lat * (opposite ? 4.6 : 1.8)) * (opposite ? .06 : 1);
	}
	impactWeight(m) {
		const far = m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z;
		if (!this.bidirectional && far > .18) return 0;
		return this.crumpleWeight(m) * this.cornerWeight(m);
	}
	isCageBeam(beam) {
		const a = this.masses[beam.a].name;
		const b = this.masses[beam.b].name;
		return a === "cell" || b === "cell" || a === "roof" || b === "roof" || a === "railL" || a === "railR" || b === "railL" || b === "railR";
	}
	impulseAt(worldPoint, worldNormal, closing) {
		if (!this.massActive) return;
		const seed = MathUtils.clamp(Math.abs(closing) * .0025 * this.squash, .01, .08);
		const kick = Math.abs(closing) * .45;
		const lift = Math.max(.22, .82 - worldPoint.y) * Math.abs(closing) * .55;
		for (const m of this.masses) {
			const zone = this.impactWeight(m);
			if (zone < .04) continue;
			const d = m.world.distanceTo(worldPoint);
			const reach = m.radius * 2.8;
			if (d > reach) continue;
			const w = (1 - d / reach) ** 2 * zone;
			const into = 1;
			m.world.addScaledVector(worldNormal, into * seed * w * (.5 + zone));
			m.vel.addScaledVector(worldNormal, into * kick * w * 12 / m.mass);
			if (m.rest.z < -.2) m.vel.y += lift * w * .12;
			else if (m.rest.z > .6) m.vel.y += lift * w * .02;
		}
	}
	collideWith(other) {
		for (const m of this.masses) m.clipping = false;
		for (const m of other.masses) m.clipping = false;
		for (const a of this.masses) for (const b of other.masses) {
			_n$2.copy(b.world).sub(a.world);
			if (_n$2.length() < a.radius + b.radius - .02) {
				a.clipping = true;
				b.clipping = true;
			}
			sphereHit(a, b);
		}
	}
	stepStructure(dt) {
		if (!this.massActive) return;
		const slices = dt > .008 ? 4 : 1;
		const h = dt / slices;
		for (let s = 0; s < slices; s++) this.stepMassSlice(h);
		this.updateDrivetrain();
	}
	followGroup(group, velocityOut, angularOut, dt) {
		const cell = this.massByName("cell");
		const engL = this.massByName("engineL");
		const engR = this.massByName("engineR");
		const axle = this.massByName("axleR");
		const fx = (engL.world.x + engR.world.x) * .5 - axle.world.x;
		const fy = (engL.world.y + engR.world.y) * .5 - axle.world.y;
		const fz = (engL.world.z + engR.world.z) * .5 - axle.world.z;
		const yawLen = Math.hypot(fx, fz);
		const yaw = yawLen > .15 ? Math.atan2(fx, fz) : this.prevYaw;
		const pitch = MathUtils.clamp(Math.atan2(-fy, Math.max(yawLen, .15)), -.2, .22);
		const roll = MathUtils.clamp((engR.world.y - engL.world.y) * .55, -.5, .5);
		if (!Number.isFinite(yaw + pitch + roll)) group.rotation.set(0, this.prevYaw, 0, "YXZ");
		else group.rotation.set(pitch, yaw, roll, "YXZ");
		group.updateMatrixWorld();
		_a.copy(cell.rest).applyQuaternion(group.quaternion);
		let minHub = Infinity;
		for (const m of this.masses) if (m.name.startsWith("hub") && m.world.y < minHub) minHub = m.world.y;
		let gy = cell.world.y - _a.y;
		if (minHub > .5) gy = MathUtils.clamp(gy, 0, .12);
		else gy = MathUtils.clamp(gy, 0, .08);
		group.position.set(cell.world.x - _a.x, gy, cell.world.z - _a.z);
		group.updateMatrixWorld();
		let mx = 0, my = 0, mz = 0, mass = 0;
		for (const m of this.masses) {
			m.local.copy(m.world);
			group.worldToLocal(m.local);
			mx += m.vel.x * m.mass;
			my += m.vel.y * m.mass;
			mz += m.vel.z * m.mass;
			mass += m.mass;
		}
		this.clampLocal(group);
		let hx = 0, hy = 0, hz = 0, hm = 0;
		for (const m of this.masses) {
			if (!m.name.startsWith("hub")) continue;
			hx += m.vel.x * m.mass;
			hy += m.vel.y * m.mass;
			hz += m.vel.z * m.mass;
			hm += m.mass;
		}
		if (hm > 1e-6) velocityOut.set(mx / mass, MathUtils.clamp(hy / hm, -3, 4), mz / mass);
		else velocityOut.set(mx / mass, 0, mz / mass);
		clampSpeed(velocityOut, CRASH.maxMassMps);
		if (dt > 1e-5) {
			let dyaw = yaw - this.prevYaw;
			if (dyaw > Math.PI) dyaw -= Math.PI * 2;
			if (dyaw < -Math.PI) dyaw += Math.PI * 2;
			const yawRate = MathUtils.clamp(dyaw / dt, -6, 6);
			angularOut.set(MathUtils.clamp(pitch * .4, -2, 2), Number.isFinite(yawRate) ? yawRate : 0, MathUtils.clamp(roll * .4, -2, 2));
		}
		this.prevYaw = yaw;
	}
	/**
	* Push the passenger cell out of overlap. Crumple-zone masses stay on the
	* contact plane so the leftover penetration becomes plastic crush.
	*/
	separateAlong(nx, ny, nz, amount) {
		if (!this.massActive) return;
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			const keep = 1 - this.crumpleWeight(m) * .88;
			m.world.x += nx * amount * keep;
			m.world.y += ny * amount * keep;
			m.world.z += nz * amount * keep;
		}
	}
	/** Kill incoming speed on the cabin only — crumple zones keep their inertia. */
	kickCore(nx, ny, nz, dv) {
		if (!this.massActive || dv === 0) return;
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			const w = 1 - this.crumpleWeight(m);
			if (w < .08) continue;
			m.vel.x += nx * dv * w;
			m.vel.y += ny * dv * w;
			m.vel.z += nz * dv * w;
		}
	}
	crumpleTravel() {
		const cell = this.massByName("cell");
		const nose = (this.massByName("bumperFL").local.z + this.massByName("bumperFR").local.z) * .5;
		const tail = (this.massByName("bumperRL").local.z + this.massByName("bumperRR").local.z) * .5;
		return Math.max(nose - cell.local.z - .36, cell.local.z - tail - .36, 0);
	}
	/** Remaining crumple on the most-crushed corner — SAT bounce uses this so an offset hit actually spends the zone. */
	crumpleTravelCorner() {
		const cell = this.massByName("cell");
		const fl = this.massByName("bumperFL").local.z - cell.local.z - .36;
		const fr = this.massByName("bumperFR").local.z - cell.local.z - .36;
		const rl = cell.local.z - this.massByName("bumperRL").local.z - .36;
		const rr = cell.local.z - this.massByName("bumperRR").local.z - .36;
		return Math.max(Math.min(fl, fr), Math.min(rl, rr), 0);
	}
	kickAlong(nx, ny, nz, dv) {
		this.kickCore(nx, ny, nz, dv);
	}
	feedOverlap(worldPoint, inward, overlap, closing, dt = 1 / 60) {
		if (!this.massActive) return closing;
		this.overlapFrame = true;
		const leftover = leftoverCrumple(this.crumpleTravel());
		const s = this.squash;
		const live = s < .03 ? 0 : 1;
		const ke = closingKeScale(closing);
		const absorbFrac = leftover * (.5 + s * .42) * live;
		const eaten = Math.max(0, closing) * absorbFrac;
		const step = MathUtils.clamp(dt / (1 / 60), .35, 2.8);
		const crush = Math.min(Math.max(0, overlap) * (.4 + s * .35) * ke, .06 + ke * .2) * Math.min(1, step) * live;
		if (crush < 1e-5 && eaten < 1e-5) return closing;
		this.impulse = Math.max(this.impulse, MathUtils.clamp(closing, 0, 70));
		const cell = this.massByName("cell");
		const nose = (this.massByName("bumperFL").local.z + this.massByName("bumperFR").local.z) * .5;
		const tail = (this.massByName("bumperRL").local.z + this.massByName("bumperRR").local.z) * .5;
		const noseLeft = Math.max(0, nose - cell.local.z - .38);
		const tailLeft = Math.max(0, cell.local.z - tail - .38);
		const bumperLeft = MathUtils.clamp(Math.max(noseLeft, tailLeft) / 1.45, 0, 1);
		const passFront = this.frontTransfer();
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			if (m.name.startsWith("hub") && !m.popped && !this.deepCrush) continue;
			const zone = this.impactWeight(m);
			if (zone < .04) continue;
			const d = m.world.distanceTo(worldPoint);
			const reach = 1.05 + s * .35;
			if (d > reach) continue;
			const fall = (1 - d / reach) ** 2 * zone;
			const soft = regionSoftness(m.name);
			const gate = this.bidirectional ? 1 : crushGate(closing, soft) * live;
			if (gate < 1e-4) continue;
			const engineGate = m.name === "engineL" || m.name === "engineR" ? bumperLeft > .55 ? .4 : 1 : 1;
			const pass = this.crumpleWeight(m) < .45 ? passFront : 1;
			const posNibble = crush * fall * gate * soft * engineGate * pass;
			m.world.addScaledVector(inward, posNibble);
			const vn = m.vel.dot(inward);
			if (vn < 0) m.vel.addScaledVector(inward, -vn * Math.min(1, fall * .85 + gate * .15));
		}
		return Math.max(0, closing - eaten);
	}
	applyImpact(localPoint, localInward, impulse) {
		this.impactLocal.copy(localPoint);
		this.impactInward.copy(localInward).normalize();
		this.impulse = MathUtils.clamp(impulse, 4, 70);
		this.crushing = true;
		this.dirty = true;
	}
	update(simDt, geometry) {
		if (this.crushing) {
			this.elapsed += simDt;
			this.pullSensorsFromMasses(simDt);
			let maxC = 0;
			for (const s of this.sensors) if (s.compression > maxC) maxC = s.compression;
			this.crushAmount = maxC;
			this.wrinkleAmp = MathUtils.clamp(maxC * (.2 + this.buckle * .5), 0, .18 + this.buckle * .5);
			if (this.mode === "shape") this.bakeLocalSkin();
			this.solveCages();
			this.skin(geometry);
			this.crushing = this.elapsed < 2.4 || maxC > .02;
		}
		this.updateHelper();
	}
	liveHulls(frontDetached = false, rearDetached = false) {
		const fallback = [
			{
				cx: -.38,
				cz: 1.22,
				hx: .34,
				hz: .34
			},
			{
				cx: .38,
				cz: 1.22,
				hx: .34,
				hz: .34
			},
			{
				cx: 0,
				cz: .12,
				hx: .86,
				hz: .92
			},
			{
				cx: -.38,
				cz: -1.22,
				hx: .34,
				hz: .34
			},
			{
				cx: .38,
				cz: -1.22,
				hx: .34,
				hz: .34
			}
		];
		const cell = this.massByName("cell");
		const engineL = this.massByName("engineL");
		const engineR = this.massByName("engineR");
		const doorL = this.massByName("doorL");
		const doorR = this.massByName("doorR");
		const axleR = this.massByName("axleR");
		const hubFL = this.massByName("hubFL");
		const hubFR = this.massByName("hubFR");
		const hubRL = this.massByName("hubRL");
		const hubRR = this.massByName("hubRR");
		const engineZ = (engineL.local.z + engineR.local.z) * .5;
		const zFront = engineZ + .36;
		const zFrontBack = engineZ - .12;
		const zRear = axleR.local.z - .36;
		const zRearFront = axleR.local.z + .12;
		const hzF = Math.max(.12, (zFront - zFrontBack) * .5);
		const hzR = Math.max(.12, (zRearFront - zRear) * .5);
		const midHx = MathUtils.clamp(Math.max(Math.abs(doorL.local.x), Math.abs(doorR.local.x)) + .02, .48, .8);
		return this.sanitizeHulls([
			{
				cx: (hubFL.local.x + engineL.local.x) * .5,
				cz: (zFront + zFrontBack) * .5,
				hx: .32,
				hz: hzF
			},
			{
				cx: (hubFR.local.x + engineR.local.x) * .5,
				cz: (zFront + zFrontBack) * .5,
				hx: .32,
				hz: hzF
			},
			{
				cx: cell.local.x,
				cz: (zFrontBack + zRearFront) * .5,
				hx: midHx,
				hz: Math.max(.12, (zFrontBack - zRearFront) * .5)
			},
			{
				cx: (hubRL.local.x + axleR.local.x) * .5,
				cz: (zRear + zRearFront) * .5,
				hx: .32,
				hz: hzR
			},
			{
				cx: (hubRR.local.x + axleR.local.x) * .5,
				cz: (zRear + zRearFront) * .5,
				hx: .32,
				hz: hzR
			}
		], fallback);
	}
	liveCrushHulls(frontDetached = false, rearDetached = false) {
		const fallback = [
			{
				cx: -.42,
				cz: 1.72,
				hx: .36,
				hz: .5
			},
			{
				cx: .42,
				cz: 1.72,
				hx: .36,
				hz: .5
			},
			{
				cx: 0,
				cz: .12,
				hx: .86,
				hz: .92
			},
			{
				cx: -.42,
				cz: -1.6,
				hx: .36,
				hz: .58
			},
			{
				cx: .42,
				cz: -1.6,
				hx: .36,
				hz: .58
			}
		];
		const fl = this.massByName("bumperFL");
		const fr = this.massByName("bumperFR");
		const rl = this.massByName("bumperRL");
		const rr = this.massByName("bumperRR");
		const cell = this.massByName("cell");
		const engineL = this.massByName("engineL");
		const engineR = this.massByName("engineR");
		const doorL = this.massByName("doorL");
		const doorR = this.massByName("doorR");
		const axleR = this.massByName("axleR");
		const engineZ = (engineL.local.z + engineR.local.z) * .5;
		const zFront = frontDetached ? engineZ + .34 : Math.max(fl.local.z, fr.local.z) + .12;
		const zFrontBack = Math.min(engineZ, zFront - .18);
		const zRear = rearDetached ? axleR.local.z - .28 : Math.min(rl.local.z, rr.local.z) - .12;
		const zRearFront = Math.max(axleR.local.z, zRear + .18);
		const hzF = Math.max(.12, (zFront - zFrontBack) * .5);
		const hzR = Math.max(.12, (zRearFront - zRear) * .5);
		const midHx = MathUtils.clamp(Math.max(Math.abs(doorL.local.x), Math.abs(doorR.local.x)) + .02, .48, .8);
		return this.sanitizeHulls([
			{
				cx: fl.local.x * .85,
				cz: (zFront + zFrontBack) * .5,
				hx: .34,
				hz: hzF
			},
			{
				cx: fr.local.x * .85,
				cz: (zFront + zFrontBack) * .5,
				hx: .34,
				hz: hzF
			},
			{
				cx: cell.local.x,
				cz: (zFrontBack + zRearFront) * .5,
				hx: midHx,
				hz: Math.max(.12, (zFrontBack - zRearFront) * .5)
			},
			{
				cx: rl.local.x * .85,
				cz: (zRear + zRearFront) * .5,
				hx: .34,
				hz: hzR
			},
			{
				cx: rr.local.x * .85,
				cz: (zRear + zRearFront) * .5,
				hx: .34,
				hz: hzR
			}
		], fallback);
	}
	sanitizeHulls(hulls, fallback) {
		for (let i = 0; i < hulls.length; i++) {
			const h = hulls[i];
			if (!Number.isFinite(h.cx) || !Number.isFinite(h.cz) || !Number.isFinite(h.hx) || !Number.isFinite(h.hz)) hulls[i] = fallback[i];
		}
		return hulls;
	}
	skinPanel(geometry, rest, name, origin) {
		const cage = this.cages.find((c) => c.spec.name === name);
		if (!cage) return;
		const attr = geometry.getAttribute("position");
		const arr = attr.array;
		const sx = cage.size.x || 1;
		const sy = cage.size.y || 1;
		const sz = cage.size.z || 1;
		for (let i = 0; i < attr.count; i++) {
			const x = rest[i * 3] + origin.x;
			const y = rest[i * 3 + 1] + origin.y;
			const z = rest[i * 3 + 2] + origin.z;
			const u = MathUtils.clamp((x - cage.min.x) / sx, -.15, 1.15);
			const v = MathUtils.clamp((y - cage.min.y) / sy, -.15, 1.15);
			const w = MathUtils.clamp((z - cage.min.z) / sz, -.15, 1.15);
			trilinear(cage.corners, u, v, w, _d);
			arr[i * 3] = _d.x - origin.x;
			arr[i * 3 + 1] = _d.y - origin.y;
			arr[i * 3 + 2] = _d.z - origin.z;
		}
		attr.needsUpdate = true;
		geometry.computeVertexNormals();
	}
	createHelper(parent) {
		if (this.helper) return this.helper;
		const group = new Group();
		group.name = "deform-rig";
		const sphereGeo = new SphereGeometry(.045, 10, 8);
		for (const s of this.sensors) {
			const mat = new MeshBasicMaterial({
				color: 12174548,
				transparent: true,
				opacity: .7,
				depthTest: false
			});
			const mesh = new Mesh(sphereGeo, mat);
			mesh.position.copy(s.rest);
			mesh.renderOrder = 3;
			group.add(mesh);
			this.helperSpheres.push(mesh);
		}
		const massGeo = new SphereGeometry(.055, 10, 8);
		for (const m of this.masses) {
			const mat = new MeshBasicMaterial({
				color: 13928778,
				transparent: true,
				opacity: .85,
				depthTest: false
			});
			const mesh = new Mesh(massGeo, mat);
			mesh.position.copy(m.local);
			mesh.renderOrder = 4;
			group.add(mesh);
			this.massHelperMeshes.push(mesh);
		}
		const linePos = new Float32Array(this.cages.length * 12 * 2 * 3);
		this.helperLinePos = linePos;
		const lineGeo = new BufferGeometry();
		lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
		const lineMat = new LineBasicMaterial({
			color: 14210252,
			transparent: true,
			opacity: .35,
			depthTest: false
		});
		const lines = new LineSegments(lineGeo, lineMat);
		lines.renderOrder = 2;
		group.add(lines);
		this.helperLines = lines;
		const beamPos = new Float32Array(this.beams.length * 2 * 3);
		const beamColor = new Float32Array(this.beams.length * 2 * 3);
		this.beamHelperPos = beamPos;
		this.beamHelperColor = beamColor;
		const beamGeo = new BufferGeometry();
		beamGeo.setAttribute("position", new BufferAttribute(beamPos, 3));
		beamGeo.setAttribute("color", new BufferAttribute(beamColor, 3));
		const beamMat = new LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: .92,
			depthTest: false
		});
		const beamLines = new LineSegments(beamGeo, beamMat);
		beamLines.renderOrder = 3;
		group.add(beamLines);
		this.beamHelperLines = beamLines;
		let star = 0;
		for (const c of this.clusters) star += c.idx.length;
		const clusterPos = new Float32Array(Math.max(star, 1) * 2 * 3);
		const clusterCol = new Float32Array(Math.max(star, 1) * 2 * 3);
		this.clusterHelperPos = clusterPos;
		this.clusterHelperColor = clusterCol;
		const clusterGeo = new BufferGeometry();
		clusterGeo.setAttribute("position", new BufferAttribute(clusterPos, 3));
		clusterGeo.setAttribute("color", new BufferAttribute(clusterCol, 3));
		const clusterMat = new LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: .85,
			depthTest: false
		});
		const clusterLines = new LineSegments(clusterGeo, clusterMat);
		clusterLines.renderOrder = 4;
		group.add(clusterLines);
		this.clusterHelperLines = clusterLines;
		this.helper = group;
		this.writeCageLines();
		this.writeBeamLines();
		this.writeClusterLines();
		this.syncHelperMode();
		parent.add(group);
		group.visible = false;
		return group;
	}
	setHelperVisible(v) {
		if (this.helper) this.helper.visible = v;
		if (v) this.updateHelper();
	}
	disposeHelper() {
		if (!this.helper) return;
		this.helper.removeFromParent();
		this.helper.traverse((obj) => {
			if (obj instanceof Mesh) {
				if (obj.material instanceof Material) obj.material.dispose();
			}
			if (obj instanceof LineSegments) {
				obj.geometry.dispose();
				if (obj.material instanceof Material) obj.material.dispose();
			}
		});
		this.helperSpheres[0]?.geometry.dispose();
		this.massHelperMeshes[0]?.geometry.dispose();
		this.helper = null;
		this.helperLines = null;
		this.helperSpheres = [];
		this.massHelperMeshes = [];
		this.beamHelperLines = null;
		this.beamHelperPos = null;
		this.beamHelperColor = null;
		this.clusterHelperLines = null;
		this.clusterHelperPos = null;
		this.clusterHelperColor = null;
	}
	get impulseValue() {
		return this.impulse;
	}
	get crushElapsed() {
		return this.elapsed;
	}
	partCompression(name) {
		let max = 0;
		for (const s of this.sensors) if (this.cages[s.partIndex]?.spec.name === name && s.compression > max) max = s.compression;
		return max;
	}
	sensorCompression(index) {
		return this.sensors[index]?.compression ?? 0;
	}
	cageFrame(name) {
		const cage = this.cages.find((c) => c.spec.name === name);
		if (!cage) return null;
		const center = new Vector3();
		const restCenter = cage.center.clone();
		for (const c of cage.corners) center.add(c);
		center.multiplyScalar(.125);
		_a.copy(cage.corners[1]).sub(cage.corners[0]).normalize();
		_b.copy(cage.corners[2]).sub(cage.corners[0]);
		_c.copy(_a).cross(_b);
		if (_c.lengthSq() < 1e-8) _c.copy(cage.corners[4]).sub(cage.corners[0]);
		_c.normalize();
		_b.copy(_c).cross(_a).normalize();
		_mat.makeBasis(_a, _b, _c);
		return {
			center,
			quat: new Quaternion().setFromRotationMatrix(_mat),
			restCenter
		};
	}
	restoreRest(geometry) {
		const attr = geometry.getAttribute("position");
		attr.array.set(this.restPos);
		attr.needsUpdate = true;
		geometry.computeVertexNormals();
	}
	snapshot() {
		return {
			mode: this.mode,
			crush: round4(this.crushAmount),
			elapsed: round4(this.elapsed),
			quiet: round4(this.quietTime()),
			impulse: round4(this.impulse),
			massActive: this.massActive,
			drivetrainAlive: this.drivetrainAlive,
			squash: this.squash,
			buckle: this.buckle,
			impactInward: vec3(this.impactInward),
			impactLocal: vec3(this.impactLocal),
			masses: this.masses.map((m) => ({
				name: m.name,
				mass: m.mass,
				rest: vec3(m.rest),
				local: vec3(m.local),
				world: vec3(m.world),
				vel: vec3(m.vel),
				speed: round4(m.vel.length()),
				travel: round4(m.local.distanceTo(m.rest)),
				transfer: round4(this.nodeTransfer(m)),
				packed: this.nodePacked(m),
				popped: m.popped
			})),
			beams: this.beams.map((beam) => {
				const a = this.masses[beam.a];
				const b = this.masses[beam.b];
				const len = a.world.distanceTo(b.world);
				return {
					a: a.name,
					b: b.name,
					rest: round4(beam.rest),
					plastic: round4(beam.plastic),
					minLen: round4(beam.minLen),
					alive: beam.alive,
					len: round4(len),
					strain: round4((len - beam.rest) / Math.max(beam.rest, 1e-4))
				};
			}),
			sensors: this.sensors.map((s) => ({
				part: s.spec.part,
				compression: round4(s.compression)
			})),
			clusters: this.clusters.map((c) => ({
				n: c.idx.length,
				names: c.idx.map((i) => this.masses[i].name),
				cm: {
					x: round4(c.cmx),
					y: round4(c.cmy),
					z: round4(c.cmz)
				},
				plastic: round4(c.Sp[0] + c.Sp[4] + c.Sp[8])
			}))
		};
	}
	massMaxAbsZ() {
		let m = 0;
		for (const n of this.masses) {
			if (!n.dynamic) continue;
			m = Math.max(m, Math.abs(n.world.z) - n.radius * .72, Math.abs(n.local.z) - n.radius * .72);
		}
		return m;
	}
	cageMaxAbsZ() {
		let m = 0;
		for (const cage of this.cages) for (const pt of cage.corners) m = Math.max(m, Math.abs(pt.z));
		return m;
	}
	skinMaxAbsZ(geometry) {
		const attr = geometry.getAttribute("position");
		const arr = attr.array;
		let m = 0;
		for (let i = 0; i < attr.count; i++) m = Math.max(m, Math.abs(arr[i * 3 + 2]));
		return m;
	}
	clampLocal(group) {
		const ix = this.impactInward.x;
		const iz = this.impactInward.z;
		const maxAway = .025 + this.squash * .04;
		const maxCrush = this.bidirectional ? 1.65 : .5 + this.squash * 1.15;
		for (const m of this.masses) {
			let dx = m.local.x - m.rest.x;
			let dy = m.local.y - m.rest.y;
			let dz = m.local.z - m.rest.z;
			const along = dx * ix + dz * iz;
			const side = m.rest.x * ix + m.rest.z * iz;
			if (!this.bidirectional && side > .12) {
				if (along > maxAway) {
					const extra = along - maxAway;
					m.local.x -= ix * extra;
					m.local.z -= iz * extra;
					dx = m.local.x - m.rest.x;
					dz = m.local.z - m.rest.z;
				}
				if (along < -maxAway * 2) {
					const extra = -along - maxAway * 2;
					m.local.x += ix * extra;
					m.local.z += iz * extra;
					dx = m.local.x - m.rest.x;
					dz = m.local.z - m.rest.z;
				}
			}
			const maxDy = m.name === "roof" ? this.deepCrush ? .28 : .07 : m.name.startsWith("hub") ? .07 : m.name === "cell" ? this.deepCrush ? .22 : .06 : .11;
			dy = MathUtils.clamp(dy, -maxDy, maxDy * 1.25);
			const cw = this.bidirectional ? 1 : this.cornerWeight(m);
			const cap = m.name === "cell" || m.name === "roof" ? this.deepCrush ? .72 : .12 : m.name.startsWith("hub") ? this.bidirectional ? .95 : .38 : maxCrush * (.38 + .72 * cw);
			const len = Math.hypot(dx, dz);
			if (len > cap) {
				const k = cap / len;
				dx *= k;
				dz *= k;
			}
			const latCap = this.bidirectional ? .85 : .06 + cw * .1;
			if (Math.abs(dx) > latCap) dx = Math.sign(dx) * latCap;
			if (m.name.startsWith("hub") && !this.deepCrush) {
				const popAt = m.radius * .5;
				const travel = Math.hypot(dx, dz);
				if (!m.popped && travel > popAt) m.popped = true;
				if (!m.popped) {
					dx = 0;
					dz = 0;
				}
			}
			m.local.set(m.rest.x + dx, m.rest.y + dy, m.rest.z + dz);
			if (this.bidirectional) {
				const lim = Math.abs(m.rest.z) + .04;
				if (Math.abs(m.local.z) > lim) m.local.z = Math.sign(m.local.z || m.rest.z) * lim;
			}
			m.world.copy(m.local);
			group.localToWorld(m.world);
		}
	}
	stepBeams(dt) {
		for (const beam of this.beams) {
			if (!beam.alive) continue;
			const a = this.masses[beam.a];
			const b = this.masses[beam.b];
			_n$2.copy(b.world).sub(a.world);
			const len = _n$2.length();
			if (len < 1e-5) continue;
			if (len > beam.rest * 2.2) {
				beam.alive = false;
				continue;
			}
			_n$2.multiplyScalar(1 / len);
			const front = -(a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z) >= -(b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z) ? a : b;
			const outward = Math.abs(a.rest.z) >= Math.abs(b.rest.z) ? a : b;
			const pass = this.bidirectional ? this.nodeTransfer(outward) : this.nodeTransfer(front);
			const maxStretch = 1.12 + this.squash * .35;
			if (len > beam.rest * maxStretch) {
				const extra = len - beam.rest * maxStretch;
				const ima = a.dynamic ? 1 / a.mass : 0;
				const imb = b.dynamic ? 1 / b.mass : 0;
				const inv = ima + imb;
				if (inv > 1e-8) {
					if (a.dynamic) a.world.addScaledVector(_n$2, extra * (ima / inv));
					if (b.dynamic) b.world.addScaledVector(_n$2, -extra * (imb / inv));
				}
			}
			const relV = b.vel.dot(_n$2) - a.vel.dot(_n$2);
			const ext = len - beam.plastic;
			let f = 0;
			if (ext > 0) f = beam.kTen * ext + beam.damp * relV;
			else {
				f = (beam.yieldK * ext + beam.damp * relV) * pass;
				const sideA = a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z;
				const sideB = b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z;
				const farSide = !this.bidirectional && sideA > .12 && sideB > .12;
				if ((relV < 0 || this.bidirectional) && !farSide) {
					const minLen = this.deepCrush && this.isCageBeam(beam) ? Math.min(beam.minLen, beam.rest * .22) : beam.minLen;
					const shrink = -ext * Math.min(1, Math.max(dt * (this.deepCrush ? 14 : 8.5), .03 + this.squash * .06));
					beam.plastic = Math.max(minLen, beam.plastic - shrink);
				}
			}
			const ima = a.dynamic ? 1 / a.mass : 0;
			const imb = b.dynamic ? 1 / b.mass : 0;
			if (a.dynamic) a.vel.addScaledVector(_n$2, f * ima * dt);
			if (b.dynamic) b.vel.addScaledVector(_n$2, -f * imb * dt);
		}
	}
	clusterBeta(ci, contacting) {
		const absorb = ci < this.cages.length ? this.cages[ci].spec.absorption : .1;
		if (this.squash < .03) return .04;
		if (contacting) return MathUtils.lerp(.16 + this.squash * .78, .08, MathUtils.clamp(absorb, 0, 1));
		return deformBeta(this.squash) * (1 - absorb * .35);
	}
	stepShapeMatch(dt) {
		this.syncShapeFromMasses();
		const contacting = this.overlapFrame || this.bidirectional;
		this.overlapFrame = false;
		const alpha = contacting ? this.squash < .03 ? .88 : .14 + this.squash * .72 : goalAlpha(this.squash);
		const iters = contacting ? 2 : stiffnessIters(this.squash);
		const ix = this.impactInward.x;
		const iz = this.impactInward.z;
		for (let k = 0; k < iters; k++) {
			this.goalX.fill(0);
			this.goalY.fill(0);
			this.goalZ.fill(0);
			this.goalW.fill(0);
			for (let ci = 0; ci < this.clusters.length; ci++) {
				const c = this.clusters[ci];
				matchCluster(c, this.shapeParticles, this.clusterBeta(ci, contacting));
				const cw = 1;
				for (let i = 0; i < c.idx.length; i++) {
					const pi = c.idx[i];
					const gx = c.M[0] * c.qx[i] + c.M[1] * c.qy[i] + c.M[2] * c.qz[i] + c.cmx;
					const gy = c.M[3] * c.qx[i] + c.M[4] * c.qy[i] + c.M[5] * c.qz[i] + c.cmy;
					const gz = c.M[6] * c.qx[i] + c.M[7] * c.qy[i] + c.M[8] * c.qz[i] + c.cmz;
					this.goalX[pi] += gx * cw;
					this.goalY[pi] += gy * cw;
					this.goalZ[pi] += gz * cw;
					this.goalW[pi] += cw;
				}
			}
			for (let i = 0; i < this.shapeParticles.length; i++) {
				const p = this.shapeParticles[i];
				const hub = this.masses[i];
				if (hub.name.startsWith("hub") && !this.deepCrush) continue;
				const w = this.goalW[i];
				if (w < 1e-6) continue;
				let gx = this.goalX[i] / w;
				let gy = this.goalY[i] / w;
				let gz = this.goalZ[i] / w;
				if (!Number.isFinite(gx + gy + gz)) continue;
				if (this.bidirectional) {
					gy = p.y;
					if (hub.name.startsWith("bumper") && Math.abs(gz) < Math.abs(p.z)) gz = p.z;
				} else {
					const along = (gx - p.x) * ix + (gz - p.z) * iz;
					if (along < 0) {
						gx -= ix * along;
						gz -= iz * along;
					}
				}
				const ax0 = alpha * (gx - p.x);
				const ay0 = alpha * (gy - p.y);
				const az0 = alpha * (gz - p.z);
				const step = Math.hypot(ax0, ay0, az0);
				const k = step > .14 ? .14 / step : 1;
				const ax = ax0 * k;
				const ay = ay0 * k;
				const az = az0 * k;
				p.x += ax;
				p.y += ay;
				p.z += az;
			}
		}
		if (contacting) for (const c of this.clusters) applyPlasticity(c, this.shapeParticles, dt, this.squash, true, this.buckle);
		this.writeShapeToMasses();
	}
	stepMassSlice(dt) {
		if (this.mode === "shape") this.stepShapeMatch(dt);
		else this.stepBeams(dt);
		this.stepSuspension(dt);
		for (const m of this.masses) {
			if (!m.dynamic) continue;
			const hub = m.name.startsWith("hub");
			if (hub) m.vel.y -= 9.6 * dt;
			else if (m.vel.y < 0) m.vel.y *= Math.pow(.12, dt);
			const leftover = leftoverCrumple(this.crumpleTravel());
			const quiet = this.quietTime();
			let rate = .988;
			if (quiet > .12) {
				const t = MathUtils.clamp((quiet - .12) / 1.8, 0, 1);
				const s = t * t * (3 - 2 * t);
				rate = MathUtils.lerp(.96, .18, s);
			}
			m.vel.multiplyScalar(Math.pow(rate, dt));
			clampSpeed(m.vel);
			if (quiet > 3.2 && leftover < .12 && m.vel.lengthSq() < .04) m.vel.set(0, 0, 0);
			m.world.addScaledVector(m.vel, dt);
			if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) {
				m.world.copy(m.rest);
				m.vel.set(0, 0, 0);
			}
			if (hub) {
				if (m.world.y < .28) {
					m.world.y = .28;
					if (m.vel.y < 0) m.vel.y = 0;
				}
				const mu = !this.drivetrainAlive ? CRASH.muSlide : leftoverCrumple(this.crumpleTravel()) > .28 ? CRASH.muScuff : CRASH.muSlide;
				applyGroundFriction(m.vel, dt, mu, true);
			} else if (m.world.y < .16) {
				m.world.y = .16;
				if (m.vel.y < 0) m.vel.y *= -.22;
				applyGroundFriction(m.vel, dt, CRASH.muScuff, true);
			}
			if (m.world.y > 3.4) {
				m.world.y = 3.4;
				m.vel.y = 0;
			}
			if (!hub && !this.bidirectional && m.world.y > .22) m.vel.y = MathUtils.clamp(m.vel.y, -2.2, 3);
		}
	}
	stepSuspension(dt) {
		const pairs = [
			["hubFL", "engineL"],
			["hubFR", "engineR"],
			["hubRL", "axleR"],
			["hubRR", "axleR"]
		];
		const c = 260;
		for (const [hubName, mountName] of pairs) {
			const hub = this.massByName(hubName);
			const mount = this.massByName(mountName);
			const restDy = hub.rest.y - mount.rest.y;
			const dy = hub.world.y - mount.world.y - restDy;
			const dv = hub.vel.y - mount.vel.y;
			const f = (-11e3 * dy - c * dv) * dt;
			if (hub.dynamic) hub.vel.y += f / hub.mass;
			if (mount.dynamic) mount.vel.y -= f / mount.mass;
		}
	}
	pullSensorsFromMasses(dt) {
		const inward = this.impactInward;
		const cap = Math.max(.022, dt * 24);
		for (const s of this.sensors) {
			const far = s.rest.x * inward.x + s.rest.z * inward.z;
			if (!this.bidirectional && far > .18) continue;
			const doorOnly = s.spec.part === "doorLeft" || s.spec.part === "doorRight";
			let best = 0;
			for (const m of this.masses) {
				if (doorOnly && m.name !== "doorL" && m.name !== "doorR") continue;
				const d = s.rest.distanceTo(m.rest);
				const reach = s.spec.radius * 2.2 + .22;
				if (d > reach) continue;
				const fall = (1 - d / reach) ** 2;
				_a.copy(m.local).sub(m.rest);
				const along = Math.max(0, -_a.dot(inward));
				const mag = _a.length();
				const strain = (along * 1.6 + mag * .7) / .2;
				const lat = Math.abs(s.rest.x - this.impactLocal.x);
				const hitSide = Math.sign(this.impactLocal.x);
				const sensorSide = Math.sign(s.rest.x);
				const opposite = hitSide !== 0 && sensorSide !== 0 && hitSide !== sensorSide;
				best = Math.max(best, strain * fall * Math.exp(-lat * (opposite ? 3.8 : 2.4)) * (opposite ? .15 : 1));
			}
			const next = MathUtils.clamp(best, 0, s.spec.maxCompression);
			if (next > s.compression) s.compression = Math.min(next, s.compression + cap);
			s.pos.copy(s.rest);
			let wsum = 0;
			_d.set(0, 0, 0);
			for (const m of this.masses) {
				const dist = s.rest.distanceTo(m.rest);
				if (dist > s.spec.radius * 2.4 + .3) continue;
				const w = Math.exp(-dist * 1.35);
				_e.copy(m.local).sub(m.rest);
				_d.addScaledVector(_e, w);
				wsum += w;
			}
			if (wsum > 1e-6) s.pos.addScaledVector(_d, 1 / wsum);
		}
	}
	bakeLocalSkin() {
		const rest = this.masses.map((m) => m.rest);
		const local = this.masses.map((m) => m.local);
		const mass = this.masses.map((m) => m.mass);
		const contacting = this.crushing || this.bidirectional;
		for (let ci = 0; ci < this.clusters.length; ci++) matchSkinLocal(this.clusters[ci], rest, local, mass, this.clusterBeta(ci, contacting));
	}
	solveCagesFromShape() {
		for (const cage of this.cages) for (let i = 0; i < 8; i++) {
			const rest = cage.restCorners[i];
			const corner = cage.corners[i];
			let px = 0, py = 0, pz = 0, wsum = 0;
			for (let ci = 0; ci < this.clusters.length; ci++) {
				const c = this.clusters[ci];
				const dx = rest.x - c.skinCm0x;
				const dy = rest.y - c.skinCm0y;
				const dz = rest.z - c.skinCm0z;
				const d = Math.hypot(dx, dy, dz);
				if (d > 1.4) continue;
				const w = Math.exp(-d * 2.35);
				const [x, y, z] = transformSkinPoint(c, rest.x, rest.y, rest.z);
				px += x * w;
				py += y * w;
				pz += z * w;
				wsum += w;
			}
			if (wsum > 1e-6) corner.set(px / wsum, py / wsum, pz / wsum);
			else corner.copy(rest);
		}
		this.capCageCorners();
		if (this.bidirectional) this.fitCagesToMasses();
	}
	solveCages() {
		if (this.mode === "shape") {
			this.solveCagesFromShape();
			return;
		}
		const inward = this.impactInward;
		const ramp = MathUtils.clamp(this.elapsed / .08, .45, 1);
		for (const cage of this.cages) for (let i = 0; i < 8; i++) {
			const rest = cage.restCorners[i];
			const corner = cage.corners[i];
			corner.copy(rest);
			let wsum = 0;
			_d.set(0, 0, 0);
			for (const m of this.masses) {
				if (m.name.startsWith("hub") && !m.popped) continue;
				const dist = rest.distanceTo(m.rest);
				if (dist > 1.15) continue;
				const w = Math.exp(-dist * 3.2);
				_e.copy(m.local).sub(m.rest);
				_d.addScaledVector(_e, w);
				wsum += w;
			}
			if (wsum > 1e-6) {
				const scale = (cage.spec.name === "bonnet" || cage.spec.name === "boot" || cage.spec.name.startsWith("glass")) && !this.bidirectional ? .45 : 1;
				corner.addScaledVector(_d, scale / wsum);
			}
		}
		if (!this.bidirectional) for (const s of this.sensors) {
			if (s.compression < .015) continue;
			const cage = this.cages[s.partIndex];
			const amount = s.compression * cage.spec.maxCrush * .95 * ramp;
			const hinge = cage.spec.maxAngle * s.compression * .95 * ramp;
			_axis.copy(inward).cross(_a.set(0, 1, 0));
			if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
			_axis.normalize();
			_q.setFromAxisAngle(_axis, hinge);
			const pivot = _c.copy(cage.center).addScaledVector(inward, cage.size.length() * .28);
			for (let i = 0; i < 8; i++) {
				const rest = cage.restCorners[i];
				const corner = cage.corners[i];
				const dist = rest.distanceTo(s.rest);
				const fall = Math.exp(-dist * 1.35);
				const lat = Math.abs(rest.x - this.impactLocal.x);
				const hitSide = Math.sign(this.impactLocal.x);
				const restSide = Math.sign(rest.x);
				const opposite = hitSide !== 0 && restSide !== 0 && hitSide !== restSide;
				const cornerFall = fall * Math.exp(-lat * (opposite ? 3.6 : 2.2)) * (opposite ? .14 : 1);
				const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot";
				if (lid) {
					const alongCage = cage.spec.name === "bonnet" ? (rest.z - cage.min.z) / Math.max(cage.size.z, 1e-4) : (cage.max.z - rest.z) / Math.max(cage.size.z, 1e-4);
					const pop = amount * cornerFall * Math.sin(MathUtils.clamp(alongCage, 0, 1) * Math.PI) * (.45 + this.buckle * .9);
					corner.y += pop * .85;
					corner.x += Math.sign(rest.x || 1) * pop * .18;
					corner.z += inward.z * amount * cornerFall * alongCage * .25;
				} else if (rest.x * inward.x + rest.z * inward.z < .12) corner.addScaledVector(inward, amount * cornerFall * this.squash);
				_e.copy(rest).sub(cage.center);
				const along = _e.dot(inward);
				const crease = Math.sin(along * 9 + s.compression * 4) * s.compression * (lid ? .04 : .08) * cornerFall;
				if (lid) corner.y += Math.abs(crease) * .6;
				else corner.addScaledVector(inward, crease);
				const name = cage.spec.name;
				if (!(name === "chassisCell" || name === "roof" || name === "chassisFront" || name === "chassisRear")) {
					_f.copy(corner).sub(pivot).applyQuaternion(_q).add(pivot);
					corner.lerp(_f, Math.min(1, fall * (lid ? .95 : .45)));
				}
			}
		}
		this.capCageCorners();
		if (this.bidirectional) this.fitCagesToMasses();
	}
	capCageCorners() {
		let maxTravel = 0;
		for (const m of this.masses) maxTravel = Math.max(maxTravel, m.local.distanceTo(m.rest));
		for (const cage of this.cages) {
			const isCell = cage.spec.name === "chassisCell" || cage.spec.name === "roof";
			let cap;
			if (this.bidirectional) cap = isCell && !this.deepCrush ? .16 : Math.max(2.2, maxTravel + .2);
			else if (cage.spec.name === "chassisCell") cap = .1;
			else if (cage.spec.name === "roof") cap = .14;
			else if (cage.spec.name === "doorLeft" || cage.spec.name === "doorRight") cap = .28;
			else cap = Math.min(cage.spec.maxCrush * .9, .85);
			cap = Math.max(cap, maxTravel * .95);
			if (isCell && !this.deepCrush) cap = Math.min(cap, this.bidirectional ? .16 : .14);
			for (let i = 0; i < 8; i++) {
				const rest = cage.restCorners[i];
				const corner = cage.corners[i];
				const mag = corner.distanceTo(rest);
				if (mag > cap) corner.lerpVectors(rest, corner, cap / mag);
			}
		}
	}
	/** Cage boxes follow the live mass hull — whatever collision already resolved. */
	fitCagesToMasses() {
		let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
		for (const m of this.masses) {
			minZ = Math.min(minZ, m.local.z);
			maxZ = Math.max(maxZ, m.local.z);
			minX = Math.min(minX, m.local.x);
			maxX = Math.max(maxX, m.local.x);
		}
		const zPad = .1;
		const xPad = .16;
		for (const cage of this.cages) for (const corner of cage.corners) {
			corner.z = MathUtils.clamp(corner.z, minZ - zPad, maxZ + zPad);
			corner.x = MathUtils.clamp(corner.x, minX - xPad, maxX + xPad);
		}
	}
	skin(geometry) {
		const attr = geometry.getAttribute("position");
		const arr = attr.array;
		const impact = this.impactLocal;
		const wrinkle = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
		const b = this.buckle;
		const shape = this.mode === "shape";
		for (let i = 0; i < this.vertexCount; i++) {
			const rx = this.restPos[i * 3];
			const ry = this.restPos[i * 3 + 1];
			const rz = this.restPos[i * 3 + 2];
			let px = 0, py = 0, pz = 0;
			if (shape) {
				const ws = this.skinWeights[i];
				let wsum = 0;
				for (const inf of ws) {
					const [x, y, z] = transformSkinPoint(this.clusters[inf.ci], rx, ry, rz);
					px += x * inf.w;
					py += y * inf.w;
					pz += z * inf.w;
					wsum += inf.w;
				}
				if (wsum < 1e-8) {
					const infs = this.influences[i];
					for (const inf of infs) {
						trilinear(this.cages[inf.part].corners, inf.u, inf.v, inf.w, _d);
						px += _d.x * inf.weight;
						py += _d.y * inf.weight;
						pz += _d.z * inf.weight;
					}
				}
			} else {
				const infs = this.influences[i];
				for (const inf of infs) {
					trilinear(this.cages[inf.part].corners, inf.u, inf.v, inf.w, _d);
					px += _d.x * inf.weight;
					py += _d.y * inf.weight;
					pz += _d.z * inf.weight;
				}
			}
			const bx = px, by = py, bz = pz;
			const dx = rx - impact.x;
			const dy = ry - impact.y;
			const dz = rz - impact.z;
			const dist = Math.hypot(dx, dy, dz);
			if (dist < 1.6 && wrinkle > .02 && ry > .34) {
				const fall = Math.exp(-dist * 2.1);
				const n0 = hash01(i, 3) - .5;
				const wave = Math.sin(rx * 7 + rz * 6 + n0 * 2);
				const amp = wrinkle * fall * .22 * (.35 + b * .65);
				px += Math.sign(rx || 1) * n0 * amp * .45;
				py += Math.abs(wave) * amp * .5;
			}
			const extra = Math.hypot(px - bx, py - by, pz - bz);
			const extraCap = .03 + b * .08;
			if (extra > extraCap) {
				const t = extraCap / extra;
				px = bx + (px - bx) * t;
				py = by + (py - by) * t;
				pz = bz + (pz - bz) * t;
			}
			const travel = Math.hypot(px - rx, py - ry, pz - rz);
			const cap = shape ? 1.35 : 2.2;
			if (travel > cap) {
				const t = cap / travel;
				px = rx + (px - rx) * t;
				py = ry + (py - ry) * t;
				pz = rz + (pz - rz) * t;
			}
			if (ry > 1.05 && !this.deepCrush) py = MathUtils.clamp(py, ry - .1, ry + .08);
			if (ry < .55) for (const m of this.masses) {
				if (!m.name.startsWith("hub")) continue;
				if (Math.hypot(rx - m.rest.x, rz - m.rest.z) > .4) continue;
				const keep = m.popped ? .15 : .82;
				const hx = m.popped ? m.local.x : m.rest.x;
				const hz = m.popped ? m.local.z : m.rest.z;
				px = px * (1 - keep) + hx * keep;
				pz = pz * (1 - keep) + hz * keep;
				break;
			}
			arr[i * 3] = px;
			arr[i * 3 + 1] = py;
			arr[i * 3 + 2] = pz;
		}
		attr.needsUpdate = true;
		geometry.computeVertexNormals();
		this.dirty = true;
	}
	updateHelper() {
		if (!this.helper?.visible) return;
		for (let i = 0; i < this.sensors.length; i++) {
			const s = this.sensors[i];
			const mesh = this.helperSpheres[i];
			if (!mesh) continue;
			mesh.position.copy(s.pos);
			const c = s.compression;
			mesh.scale.setScalar(1 + c * .85);
			mesh.material.color.setRGB(.72 + c * .28, .75 - c * .45, .8 - c * .65);
		}
		for (let i = 0; i < this.masses.length; i++) {
			const mesh = this.massHelperMeshes[i];
			const m = this.masses[i];
			if (!mesh || !m) continue;
			mesh.position.copy(m.local);
			const mat = mesh.material;
			const travel = m.local.distanceTo(m.rest);
			if (this.mode === "shape") mesh.scale.setScalar(1.55);
			else mesh.scale.setScalar(1);
			if (m.clipping) mat.color.setRGB(.72, .22, .95);
			else if (travel > .08) mat.color.setRGB(.95, .18 + travel * .2, .14);
			else if (this.mode === "shape") mat.color.setRGB(.45, .85, 1);
			else mat.color.setRGB(.83, .54, .29);
		}
		this.writeCageLines();
		this.writeBeamLines();
		this.writeClusterLines();
		this.syncHelperMode();
	}
	syncHelperMode() {
		if (this.beamHelperLines) this.beamHelperLines.visible = this.mode === "lattice";
		if (this.clusterHelperLines) this.clusterHelperLines.visible = this.mode === "shape";
	}
	writeClusterLines() {
		const pos = this.clusterHelperPos;
		const col = this.clusterHelperColor;
		if (!pos || !col || !this.clusterHelperLines) return;
		let o = 0;
		let c = 0;
		for (const cl of this.clusters) {
			const pe = m3FrobeniusI(cl.Sp);
			const r = .35 + Math.min(1, pe) * .6;
			const g = .75 - Math.min(1, pe) * .45;
			const b = .95;
			let cx = 0, cy = 0, cz = 0, w = 0;
			for (const pi of cl.idx) {
				const m = this.masses[pi];
				cx += m.local.x * m.mass;
				cy += m.local.y * m.mass;
				cz += m.local.z * m.mass;
				w += m.mass;
			}
			w = Math.max(w, 1e-6);
			cx /= w;
			cy /= w;
			cz /= w;
			for (const pi of cl.idx) {
				const m = this.masses[pi];
				pos[o++] = m.local.x;
				pos[o++] = m.local.y;
				pos[o++] = m.local.z;
				pos[o++] = cx;
				pos[o++] = cy;
				pos[o++] = cz;
				col[c++] = r;
				col[c++] = g;
				col[c++] = b;
				col[c++] = r;
				col[c++] = g;
				col[c++] = b;
			}
		}
		const attr = this.clusterHelperLines.geometry.getAttribute("position");
		attr.needsUpdate = true;
		const cattr = this.clusterHelperLines.geometry.getAttribute("color");
		cattr.needsUpdate = true;
	}
	writeCageLines() {
		const pos = this.helperLinePos;
		if (!pos || !this.helperLines) return;
		const edges = [
			[0, 1],
			[2, 3],
			[4, 5],
			[6, 7],
			[0, 2],
			[1, 3],
			[4, 6],
			[5, 7],
			[0, 4],
			[1, 5],
			[2, 6],
			[3, 7]
		];
		let o = 0;
		for (const cage of this.cages) for (const [a, b] of edges) {
			const pa = cage.corners[a];
			const pb = cage.corners[b];
			pos[o++] = pa.x;
			pos[o++] = pa.y;
			pos[o++] = pa.z;
			pos[o++] = pb.x;
			pos[o++] = pb.y;
			pos[o++] = pb.z;
		}
		const attr = this.helperLines.geometry.getAttribute("position");
		attr.needsUpdate = true;
	}
	writeBeamLines() {
		const pos = this.beamHelperPos;
		const col = this.beamHelperColor;
		if (!pos || !col || !this.beamHelperLines) return;
		let o = 0;
		let c = 0;
		for (const beam of this.beams) {
			const a = this.masses[beam.a];
			const b = this.masses[beam.b];
			pos[o++] = a.local.x;
			pos[o++] = a.local.y;
			pos[o++] = a.local.z;
			pos[o++] = b.local.x;
			pos[o++] = b.local.y;
			pos[o++] = b.local.z;
			_n$2.copy(b.local).sub(a.local);
			Math.max(_n$2.length(), 1e-5);
			const along = _n$2.x * beam.restDir.x + _n$2.y * beam.restDir.y + _n$2.z * beam.restDir.z;
			const strain = (along - beam.rest) / Math.max(beam.rest, 1e-4);
			const shear = Math.hypot(_n$2.x - beam.restDir.x * along, _n$2.y - beam.restDir.y * along, _n$2.z - beam.restDir.z * along) / Math.max(beam.rest, 1e-4);
			let r = .9, g = .9, bl = .88;
			if (a.clipping || b.clipping) {
				r = .72;
				g = .2;
				bl = .95;
			} else if (strain < -.04) {
				const t = MathUtils.clamp(-strain / .35, 0, 1);
				r = .95;
				g = .12 + (1 - t) * .35;
				bl = .1;
			} else if (shear > .08) {
				const t = MathUtils.clamp(shear / .4, 0, 1);
				r = .98;
				g = .42 + (1 - t) * .2;
				bl = .08;
			} else if (strain > .06) {
				r = .45;
				g = .75;
				bl = .95;
			}
			col[c++] = r;
			col[c++] = g;
			col[c++] = bl;
			col[c++] = r;
			col[c++] = g;
			col[c++] = bl;
		}
		const attr = this.beamHelperLines.geometry.getAttribute("position");
		attr.needsUpdate = true;
		const cattr = this.beamHelperLines.geometry.getAttribute("color");
		cattr.needsUpdate = true;
	}
};
function sphereHit(a, b) {
	_n$2.copy(b.world).sub(a.world);
	const dist = _n$2.length();
	const minD = a.radius + b.radius;
	if (dist >= minD || dist < 1e-6) return;
	_n$2.y *= .18;
	const nl = _n$2.length();
	if (nl < 1e-6) return;
	_n$2.multiplyScalar(1 / nl);
	const ima = a.dynamic ? 1 / a.mass : 0;
	const imb = b.dynamic ? 1 / b.mass : 0;
	const inv = ima + imb;
	if (inv < 1e-8) return;
	const crumple = a.name.startsWith("bumper") || b.name.startsWith("bumper") || a.name.startsWith("wing") || b.name.startsWith("wing");
	const tA = forceTransfer(a.local.distanceTo(a.rest), a.bands, a.local.distanceTo(a.rest) >= a.bands.max * .97);
	const tB = forceTransfer(b.local.distanceTo(b.rest), b.bands, b.local.distanceTo(b.rest) >= b.bands.max * .97);
	const t = Math.min(tA, tB);
	const overlap = (minD - dist) * (crumple ? Math.max(.28, t) : 1);
	if (a.dynamic) a.world.addScaledVector(_n$2, -overlap * (ima / inv));
	if (b.dynamic) b.world.addScaledVector(_n$2, overlap * (imb / inv));
	const rel = b.vel.dot(_n$2) - a.vel.dot(_n$2);
	if (rel < 0) {
		const e = crumple ? t >= .97 ? .08 : 0 : .18;
		const absorb = crumple ? Math.max(.12, t) : .55;
		const j = -(1 + e) * rel * absorb / inv;
		if (a.dynamic) a.vel.addScaledVector(_n$2, -j * ima);
		if (b.dynamic) b.vel.addScaledVector(_n$2, j * imb);
	}
}
function axisWeight(t) {
	if (t < -.18 || t > 1.18) return 0;
	if (t < 0) return 1 + t / .18;
	if (t > 1) return 1 - (t - 1) / .18;
	return 1;
}
var WHEEL_POS = [
	[
		-.74,
		.32,
		1.34
	],
	[
		.74,
		.32,
		1.34
	],
	[
		-.74,
		.32,
		-1.34
	],
	[
		.74,
		.32,
		-1.34
	]
];
var HULLS = [
	{
		cx: -.38,
		cz: 1.22,
		hx: .34,
		hz: .34
	},
	{
		cx: .38,
		cz: 1.22,
		hx: .34,
		hz: .34
	},
	{
		cx: 0,
		cz: .12,
		hx: .86,
		hz: .92
	},
	{
		cx: -.38,
		cz: -1.22,
		hx: .34,
		hz: .34
	},
	{
		cx: .38,
		cz: -1.22,
		hx: .34,
		hz: .34
	}
];
/** Bumper-inclusive hulls, also L/R split so SAT contact sits on the hit corner. */
var CRUSH_HULLS = [
	{
		cx: -.42,
		cz: 1.72,
		hx: .36,
		hz: .5
	},
	{
		cx: .42,
		cz: 1.72,
		hx: .36,
		hz: .5
	},
	{
		cx: 0,
		cz: .12,
		hx: .86,
		hz: .92
	},
	{
		cx: -.42,
		cz: -1.6,
		hx: .36,
		hz: .58
	},
	{
		cx: .42,
		cz: -1.6,
		hx: .36,
		hz: .58
	}
];
var CAR_HALF = {
	x: .88,
	y: .68,
	z: 2.22
};
var ARCH_R = .42;
var PROFILE = [
	{
		z: -2.14,
		hw: .56,
		y0: .18,
		yBelt: .48,
		yRoof: .48,
		cabinHw: .38,
		cabin: 0
	},
	{
		z: -1.92,
		hw: .76,
		y0: .16,
		yBelt: .58,
		yRoof: .58,
		cabinHw: .46,
		cabin: 0
	},
	{
		z: -1.58,
		hw: .86,
		y0: .155,
		yBelt: .72,
		yRoof: .74,
		cabinHw: .52,
		cabin: 0
	},
	{
		z: -1.18,
		hw: .88,
		y0: .155,
		yBelt: .78,
		yRoof: .88,
		cabinHw: .56,
		cabin: .2
	},
	{
		z: -.78,
		hw: .89,
		y0: .155,
		yBelt: .8,
		yRoof: 1.28,
		cabinHw: .58,
		cabin: 1
	},
	{
		z: -.18,
		hw: .89,
		y0: .155,
		yBelt: .82,
		yRoof: 1.34,
		cabinHw: .6,
		cabin: 1
	},
	{
		z: .42,
		hw: .88,
		y0: .155,
		yBelt: .81,
		yRoof: 1.3,
		cabinHw: .58,
		cabin: 1
	},
	{
		z: .82,
		hw: .86,
		y0: .155,
		yBelt: .76,
		yRoof: 1.05,
		cabinHw: .52,
		cabin: .4
	},
	{
		z: 1.18,
		hw: .84,
		y0: .16,
		yBelt: .66,
		yRoof: .68,
		cabinHw: .48,
		cabin: 0
	},
	{
		z: 1.58,
		hw: .78,
		y0: .17,
		yBelt: .56,
		yRoof: .56,
		cabinHw: .42,
		cabin: 0
	},
	{
		z: 1.9,
		hw: .66,
		y0: .2,
		yBelt: .5,
		yRoof: .5,
		cabinHw: .36,
		cabin: 0
	},
	{
		z: 2.14,
		hw: .46,
		y0: .22,
		yBelt: .46,
		yRoof: .46,
		cabinHw: .32,
		cabin: 0
	}
];
var SLICES = 40;
function lerp(a, b, t) {
	return a + (b - a) * t;
}
function sampleSlice(z) {
	if (z <= PROFILE[0].z) return {
		...PROFILE[0],
		z
	};
	for (let i = 1; i < PROFILE.length; i++) {
		const a = PROFILE[i - 1];
		const b = PROFILE[i];
		if (z <= b.z) {
			const t = (z - a.z) / (b.z - a.z);
			const s = t * t * (3 - 2 * t);
			return {
				z,
				hw: lerp(a.hw, b.hw, s),
				y0: lerp(a.y0, b.y0, s),
				yBelt: lerp(a.yBelt, b.yBelt, s),
				yRoof: lerp(a.yRoof, b.yRoof, s),
				cabinHw: lerp(a.cabinHw, b.cabinHw, s),
				cabin: lerp(a.cabin, b.cabin, s)
			};
		}
	}
	return {
		...PROFILE[PROFILE.length - 1],
		z
	};
}
function wheelWell(z) {
	let w = 0;
	for (const [, , wz] of WHEEL_POS) {
		const dz = z - wz;
		if (Math.abs(dz) < ARCH_R) w = Math.max(w, Math.sqrt(ARCH_R * ARCH_R - dz * dz));
	}
	return w;
}
/** Front door cut only (A-pillar to B-pillar). Rear quarter stays a solid panel. */
function doorAperture(z) {
	const z0 = 0;
	const z1 = .54;
	if (z <= z0 || z >= z1) return 0;
	return MathUtils.smoothstep(z, z0, .04) * (1 - MathUtils.smoothstep(z, .5, z1));
}
/**
* Lower body only: rocker / fender / door sill / rear quarter.
* Greenhouse (belt→roof) is pillars + roof + glass, never lofted metal.
*/
function sectionPoints(s) {
	const well = wheelWell(s.z);
	const hw = s.hw;
	const yFloor = .145;
	const yBelt = s.yBelt;
	const hole = doorAperture(s.z);
	const archY = .32 + well;
	const lift = (x, y) => {
		if (well < .03 || Math.abs(x) < hw * .58 || y > archY + .02) return y;
		const t = MathUtils.clamp((Math.abs(x) - hw * .58) / (hw * .42), 0, 1);
		return Math.max(y, lerp(y, archY, t * t * (3 - 2 * t)));
	};
	const ySideTop = lerp(yBelt, .22, hole);
	const xTop = hw - hole * .03;
	const left = [
		{
			x: -xTop,
			y: ySideTop
		},
		{
			x: -xTop,
			y: lift(-xTop, lerp(.34, ySideTop * .7, .4))
		},
		{
			x: -hw,
			y: lift(-hw, .2)
		},
		{
			x: -hw * .86,
			y: lift(-hw * .86, .16499999999999998)
		},
		{
			x: -hw * .55,
			y: yFloor
		},
		{
			x: -hw * .18,
			y: yFloor
		}
	];
	const mid = {
		x: 0,
		y: yFloor
	};
	const right = left.map((p) => ({
		x: -p.x,
		y: p.y
	})).reverse();
	return [
		...left,
		mid,
		...right
	];
}
function loftFromRings(rings, zs, u0, u1) {
	const positions = [];
	const uvs = [];
	const n = rings[0].length;
	for (let s = 0; s < rings.length; s++) {
		const u = u0 + (u1 - u0) * s / Math.max(1, rings.length - 1);
		const ring = rings[s];
		const z = zs[s];
		for (let i = 0; i < n; i++) {
			const p = ring[i];
			positions.push(p.x, p.y, z);
			uvs.push(u, i / n);
		}
	}
	const indices = [];
	for (let s = 0; s < rings.length - 1; s++) for (let i = 0; i < n; i++) {
		const i1 = (i + 1) % n;
		const a = s * n + i;
		const b = s * n + i1;
		const c = (s + 1) * n + i;
		const d = (s + 1) * n + i1;
		indices.push(a, b, c, b, d, c);
	}
	const cap = (slice, inward) => {
		const ring = rings[slice];
		let cx = 0, cy = 0;
		for (const p of ring) {
			cx += p.x;
			cy += p.y;
		}
		cx /= n;
		cy /= n;
		const center = positions.length / 3;
		positions.push(cx, cy, zs[slice]);
		uvs.push(inward ? 0 : 1, .5);
		const base = slice * n;
		for (let i = 0; i < n; i++) {
			const i1 = (i + 1) % n;
			if (inward) indices.push(center, base + i1, base + i);
			else indices.push(center, base + i, base + i1);
		}
	};
	cap(0, true);
	cap(rings.length - 1, false);
	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
	geo.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
	geo.setIndex(indices);
	return geo;
}
function ensureOutwardNormals(geo) {
	geo.computeVertexNormals();
	const pos = geo.getAttribute("position");
	const nrm = geo.getAttribute("normal");
	let bestI = 0;
	let bestX = -Infinity;
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		if (x > bestX) {
			bestX = x;
			bestI = i;
		}
	}
	if (nrm.getX(bestI) >= 0) return;
	const idx = geo.getIndex();
	if (!idx) return;
	const a = idx.array;
	for (let i = 0; i < a.length; i += 3) {
		const t = a[i + 1];
		a[i + 1] = a[i + 2];
		a[i + 2] = t;
	}
	idx.needsUpdate = true;
	geo.computeVertexNormals();
}
function makeWellLiner(wx, wy, wz) {
	const geo = new CylinderGeometry(ARCH_R, ARCH_R, .24, 18, 1, true, 0, Math.PI);
	geo.rotateZ(Math.PI / 2);
	geo.rotateY(wx > 0 ? 0 : Math.PI);
	geo.translate(wx, wy, wz);
	const uv = geo.getAttribute("uv");
	if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, .12, i / uv.count);
	return geo;
}
function makeRoofGeometry() {
	const z0 = -.82;
	const z1 = .58;
	const segs = 16;
	const rings = [];
	const zs = [];
	for (let s = 0; s <= segs; s++) {
		const z = lerp(z0, z1, s / segs);
		const sl = sampleSlice(z);
		const c = Math.max(sl.cabin, .25);
		const yRoof = lerp(sl.yBelt, sl.yRoof, c);
		const xRoof = lerp(sl.hw * .55, sl.cabinHw, c);
		const tk = .045;
		rings.push([
			{
				x: -xRoof,
				y: yRoof - tk
			},
			{
				x: -xRoof,
				y: yRoof
			},
			{
				x: -xRoof * .4,
				y: yRoof + .016
			},
			{
				x: 0,
				y: yRoof + .026
			},
			{
				x: xRoof * .4,
				y: yRoof + .016
			},
			{
				x: xRoof,
				y: yRoof
			},
			{
				x: xRoof,
				y: yRoof - tk
			},
			{
				x: 0,
				y: yRoof - tk - .008
			}
		]);
		zs.push(z);
	}
	const geo = loftFromRings(rings, zs, .28, .72);
	ensureOutwardNormals(geo);
	return geo;
}
function makePillarGeo(sign, z, x, y0, y1, depth) {
	const geo = new BoxGeometry(.085, y1 - y0, depth, 1, 2, 1);
	geo.translate(sign * x, (y0 + y1) * .5, z);
	return geo;
}
function makeSlopedPillar(x0, y0, z0, x1, y1, z1, thick, depth) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const dz = z1 - z0;
	const geo = new BoxGeometry(thick, Math.hypot(dx, dy, dz), depth, 1, 4, 1);
	const dir = new Vector3(dx, dy, dz).normalize();
	const quat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
	geo.applyQuaternion(quat);
	geo.translate((x0 + x1) * .5, (y0 + y1) * .5, (z0 + z1) * .5);
	return geo;
}
function makeHeader(z, y, w, d) {
	const geo = new BoxGeometry(w, .07, d, 1, 1, 1);
	geo.translate(0, y, z);
	return geo;
}
function makeBulkhead(z, y0, y1, w) {
	const geo = new BoxGeometry(w, y1 - y0, .045, 1, 1, 1);
	geo.translate(0, (y0 + y1) * .5, z);
	return geo;
}
function makeChassisGeometry() {
	const z0 = PROFILE[0].z;
	const z1 = PROFILE[PROFILE.length - 1].z;
	const rings = [];
	const zs = [];
	for (let s = 0; s < SLICES; s++) {
		const z = z0 + (z1 - z0) * s / 39;
		rings.push(sectionPoints(sampleSlice(z)));
		zs.push(z);
	}
	const body = loftFromRings(rings, zs, 0, 1);
	ensureOutwardNormals(body);
	const parts = [body, makeRoofGeometry()];
	for (const [wx, wy, wz] of WHEEL_POS) parts.push(makeWellLiner(wx, wy, wz));
	for (const sign of [-1, 1]) {
		parts.push(makeSlopedPillar(sign * .82, .72, .92, sign * .56, 1.3, .5, .09, .14));
		parts.push(makePillarGeo(sign, -.08, .82, .8, 1.32, .1));
		parts.push(makeSlopedPillar(sign * .84, .78, -.92, sign * .56, 1.28, -.78, .09, .14));
		const rail = new BoxGeometry(.045, .05, 1.38);
		rail.translate(sign * .86, .82, -.12);
		parts.push(rail);
	}
	parts.push(makeHeader(.48, 1.3, 1.1, .09));
	parts.push(makeHeader(-.78, 1.28, 1.08, .09));
	parts.push(makeBulkhead(.72, .34, .86, 1.2));
	parts.push(makeBulkhead(-.72, .34, .84, 1.16));
	const merged = mergeGeometries(parts, false);
	for (const g of parts) g.dispose();
	if (!merged) throw new Error("Failed to merge chassis");
	merged.computeVertexNormals();
	merged.computeBoundingBox();
	merged.computeBoundingSphere();
	return merged;
}
function makePanelShell(z0, z1, w0, w1, drop, dome) {
	const segs = 9;
	const rings = [];
	const zs = [];
	const tk = .048;
	for (let s = 0; s <= segs; s++) {
		const t = s / segs;
		const z = lerp(z0, z1, t);
		const w = lerp(w0, w1, t * t * (3 - 2 * t));
		const yTop = dome * (1 - (2 * t - 1) * (2 * t - 1));
		rings.push([
			{
				x: -w,
				y: yTop
			},
			{
				x: -w * .45,
				y: yTop + dome * .35
			},
			{
				x: 0,
				y: yTop + dome * .5
			},
			{
				x: w * .45,
				y: yTop + dome * .35
			},
			{
				x: w,
				y: yTop
			},
			{
				x: w,
				y: yTop - drop * .55
			},
			{
				x: w,
				y: yTop - drop
			},
			{
				x: w - tk,
				y: yTop - drop
			},
			{
				x: w - tk,
				y: yTop - tk
			},
			{
				x: -w + tk,
				y: yTop - tk
			},
			{
				x: -w + tk,
				y: yTop - drop
			},
			{
				x: -w,
				y: yTop - drop
			},
			{
				x: -w,
				y: yTop - drop * .55
			}
		]);
		zs.push(z);
	}
	const geo = loftFromRings(rings, zs, 0, 1);
	ensureOutwardNormals(geo);
	geo.computeBoundingBox();
	return geo;
}
function makeHoodGeometry() {
	return makePanelShell(.02, 1.2, .79, .5, .34, .05);
}
function makeTrunkGeometry() {
	return makePanelShell(.08, -1.2, .78, .6, .28, .05);
}
function makeBumperGeometry(front) {
	const geo = new BoxGeometry(1.54, .2, .16, 16, 3, 3);
	const s = front ? 1 : -1;
	const pos = geo.getAttribute("position");
	for (let i = 0; i < pos.count; i++) {
		let x = pos.getX(i);
		let y = pos.getY(i);
		let z = pos.getZ(i);
		const wrap = Math.max(0, Math.abs(x) - .58);
		z += s * -wrap * .65;
		y += (1 - Math.abs(x) / .8) * .02;
		pos.setXYZ(i, x, y, z);
	}
	geo.computeVertexNormals();
	return geo;
}
/** Door skin in hinge-local space. Parent at the A-pillar (sign*0.86, 0.54, 0.55). */
function makeDoorGeometry(sign) {
	const geo = new BoxGeometry(.05, .62, .58, 2, 5, 6);
	const pos = geo.getAttribute("position");
	for (let i = 0; i < pos.count; i++) {
		let x = pos.getX(i);
		let y = pos.getY(i);
		let z = pos.getZ(i);
		x += sign * .012;
		if (z > .16) {
			y += (z - .16) * -.06;
			x += sign * (z - .16) * .04;
		}
		if (z < -.2) y += (-.2 - z) * -.04;
		if (MathUtils.clamp((y - .12) / .28, 0, 1) > .55 && Math.abs(z) < .18) x += sign * .01;
		pos.setXYZ(i, x, y, z);
	}
	geo.computeVertexNormals();
	return geo;
}
function makeWindshield() {
	const geo = new PlaneGeometry(1.08, .72, 10, 8);
	geo.rotateX(-.84);
	geo.translate(0, 1.02, .76);
	const pos = geo.getAttribute("position");
	for (let i = 0; i < pos.count; i++) {
		let x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const top = MathUtils.clamp((y - .78) / .48, 0, 1);
		x *= lerp(1, .72, top);
		pos.setXYZ(i, x, y, z + (1 - Math.abs(x) / .7) * .02);
	}
	geo.computeVertexNormals();
	return geo;
}
function makeRearGlass() {
	const geo = new PlaneGeometry(1.02, .58, 8, 6);
	geo.rotateX(.76);
	geo.translate(0, 1.02, -.96);
	const pos = geo.getAttribute("position");
	for (let i = 0; i < pos.count; i++) {
		let x = pos.getX(i);
		const y = pos.getY(i);
		const top = MathUtils.clamp((y - .8) / .4, 0, 1);
		x *= lerp(1, .76, top);
		pos.setX(i, x);
	}
	geo.computeVertexNormals();
	return geo;
}
/** Side glass in door-hinge local space. Parent with the door. */
function makeSideGlass(sign, length = .52, height = .46) {
	const geo = new PlaneGeometry(length, height, 8, 4);
	geo.rotateY(sign * Math.PI * .5);
	const pos = geo.getAttribute("position");
	for (let i = 0; i < pos.count; i++) {
		const z = pos.getZ(i);
		let y = pos.getY(i);
		if (z > length * .22) y += (z - length * .22) * -.12;
		pos.setY(i, y);
	}
	geo.computeVertexNormals();
	return geo;
}
/** Rear quarter / B-to-C glass on the body skin (car local). */
function makeRearSideGlass(sign) {
	const geo = makeSideGlass(sign, .76, .48);
	geo.translate(sign * .82, 1.06, -.42);
	return geo;
}
function makeMirror(sign) {
	const g = new Group();
	const arm = new Mesh(new BoxGeometry(.12, .04, .05), new MeshStandardMaterial({
		color: 2763826,
		roughness: .5,
		metalness: .4
	}));
	arm.position.set(sign * .08, 0, 0);
	const cap = new Mesh(new BoxGeometry(.1, .08, .16), new MeshStandardMaterial({
		color: 1842722,
		roughness: .35,
		metalness: .55
	}));
	cap.position.set(sign * .16, .01, 0);
	const glass = new Mesh(new PlaneGeometry(.08, .06), new MeshStandardMaterial({
		color: 10135732,
		roughness: .08,
		metalness: .7
	}));
	glass.position.set(sign * .212, .01, 0);
	glass.rotation.y = sign * Math.PI * .5;
	g.add(arm, cap, glass);
	return g;
}
function makeInterior() {
	const g = new Group();
	const dark = new MeshStandardMaterial({
		color: 1316380,
		roughness: .94,
		metalness: .04
	});
	const vinyl = new MeshStandardMaterial({
		color: 1711652,
		roughness: .9,
		metalness: .05
	});
	const seat = new MeshStandardMaterial({
		color: 1843752,
		roughness: .88,
		metalness: .06
	});
	const floor = new Mesh(new BoxGeometry(.84, .04, 1.28), dark);
	floor.position.set(0, .34, .02);
	const dash = new Mesh(new BoxGeometry(.82, .2, .24), dark);
	dash.position.set(0, .6, .48);
	const liner = new Mesh(new BoxGeometry(.78, .02, 1.05), vinyl);
	liner.position.set(0, 1.08, .02);
	const bulk = new Mesh(new BoxGeometry(.8, .55, .04), vinyl);
	bulk.position.set(0, .62, -.62);
	const wheel = new Mesh(new TorusGeometry(.11, .016, 8, 16), new MeshStandardMaterial({
		color: 2763826,
		roughness: .55,
		metalness: .2
	}));
	wheel.position.set(-.22, .68, .36);
	wheel.rotation.x = .55;
	const mkSeat = (x, z) => {
		const s = new Group();
		const base = new Mesh(new BoxGeometry(.3, .08, .36), seat);
		base.position.set(0, .4, 0);
		const back = new Mesh(new BoxGeometry(.3, .32, .07), seat);
		back.position.set(0, .58, -.16);
		back.rotation.x = -.12;
		s.add(base, back);
		s.position.set(x, 0, z);
		return s;
	};
	const mkWall = (sign) => {
		const w = new Mesh(new BoxGeometry(.03, .5, 1.1), vinyl);
		w.position.set(sign * .4, .62, .02);
		return w;
	};
	g.add(floor, dash, liner, bulk, wheel, mkSeat(-.2, .06), mkSeat(.2, .06), mkWall(-1), mkWall(1));
	return g;
}
function makeWheel() {
	const g = new Group();
	const tire = new Mesh(new CylinderGeometry(.32, .32, .22, 28, 1), new MeshStandardMaterial({
		color: 1184276,
		roughness: .92,
		metalness: .05
	}));
	tire.rotation.z = Math.PI / 2;
	tire.castShadow = true;
	const rim = new Mesh(new CylinderGeometry(.2, .22, .24, 18, 1), new MeshStandardMaterial({
		color: 13225428,
		roughness: .28,
		metalness: .92
	}));
	rim.rotation.z = Math.PI / 2;
	const hub = new Mesh(new CylinderGeometry(.07, .07, .26, 12), new MeshStandardMaterial({
		color: 9080986,
		roughness: .35,
		metalness: .8
	}));
	hub.rotation.z = Math.PI / 2;
	g.add(tire, rim, hub);
	return g;
}
var _paintMap = null;
var _roughMap = null;
var _crackMap = null;
function makePaintMaps() {
	if (_paintMap && _roughMap) return {
		map: _paintMap,
		roughness: _roughMap
	};
	const w = 1024;
	const h = 512;
	const paint = document.createElement("canvas");
	paint.width = w;
	paint.height = h;
	const ctx = paint.getContext("2d");
	ctx.fillStyle = "#f2f2f0";
	ctx.fillRect(0, 0, w, h);
	for (let i = 0; i < 14e3; i++) {
		const n = Math.random();
		ctx.fillStyle = `rgba(20,20,22,${n * .045})`;
		ctx.fillRect(Math.random() * w, Math.random() * h, n > .85 ? 2 : 1, 1);
	}
	ctx.strokeStyle = "rgba(18,18,20,0.28)";
	ctx.lineWidth = 2;
	const seams = [
		.18,
		.34,
		.5,
		.66,
		.82
	];
	for (const u of seams) {
		ctx.beginPath();
		ctx.moveTo(u * w, 0);
		ctx.lineTo(u * w, h);
		ctx.stroke();
	}
	ctx.strokeStyle = "rgba(18,18,20,0.22)";
	ctx.beginPath();
	ctx.moveTo(0, h * .38);
	ctx.lineTo(w, h * .38);
	ctx.stroke();
	ctx.fillStyle = "rgba(12,12,14,0.12)";
	ctx.fillRect(0, h * .78, w, h * .22);
	const rough = document.createElement("canvas");
	rough.width = w;
	rough.height = h;
	const rctx = rough.getContext("2d");
	rctx.fillStyle = "#8a8a8a";
	rctx.fillRect(0, 0, w, h);
	rctx.strokeStyle = "#d0d0d0";
	rctx.lineWidth = 3;
	for (const u of seams) {
		rctx.beginPath();
		rctx.moveTo(u * w, 0);
		rctx.lineTo(u * w, h);
		rctx.stroke();
	}
	rctx.fillStyle = "#9a9a9a";
	rctx.fillRect(0, h * .78, w, h * .22);
	_paintMap = new CanvasTexture(paint);
	_paintMap.colorSpace = SRGBColorSpace;
	_paintMap.anisotropy = 8;
	_paintMap.wrapS = _paintMap.wrapT = RepeatWrapping;
	_roughMap = new CanvasTexture(rough);
	_roughMap.colorSpace = "";
	_roughMap.anisotropy = 4;
	_roughMap.wrapS = _roughMap.wrapT = RepeatWrapping;
	return {
		map: _paintMap,
		roughness: _roughMap
	};
}
function makePaintMaterial(color) {
	const maps = typeof document === "undefined" ? {
		map: null,
		roughness: null
	} : makePaintMaps();
	return new MeshPhysicalMaterial({
		color,
		map: maps.map ?? void 0,
		roughnessMap: maps.roughness ?? void 0,
		metalness: .2,
		roughness: .42,
		clearcoat: .72,
		clearcoatRoughness: .24,
		envMapIntensity: .4,
		side: 0
	});
}
function makeTrimMaterial(color) {
	return new MeshStandardMaterial({
		color,
		metalness: .55,
		roughness: .38
	});
}
function makeGlassMaterial() {
	return new MeshPhysicalMaterial({
		color: 1714226,
		metalness: .12,
		roughness: .08,
		transparent: true,
		opacity: .78,
		transmission: .08,
		thickness: .03,
		envMapIntensity: 1.1,
		side: 2,
		depthWrite: true
	});
}
function getCrackMap() {
	if (_crackMap) return _crackMap;
	if (typeof document === "undefined") {
		const t = new DataTexture(new Uint8Array([
			180,
			200,
			210,
			48
		]), 1, 1);
		t.needsUpdate = true;
		_crackMap = t;
		return t;
	}
	const c = document.createElement("canvas");
	c.width = 512;
	c.height = 512;
	const ctx = c.getContext("2d");
	ctx.clearRect(0, 0, 512, 512);
	ctx.fillStyle = "rgba(180,200,210,0.18)";
	ctx.fillRect(0, 0, 512, 512);
	ctx.strokeStyle = "rgba(12,14,18,0.82)";
	ctx.lineWidth = 1.4;
	const cx = 256;
	const cy = 256;
	for (let i = 0; i < 18; i++) {
		const ang = i / 18 * Math.PI * 2 + Math.random() * .2;
		ctx.beginPath();
		ctx.moveTo(cx, cy);
		let x = cx;
		let y = cy;
		const steps = 4 + Math.floor(Math.random() * 4);
		for (let s = 0; s < steps; s++) {
			x += Math.cos(ang + (Math.random() - .5) * .8) * (40 + Math.random() * 50);
			y += Math.sin(ang + (Math.random() - .5) * .8) * (40 + Math.random() * 50);
			ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
	ctx.lineWidth = .8;
	for (let i = 0; i < 22; i++) {
		ctx.beginPath();
		ctx.moveTo(Math.random() * 512, Math.random() * 512);
		ctx.lineTo(Math.random() * 512, Math.random() * 512);
		ctx.stroke();
	}
	_crackMap = new CanvasTexture(c);
	_crackMap.colorSpace = SRGBColorSpace;
	return _crackMap;
}
function makeGrille() {
	const geo = new BoxGeometry(.72, .16, .06, 4, 2, 1);
	const mat = new MeshStandardMaterial({
		color: 1711136,
		roughness: .55,
		metalness: .45
	});
	return new Mesh(geo, mat);
}
var DeformableCar = class {
	group = new Group();
	body;
	deform;
	paint;
	wheels = [];
	headLights = [];
	velocity = new Vector3();
	angular = new Vector3();
	forward = new Vector3(0, 0, 1);
	right = new Vector3(1, 0, 0);
	fwdFlat = new Vector3(0, 0, 1);
	rightFlat = new Vector3(1, 0, 0);
	speed = 0;
	crashed = false;
	yaw = 0;
	roll = 0;
	pitch = 0;
	spawnSpeed = 0;
	world;
	onGlass;
	bodyMat;
	wheelSpin = 0;
	glassPanes = [];
	parts = [];
	lamps = [];
	hullHelper = null;
	bumperF;
	bumperR;
	hood;
	trunk;
	doorL;
	doorR;
	doorMeshL;
	doorMeshR;
	hoodRest;
	trunkRest;
	doorLRest;
	doorRRest;
	hoodOrigin;
	trunkOrigin;
	interior;
	mirrorL;
	mirrorR;
	constructor(paint, world, onGlass = null) {
		this.paint = paint;
		this.world = world;
		this.onGlass = onGlass;
		this.group.name = paint.name;
		this.bodyMat = makePaintMaterial(paint.body);
		const bodyGeo = makeChassisGeometry();
		this.body = new Mesh(bodyGeo, this.bodyMat);
		this.body.castShadow = true;
		this.body.receiveShadow = true;
		this.group.add(this.body);
		this.deform = new StreamedDeformation(bodyGeo);
		this.deform.createHelper(this.group);
		this.interior = makeInterior();
		this.group.add(this.interior);
		this.hood = new Mesh(makeHoodGeometry(), this.bodyMat);
		this.hood.castShadow = true;
		this.hood.position.set(0, .7, .74);
		this.group.add(this.hood);
		this.trunk = new Mesh(makeTrunkGeometry(), this.bodyMat);
		this.trunk.castShadow = true;
		this.trunk.position.set(0, .74, -.72);
		this.group.add(this.trunk);
		this.doorL = new Group();
		this.doorR = new Group();
		this.doorL.position.set(-.86, .54, .55);
		this.doorR.position.set(.86, .54, .55);
		this.doorMeshL = new Mesh(makeDoorGeometry(-1), this.bodyMat);
		this.doorMeshL.position.set(0, 0, -.28);
		this.doorMeshL.castShadow = true;
		this.doorMeshR = new Mesh(makeDoorGeometry(1), this.bodyMat);
		this.doorMeshR.position.set(0, 0, -.28);
		this.doorMeshR.castShadow = true;
		this.doorL.add(this.doorMeshL);
		this.doorR.add(this.doorMeshR);
		const innerMat = new MeshStandardMaterial({
			color: 1711652,
			roughness: .9,
			metalness: .04
		});
		const innerL = new Mesh(new BoxGeometry(.018, .5, .52), innerMat);
		innerL.position.set(.024, 0, -.28);
		const innerR = new Mesh(new BoxGeometry(.018, .5, .52), innerMat);
		innerR.position.set(-.024, 0, -.28);
		this.doorL.add(innerL);
		this.doorR.add(innerR);
		this.group.add(this.doorL, this.doorR);
		this.hoodRest = this.copyRest(this.hood.geometry);
		this.trunkRest = this.copyRest(this.trunk.geometry);
		this.doorLRest = this.copyRest(this.doorMeshL.geometry);
		this.doorRRest = this.copyRest(this.doorMeshR.geometry);
		this.hoodOrigin = this.hood.position.clone();
		this.trunkOrigin = this.trunk.position.clone();
		this.bumperF = this.makeBumper(true, paint);
		this.bumperR = this.makeBumper(false, paint);
		this.group.add(this.bumperF, this.bumperR);
		this.mirrorL = makeMirror(-1);
		this.mirrorL.position.set(-.06, .32, 0);
		this.doorL.add(this.mirrorL);
		this.mirrorR = makeMirror(1);
		this.mirrorR.position.set(.06, .32, 0);
		this.doorR.add(this.mirrorR);
		this.addGlass();
		this.registerParts();
		this.buildHullHelper();
		for (const [x, y, z] of WHEEL_POS) {
			const w = makeWheel();
			w.position.set(x, y, z);
			this.group.add(w);
			this.wheels.push(w);
		}
		this.group.castShadow = true;
	}
	copyRest(geo) {
		const pos = geo.getAttribute("position");
		return new Float32Array(pos.array);
	}
	restoreRest(geo, rest) {
		const pos = geo.getAttribute("position");
		pos.array.set(rest);
		pos.needsUpdate = true;
		geo.computeVertexNormals();
	}
	makeBumper(front, paint) {
		const g = new Group();
		const mesh = new Mesh(makeBumperGeometry(front), makeTrimMaterial(paint.accent));
		mesh.castShadow = true;
		g.add(mesh);
		if (front) for (const sx of [-.52, .52]) {
			const mat = new MeshStandardMaterial({
				color: 16052712,
				emissive: 16052712,
				emissiveIntensity: 1.15,
				roughness: .2
			});
			const f = new Mesh(new BoxGeometry(.22, .09, .05), mat);
			f.position.set(sx, .15, .04);
			g.add(f);
			const spot = new SpotLight(16774102, 5.2, 24, .4, .48, 1.35);
			spot.position.set(sx, .16, .02);
			spot.target.position.set(sx * .28, -.12, 6);
			g.add(spot, spot.target);
			this.headLights.push(spot);
			this.lamps.push({
				mesh: f,
				light: spot,
				mat,
				intact: true,
				kind: "head",
				side: sx < 0 ? -1 : 1,
				sensors: sx < 0 ? [1, 4] : [2, 5],
				parts: sx < 0 ? ["wingFL"] : ["wingFR"]
			});
		}
		else {
			for (const sx of [-.52, .52]) {
				const mat = new MeshStandardMaterial({
					color: 12849692,
					emissive: 14684184,
					emissiveIntensity: 2.6,
					roughness: .32
				});
				const r = new Mesh(new BoxGeometry(.26, .08, .04), mat);
				r.position.set(sx, .15, -.04);
				g.add(r);
				const glow = new PointLight(16718356, 2.8, 6.5, 2);
				glow.position.set(sx, .16, -.18);
				g.add(glow);
				this.lamps.push({
					mesh: r,
					light: glow,
					mat,
					intact: true,
					kind: "tail",
					side: sx < 0 ? -1 : 1,
					sensors: sx < 0 ? [16, 10] : [17, 11],
					parts: sx < 0 ? ["wingRL"] : ["wingRR"]
				});
			}
			const plate = new Mesh(new BoxGeometry(.36, .11, .02), new MeshStandardMaterial({
				color: 14210252,
				roughness: .6,
				metalness: .1
			}));
			plate.position.set(0, .03, -.08);
			g.add(plate);
		}
		g.position.set(0, .33, front ? 2.06 : -2.06);
		if (front) {
			const grille = makeGrille();
			grille.position.set(0, .1, .06);
			g.add(grille);
		}
		return g;
	}
	addGlass() {
		const addPane = (mesh, parent, parts, skin = null) => {
			mesh.renderOrder = 2;
			parent.add(mesh);
			this.glassPanes.push({
				mesh,
				mat: mesh.material,
				restPos: mesh.position.clone(),
				restVerts: skin ? this.copyRest(mesh.geometry) : null,
				state: "intact",
				parts,
				skin
			});
		};
		addPane(new Mesh(makeWindshield(), makeGlassMaterial()), this.group, ["roof", "bonnet"], "glassFront");
		addPane(new Mesh(makeRearGlass(), makeGlassMaterial()), this.group, ["roof", "boot"], "glassRear");
		const sideL = new Mesh(makeSideGlass(-1), makeGlassMaterial());
		sideL.position.set(.02, .52, -.28);
		addPane(sideL, this.doorL, ["doorLeft", "roof"]);
		const sideR = new Mesh(makeSideGlass(1), makeGlassMaterial());
		sideR.position.set(-.02, .52, -.28);
		addPane(sideR, this.doorR, ["doorRight", "roof"]);
		addPane(new Mesh(makeRearSideGlass(-1), makeGlassMaterial()), this.group, ["roof", "doorLeft"]);
		addPane(new Mesh(makeRearSideGlass(1), makeGlassMaterial()), this.group, ["roof", "doorRight"]);
	}
	registerParts() {
		const add = (name, object, cage, attachL, attachR, hinge, radius) => {
			this.parts.push({
				name,
				object,
				restPos: object.position.clone(),
				restQuat: object.quaternion.clone(),
				cage,
				attachL,
				attachR,
				hinge,
				detached: false,
				folding: false,
				hingeT: 0,
				velocity: new Vector3(),
				angular: new Vector3(),
				radius
			});
		};
		add("bumperF", this.bumperF, "bumperFront", 1, 2, "two-point", .42);
		add("bumperR", this.bumperR, "bumperRear", 16, 17, "two-point", .4);
		add("hood", this.hood, "bonnet", 3, 3, "cowl", .5);
		add("trunk", this.trunk, "boot", 18, 18, "tail", .48);
		add("doorL", this.doorL, "doorLeft", 6, 6, "door", .4);
		add("doorR", this.doorR, "doorRight", 7, 7, "door", .4);
		add("mirrorL", this.mirrorL, "doorLeft", 6, 4, "two-point", .1);
		add("mirrorR", this.mirrorR, "doorRight", 7, 5, "two-point", .1);
	}
	buildHullHelper() {
		const pos = [];
		for (const h of HULLS) {
			const y0 = .18;
			const y1 = .72;
			const x0 = h.cx - h.hx;
			const x1 = h.cx + h.hx;
			const z0 = h.cz - h.hz;
			const z1 = h.cz + h.hz;
			const c = [
				[
					x0,
					y0,
					z0
				],
				[
					x1,
					y0,
					z0
				],
				[
					x1,
					y0,
					z1
				],
				[
					x0,
					y0,
					z1
				],
				[
					x0,
					y1,
					z0
				],
				[
					x1,
					y1,
					z0
				],
				[
					x1,
					y1,
					z1
				],
				[
					x0,
					y1,
					z1
				]
			];
			for (const [a, b] of [
				[0, 1],
				[1, 2],
				[2, 3],
				[3, 0],
				[4, 5],
				[5, 6],
				[6, 7],
				[7, 4],
				[0, 4],
				[1, 5],
				[2, 6],
				[3, 7]
			]) pos.push(...c[a], ...c[b]);
		}
		const geo = new BufferGeometry();
		geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
		const mat = new LineBasicMaterial({
			color: 9085108,
			transparent: true,
			opacity: .7,
			depthTest: false
		});
		this.hullHelper = new LineSegments(geo, mat);
		this.hullHelper.renderOrder = 4;
		this.hullHelper.visible = false;
		this.group.add(this.hullHelper);
	}
	updateHullHelper() {
		if (!this.hullHelper) return;
		const attr = this.hullHelper.geometry.getAttribute("position");
		const arr = attr.array;
		let o = 0;
		for (const h of this.hulls()) {
			const y0 = .18;
			const y1 = .72;
			const x0 = h.cx - h.hx;
			const x1 = h.cx + h.hx;
			const z0 = h.cz - h.hz;
			const z1 = h.cz + h.hz;
			const c = [
				[
					x0,
					y0,
					z0
				],
				[
					x1,
					y0,
					z0
				],
				[
					x1,
					y0,
					z1
				],
				[
					x0,
					y0,
					z1
				],
				[
					x0,
					y1,
					z0
				],
				[
					x1,
					y1,
					z0
				],
				[
					x1,
					y1,
					z1
				],
				[
					x0,
					y1,
					z1
				]
			];
			for (const [a, b] of [
				[0, 1],
				[1, 2],
				[2, 3],
				[3, 0],
				[4, 5],
				[5, 6],
				[6, 7],
				[7, 4],
				[0, 4],
				[1, 5],
				[2, 6],
				[3, 7]
			]) {
				const pa = c[a];
				const pb = c[b];
				arr[o++] = pa[0];
				arr[o++] = pa[1];
				arr[o++] = pa[2];
				arr[o++] = pb[0];
				arr[o++] = pb[1];
				arr[o++] = pb[2];
			}
		}
		attr.needsUpdate = true;
	}
	hulls() {
		if (!this.deform.massActive) return HULLS;
		const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
		const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
		return this.deform.liveHulls(frontOff, rearOff);
	}
	crushHulls() {
		if (!this.deform.massActive) return CRUSH_HULLS;
		const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
		const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
		return this.deform.liveCrushHulls(frontOff, rearOff);
	}
	spawn(x, z, speed) {
		this.resetVisual();
		this.group.position.set(x, 0, z);
		this.group.lookAt(0, 0, 0);
		this.refreshBasis();
		this.yaw = Math.atan2(this.forward.x, this.forward.z);
		this.group.rotation.set(0, this.yaw, 0, "YXZ");
		this.roll = 0;
		this.pitch = 0;
		this.speed = speed;
		this.spawnSpeed = speed;
		this.crashed = false;
		this.angular.set(0, 0, 0);
		this.refreshBasis();
		this.velocity.copy(this.forward).multiplyScalar(speed);
		this.deform.bindKinematic(this.group, this.velocity, this.angular);
		this.resetLamps();
	}
	resetVisual() {
		this.deform.reset();
		this.deform.restoreRest(this.body.geometry);
		this.restoreRest(this.hood.geometry, this.hoodRest);
		this.restoreRest(this.trunk.geometry, this.trunkRest);
		this.restoreRest(this.doorMeshL.geometry, this.doorLRest);
		this.restoreRest(this.doorMeshR.geometry, this.doorRRest);
		this.wheelSpin = 0;
		for (let i = 0; i < this.wheels.length; i++) {
			const w = this.wheels[i];
			const rest = WHEEL_POS[i];
			w.position.set(rest[0], rest[1], rest[2]);
			w.rotation.set(0, 0, 0);
			w.visible = true;
		}
		this.bodyMat.roughness = .42;
		this.group.rotation.set(0, 0, 0);
		this.interior.scale.set(1, 1, 1);
		this.interior.position.set(0, 0, 0);
		for (const p of this.parts) {
			if (p.detached) {
				this.world.remove(p.object);
				if (p.name === "mirrorL") this.doorL.add(p.object);
				else if (p.name === "mirrorR") this.doorR.add(p.object);
				else this.group.add(p.object);
			}
			p.detached = false;
			p.folding = false;
			p.hingeT = 0;
			p.object.position.copy(p.restPos);
			p.object.quaternion.copy(p.restQuat);
			p.object.rotation.set(0, 0, 0);
			p.object.scale.set(1, 1, 1);
			p.object.visible = true;
			p.velocity.set(0, 0, 0);
			p.angular.set(0, 0, 0);
		}
		for (const g of this.glassPanes) {
			g.state = "intact";
			g.mesh.visible = true;
			g.mesh.position.copy(g.restPos);
			if (g.restVerts) this.restoreRest(g.mesh.geometry, g.restVerts);
			g.mat.opacity = .78;
			g.mat.map = null;
			g.mat.roughness = .06;
			g.mat.needsUpdate = true;
		}
		this.resetLamps();
	}
	resetLamps() {
		for (const lamp of this.lamps) {
			lamp.intact = true;
			if (lamp.kind === "head") {
				lamp.mat.color.setHex(16052712);
				lamp.mat.emissive.setHex(16052712);
				lamp.mat.emissiveIntensity = 1.15;
				lamp.light.intensity = 5.2;
			} else {
				lamp.mat.color.setHex(12849692);
				lamp.mat.emissive.setHex(14684184);
				lamp.mat.emissiveIntensity = 2.6;
				lamp.light.intensity = 2.8;
			}
			lamp.mat.needsUpdate = true;
		}
	}
	refreshBasis() {
		this.group.updateMatrixWorld();
		this.forward.set(0, 0, 1).applyQuaternion(this.group.quaternion);
		this.right.set(1, 0, 0).applyQuaternion(this.group.quaternion);
		const fl = Math.hypot(this.forward.x, this.forward.z);
		if (fl > 1e-6) this.fwdFlat.set(this.forward.x / fl, 0, this.forward.z / fl);
		else this.fwdFlat.set(0, 0, 1);
		this.rightFlat.set(this.fwdFlat.z, 0, -this.fwdFlat.x);
	}
	worldToLocalPoint(world, out) {
		return this.group.worldToLocal(out.copy(world));
	}
	worldToLocalDir(world, out) {
		this.group.updateMatrixWorld();
		const inv = _inv.copy(this.group.quaternion).invert();
		return out.copy(world).applyQuaternion(inv).normalize();
	}
	applyImpact(worldPoint, worldInward, impulse) {
		this.crashed = true;
		const localP = this.worldToLocalPoint(worldPoint, _p$1);
		_in.copy(worldInward);
		_in.y = 0;
		_v$1.copy(this.group.position).sub(worldPoint);
		_v$1.y = 0;
		if (_v$1.lengthSq() > 1e-8) {
			_v$1.normalize();
			if (_in.dot(_v$1) < 0) _in.negate();
		}
		const localN = this.worldToLocalDir(_in, _n$1);
		this.deform.beginCrush(localP, localN, impulse, this.group, this.velocity, this.angular);
		this.deform.impulseAt(worldPoint, _in, impulse);
		this.bodyMat.roughness = Math.min(.82, .42 + impulse * .012);
	}
	syncPose(dt) {
		this.deform.followGroup(this.group, this.velocity, this.angular, dt);
		this.yaw = this.group.rotation.y;
		this.roll = this.group.rotation.z;
		this.pitch = this.group.rotation.x;
		this.refreshBasis();
	}
	afterContacts(dt, bounce) {
		if (!this.deform.massActive) return;
		this.nudgeWheels(dt);
		this.stepLooseParts(dt, bounce);
	}
	snapshot() {
		return {
			name: this.paint.name,
			crashed: this.crashed,
			pos: {
				x: round4(this.group.position.x),
				y: round4(this.group.position.y),
				z: round4(this.group.position.z)
			},
			vel: {
				x: round4(this.velocity.x),
				y: round4(this.velocity.y),
				z: round4(this.velocity.z)
			},
			speed: round4(this.velocity.length()),
			angular: {
				x: round4(this.angular.x),
				y: round4(this.angular.y),
				z: round4(this.angular.z)
			},
			yaw: round4(this.yaw),
			pitch: round4(this.pitch),
			roll: round4(this.roll),
			spawnSpeed: round4(this.spawnSpeed),
			deform: this.deform.snapshot(),
			parts: this.parts.map((p) => ({
				name: p.name,
				detached: p.detached,
				folding: p.folding,
				hingeT: round4(p.hingeT),
				pos: {
					x: round4(p.object.position.x),
					y: round4(p.object.position.y),
					z: round4(p.object.position.z)
				},
				vel: {
					x: round4(p.velocity.x),
					y: round4(p.velocity.y),
					z: round4(p.velocity.z)
				}
			})),
			lamps: this.lamps.map((l) => ({
				kind: l.kind,
				side: l.side,
				intact: l.intact,
				on: l.intact && l.light.intensity > .05
			})),
			glass: this.glassPanes.map((g) => g.state)
		};
	}
	step(dt) {
		this.integrate(dt);
		this.updateDeform(dt);
	}
	integrate(dt) {
		if (this.deform.massActive) {
			this.syncPose(dt);
			this.nudgeWheels(dt);
			this.stepLooseParts(dt);
			return;
		}
		if (!this.crashed) {
			this.velocity.y -= 9.6 * dt;
			this.group.position.addScaledVector(this.velocity, dt);
			this.wheelSpin += this.speed / .32 * dt;
			for (const w of this.wheels) w.rotation.x = this.wheelSpin;
			this.deform.bindKinematic(this.group, this.velocity, this.angular);
		} else {
			this.velocity.y -= 9.6 * dt;
			this.velocity.x *= Math.pow(.28, dt);
			this.velocity.z *= Math.pow(.28, dt);
			this.angular.multiplyScalar(Math.pow(.45, dt));
			this.group.position.addScaledVector(this.velocity, dt);
			this.yaw += this.angular.y * dt;
			this.roll = MathUtils.damp(this.roll, this.angular.z * .15, 4, dt);
			this.pitch = MathUtils.damp(this.pitch, this.angular.x * .12, 4, dt);
			this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
			const v = this.velocity.length();
			this.wheelSpin += v / .32 * dt;
			for (const w of this.wheels) w.rotation.x = this.wheelSpin;
		}
		if (this.group.position.y < 0) {
			this.group.position.y = 0;
			if (this.velocity.y < 0) this.velocity.y = 0;
		}
		this.refreshBasis();
		this.stepLooseParts(dt);
	}
	updateDeform(dt) {
		this.deform.update(dt, this.body.geometry);
		if (this.crashed) {
			const detached = (name) => this.parts.some((p) => p.name === name && p.detached);
			if (!detached("hood")) this.deform.skinPanel(this.hood.geometry, this.hoodRest, "bonnet", this.hoodOrigin);
			if (!detached("trunk")) this.deform.skinPanel(this.trunk.geometry, this.trunkRest, "boot", this.trunkOrigin);
			const origin = _zero;
			for (const g of this.glassPanes) {
				if (!g.skin || !g.restVerts || g.state === "shattered") continue;
				this.deform.skinPanel(g.mesh.geometry, g.restVerts, g.skin, origin);
			}
			this.syncAttachedParts(dt);
			this.followGlass();
			this.evaluateBreakage(this.deform.impulseValue, dt);
		}
		this.fitInterior();
		if (this.hullHelper?.visible) this.updateHullHelper();
	}
	nudgeWheels(dt) {
		const v = this.velocity.length();
		if (!this.deform.drivetrainAlive) {
			this.wheelSpin *= Math.pow(.45, dt);
			this.wheelSpin += v / .32 * dt * .2;
		} else {
			const drive = this.crashed && this.deform.crushElapsed > .05 ? .35 : 1;
			this.wheelSpin += v / .32 * dt * drive;
		}
		const hubs = [
			"hubFL",
			"hubFR",
			"hubRL",
			"hubRR"
		];
		for (let i = 0; i < this.wheels.length; i++) {
			const w = this.wheels[i];
			const rest = WHEEL_POS[i];
			w.rotation.x = this.wheelSpin;
			if (!this.deform.massActive) {
				w.position.set(rest[0], rest[1], rest[2]);
				continue;
			}
			const hub = this.deform.massLocal(hubs[i]);
			if (!this.deform.hubPopped(hubs[i])) {
				w.position.set(rest[0], MathUtils.clamp(hub.y, .16, .55), rest[2]);
				w.visible = true;
				continue;
			}
			w.position.set(hub.x, MathUtils.clamp(hub.y, .04, 1.4), hub.z);
			w.visible = true;
		}
	}
	setRigVisible(v) {
		this.deform.setHelperVisible(v);
		if (this.hullHelper) this.hullHelper.visible = v;
		if (v) this.updateHullHelper();
	}
	dispose() {
		this.deform.disposeHelper();
		for (const p of this.parts) p.object.removeFromParent();
		this.group.traverse((obj) => {
			if (obj instanceof Mesh) {
				obj.geometry.dispose();
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const m of mats) m.dispose();
			}
			if (obj instanceof Light) obj.dispose();
		});
	}
	syncAttachedParts(dt) {
		const ix = this.deform.impactInward.x;
		const iz = this.deform.impactInward.z;
		for (const p of this.parts) {
			if (p.detached) continue;
			const left = this.deform.sensorCompression(p.attachL);
			const right = this.deform.sensorCompression(p.attachR);
			const crush = Math.max(left, right, this.deform.partCompression(p.cage));
			const local = Math.min(left, right);
			const along = -(p.restPos.x * ix + p.restPos.z * iz);
			const onHit = this.deform.bidirectional ? Math.abs(p.restPos.z) > .8 || Math.abs(p.restPos.x) > .5 : p.hinge === "door" ? Math.abs(p.restPos.x * ix) > .18 || crush > .16 || local > .12 : along > .12;
			let target = 0;
			if (onHit) {
				if (p.hinge === "two-point") target = MathUtils.clamp((crush - .04) / .55, 0, 1);
				else if (p.hinge === "cowl") target = MathUtils.clamp((crush - .1) / .6, 0, 1);
				else if (p.hinge === "tail") target = MathUtils.clamp((crush - .1) / .6, 0, 1);
				else if (p.hinge === "door") target = MathUtils.clamp((Math.max(local, crush) - .08) / .5, 0, 1);
			}
			p.hingeT = Math.max(p.hingeT, Math.min(target, p.hingeT + Math.max(dt * 3.2, .012)));
			const t = p.hingeT;
			p.object.position.copy(p.restPos);
			p.object.quaternion.copy(p.restQuat);
			p.object.scale.set(1, 1, 1);
			if (p.hinge === "two-point") {
				if (p.name.startsWith("bumper")) {
					p.folding = t > .04;
					const fl = this.deform.massLocal(p.name === "bumperF" ? "bumperFL" : "bumperRL");
					const fr = this.deform.massLocal(p.name === "bumperF" ? "bumperFR" : "bumperRR");
					p.object.position.set((fl.x + fr.x) * .5, (fl.y + fr.y) * .5, (fl.z + fr.z) * .5);
					const span = Math.abs(fl.z - (p.name === "bumperF" ? 2.06 : -2.06));
					p.object.scale.set(1 + t * .04, Math.max(.45, 1 - t * .28), Math.max(.18, 1 - span * .45));
				} else {
					p.folding = t > .08;
					const side = p.name === "mirrorL" ? -1 : 1;
					p.object.rotation.z += side * t * 1.4;
					p.object.position.y -= t * .12;
					p.object.position.x += side * t * .18;
				}
			} else if (p.hinge === "cowl") {
				p.folding = t > .06;
				p.object.position.z -= t * .08;
				p.object.position.y += t * .26;
				p.object.rotation.x = -t * .5;
			} else if (p.hinge === "tail") {
				p.folding = t > .06;
				p.object.position.z += t * .08;
				p.object.position.y += t * .22;
				p.object.rotation.x = t * .5;
			} else if (p.hinge === "door") {
				p.folding = t > .08;
				const sign = p.name === "doorL" ? -1 : 1;
				p.object.rotation.y = -sign * t * 1.45;
				p.object.position.x += sign * t * .06;
				p.object.updateWorldMatrix(true, false);
				_box.setFromObject(p.object);
				if (_box.min.y < .04) p.object.position.y += .04 - _box.min.y;
			}
		}
	}
	fitInterior() {
		if (!this.deform.massActive) {
			this.interior.scale.set(1, 1, 1);
			this.interior.position.set(0, 0, 0);
			return;
		}
		const l = this.deform.massLocal("doorL");
		const r = this.deform.massLocal("doorR");
		const cell = this.deform.massLocal("cell");
		const span = Math.max(.35, r.x - l.x);
		this.interior.scale.x = MathUtils.clamp(span / 1.56, .32, 1);
		this.interior.position.x = (l.x + r.x) * .5;
		this.interior.position.z = cell.z * .35;
		this.interior.position.y = MathUtils.clamp(cell.y - .55, -.08, .1);
	}
	followGlass() {
		const inward = this.deform.impactInward;
		for (const g of this.glassPanes) {
			if (g.state === "shattered" || g.skin) continue;
			if (g.parts.includes("doorLeft") || g.parts.includes("doorRight")) continue;
			let nearby = 0;
			for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
			g.mesh.position.copy(g.restPos);
			if (nearby < .02) continue;
			g.mesh.position.x += inward.x * nearby * .32;
			g.mesh.position.y += inward.y * nearby * .12 - nearby * .08;
			g.mesh.position.z += inward.z * nearby * .32;
		}
	}
	evaluateBreakage(impulse, _dt) {
		const ix = this.deform.impactInward.x;
		const iz = this.deform.impactInward.z;
		for (const g of this.glassPanes) {
			if (g.state === "shattered") continue;
			let nearby = 0;
			for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
			if (g.state === "intact" && nearby > .45 && this.deform.crushElapsed > .12) {
				g.state = "cracked";
				g.mat.map = getCrackMap();
				g.mat.opacity = .55;
				g.mat.roughness = .32;
				g.mat.needsUpdate = true;
			}
			if (nearby > .7 && this.deform.crushElapsed > .2 || nearby > .55 && impulse > 40 && this.deform.crushElapsed > .16) this.shatterGlass(g);
		}
		for (const p of this.parts) {
			if (p.detached) continue;
			if (this.deform.bidirectional && p.hinge !== "door" && p.hinge !== "two-point") continue;
			const along = -(p.restPos.x * ix + p.restPos.z * iz);
			const crush = Math.max(this.deform.sensorCompression(p.attachL), this.deform.sensorCompression(p.attachR), this.deform.partCompression(p.cage));
			if (!(p.hinge === "door" ? Math.abs(p.restPos.x * ix) > .18 || crush > .16 : along > .12)) continue;
			let should = false;
			if (p.name.startsWith("mirror") && p.hingeT > .5) should = true;
			if (p.name === "bumperF" && p.hingeT > .7) should = true;
			if (p.name === "bumperR" && p.hingeT > .7) should = true;
			if (p.hinge === "cowl" && p.hingeT > .78) should = true;
			if (p.hinge === "tail" && p.hingeT > .78) should = true;
			if ((p.name === "doorL" || p.name === "doorR") && p.hingeT > .58) should = true;
			if (should) this.detachPart(p, impulse);
		}
		for (const lamp of this.lamps) {
			if (!lamp.intact) continue;
			let crush = 0;
			for (const s of lamp.sensors) crush = Math.max(crush, this.deform.sensorCompression(s));
			for (const part of lamp.parts) crush = Math.max(crush, this.deform.partCompression(part));
			if (crush > .18 && this.deform.crushElapsed > .02) this.breakLamp(lamp);
		}
	}
	breakLamp(lamp) {
		lamp.intact = false;
		lamp.mat.color.setHex(3816512);
		lamp.mat.emissive.setHex(1710876);
		lamp.mat.emissiveIntensity = .12;
		lamp.mat.needsUpdate = true;
		lamp.light.intensity = 0;
	}
	detachPart(p, impulse) {
		if (p.detached) return;
		p.detached = true;
		this.group.updateMatrixWorld();
		const wpos = new Vector3();
		const wquat = new Quaternion();
		p.object.getWorldPosition(wpos);
		p.object.getWorldQuaternion(wquat);
		this.group.remove(p.object);
		this.world.add(p.object);
		p.object.position.copy(wpos);
		p.object.quaternion.copy(wquat);
		_p$1.copy(wpos).sub(this.group.position).setY(0);
		if (_p$1.lengthSq() < 1e-6) _p$1.set(p.restPos.x, 0, p.restPos.z).applyQuaternion(this.group.quaternion);
		_p$1.normalize();
		p.velocity.copy(this.velocity);
		p.velocity.addScaledVector(_p$1, 2.2 + Math.min(5, impulse * .06));
		p.velocity.y += 2.1 + p.hingeT * 1.2;
		p.angular.set((Math.random() - .5) * 6, (Math.random() - .5) * 5, (Math.random() - .5) * 6);
		if (p.hinge === "door") p.angular.y += (p.name === "doorL" ? -1 : 1) * (3.2 + p.hingeT * 2.4);
		else if (p.hinge === "cowl") p.angular.x -= 3.4;
		else if (p.hinge === "tail") p.angular.x += 3.4;
		p.object.position.addScaledVector(_p$1, .14);
		p.object.position.y += .08;
	}
	shatterGlass(g) {
		g.state = "shattered";
		g.mesh.visible = false;
		this.group.updateMatrixWorld();
		const origin = new Vector3();
		g.mesh.getWorldPosition(origin);
		origin.y += .12;
		_p$1.copy(origin).sub(this.group.position);
		const vel = new Vector3(this.velocity.x - this.angular.y * _p$1.z, this.velocity.y + 1.5 + Math.abs(this.angular.x) * 2, this.velocity.z + this.angular.y * _p$1.x);
		this.onGlass?.(origin, vel, 56);
	}
	stepLooseParts(dt, bounce) {
		for (const p of this.parts) {
			if (!p.detached) continue;
			p.velocity.y -= 9.6 * dt;
			p.object.position.addScaledVector(p.velocity, dt);
			const spin = p.angular.length();
			if (spin > 1e-5) {
				_n$1.copy(p.angular).multiplyScalar(1 / spin);
				_qSpin.setFromAxisAngle(_n$1, spin * dt);
				p.object.quaternion.premultiply(_qSpin);
			}
			p.angular.multiplyScalar(Math.pow(.72, dt));
			bounce?.(p.object.position, p.velocity, Math.min(.22, p.radius * .45));
			if (p.object.position.y < .12) {
				p.object.position.y = .12;
				if (p.velocity.y < 0) p.velocity.y *= -.28;
				p.velocity.x *= .96;
				p.velocity.z *= .96;
				p.angular.multiplyScalar(.9);
			}
		}
	}
};
var _qSpin = new Quaternion();
var _p$1 = new Vector3();
var _n$1 = new Vector3();
var _v$1 = new Vector3();
var _in = new Vector3();
var _inv = new Quaternion();
var _zero = new Vector3();
var _box = new Box3();
/**
* Hydraulic car-compactor: two kinematic plates, equal and opposite, square
* to the car's length. Faces start just past the bumpers, close to the wheel
* wells, then past the hub midpoint into the cage.
*
* Hub rest |z| = 1.34, bumper |z| = 2.06.
*/
var COMPACTOR = {
	bumperZ: 2.06,
	hubZ: 1.34,
	/** Just beyond the visible bumper. */
	startFace: 2.22,
	/** Plates at the wheel-well lip (hub + tyre). */
	wellFace: 1.5,
	/** Hub centre-line — "wheel midpoint". */
	midFace: 1.34,
	/** Past the rails (0.68) into the passenger cell. */
	maxFace: .62,
	/** m/s each plate travels inward. */
	speed: .55
};
function compactorStage(face) {
	if (face >= COMPACTOR.startFace - .02) return "open";
	if (face > COMPACTOR.wellFace) return "contact";
	if (face > COMPACTOR.midFace) return "wells";
	if (face > COMPACTOR.maxFace + .02) return "mid";
	return "max";
}
/** Project any mass that crossed a plate back onto it and kill outbound speed. */
function enforceWalls(d, zFace, dt = 1 / 60) {
	let frontJ = 0;
	let rearJ = 0;
	let hits = 0;
	const face = Math.abs(zFace);
	const invDt = 1 / Math.max(dt, 1 / 240);
	for (const m of d.masses) {
		if (!m.dynamic) continue;
		const r = m.radius * .72;
		if (m.world.z + r > face) {
			const overlap = m.world.z + r - face;
			m.world.z -= overlap;
			const vn = m.vel.z;
			if (vn > 0) m.vel.z = 0;
			frontJ += m.mass * (Math.max(0, vn) + overlap * invDt);
			hits++;
		}
		if (m.world.z - r < -face) {
			const overlap = -face - (m.world.z - r);
			m.world.z += overlap;
			const vn = m.vel.z;
			if (vn < 0) m.vel.z = 0;
			rearJ += m.mass * (Math.max(0, -vn) + overlap * invDt);
			hits++;
		}
	}
	return {
		frontJ,
		rearJ,
		hits
	};
}
var BARRIER_HALF = {
	x: .38,
	z: 1.96
};
var BARRIER_MASS = 14e3;
var _ha$1 = new Vector3();
var _hb$1 = new Vector3();
var _mtv$1 = new Vector3();
var _bRight$1 = new Vector3();
var _bFwd$1 = new Vector3();
function hullCenter(car, h, out) {
	const p = car.group.position;
	out.set(p.x + car.rightFlat.x * h.cx + car.fwdFlat.x * h.cz, 0, p.z + car.rightFlat.z * h.cx + car.fwdFlat.z * h.cz);
}
/** Max displacement per physics slice so a 30 m/s car cannot skip a 0.76 m wall. */
function physicsSlice(dt, vmax) {
	const cap = .07 / Math.max(vmax, 4);
	return Math.min(dt, Math.max(1 / 240, cap));
}
function satCarBarrier(car, yaw, origin, hx, normalOut, contactOut, hulls = car.hulls()) {
	const pa = car.group.position;
	if ((pa.x - origin.x) ** 2 + (pa.z - origin.z) ** 2 > 64) return null;
	car.refreshBasis();
	_bRight$1.set(Math.cos(yaw), 0, -Math.sin(yaw));
	_bFwd$1.set(Math.sin(yaw), 0, Math.cos(yaw));
	let best = 0;
	let bestScore = 0;
	let found = false;
	for (const h of hulls) {
		hullCenter(car, h, _ha$1);
		const rx = _ha$1.x - origin.x;
		const rz = _ha$1.z - origin.z;
		const lx = rx * _bRight$1.x + rz * _bRight$1.z;
		const lz = rx * _bFwd$1.x + rz * _bFwd$1.z;
		const rX = Math.abs(car.rightFlat.x * _bRight$1.x + car.rightFlat.z * _bRight$1.z) * h.hx + Math.abs(car.fwdFlat.x * _bRight$1.x + car.fwdFlat.z * _bRight$1.z) * h.hz;
		const rZ = Math.abs(car.rightFlat.x * _bFwd$1.x + car.rightFlat.z * _bFwd$1.z) * h.hx + Math.abs(car.fwdFlat.x * _bFwd$1.x + car.fwdFlat.z * _bFwd$1.z) * h.hz;
		const overlapX = hx + rX - Math.abs(lx);
		const overlapZ = BARRIER_HALF.z + rZ - Math.abs(lz);
		if (overlapX <= 0 || overlapZ <= 0) continue;
		const overlap = Math.min(overlapX, overlapZ);
		const score = overlapX * 2 + overlapZ * .15;
		if (!found || score > bestScore) {
			found = true;
			best = overlap;
			bestScore = score;
			const qx = MathUtils.clamp(lx, -hx, hx);
			const qz = MathUtils.clamp(lz, -BARRIER_HALF.z, BARRIER_HALF.z);
			contactOut.set(origin.x + _bRight$1.x * qx + _bFwd$1.x * qz, .36, origin.z + _bRight$1.z * qx + _bFwd$1.z * qz);
			if (overlapZ < overlapX) normalOut.copy(_bFwd$1).multiplyScalar(lz >= 0 ? 1 : -1);
			else normalOut.copy(_bRight$1).multiplyScalar(lx >= 0 ? 1 : -1);
		}
	}
	return found ? best : null;
}
/** Keep the cabin from crossing the jersey face. leftover=1 → bumper still on the face. */
function clipCarToBarrier(car, yaw, origin, hx, leftover) {
	car.refreshBasis();
	_bRight$1.set(Math.cos(yaw), 0, -Math.sin(yaw));
	_bFwd$1.set(Math.sin(yaw), 0, Math.cos(yaw));
	const px = car.group.position.x - origin.x;
	const pz = car.group.position.z - origin.z;
	const lx = px * _bRight$1.x + pz * _bRight$1.z;
	const lz = px * _bFwd$1.x + pz * _bFwd$1.z;
	const alongFwd = Math.abs(car.fwdFlat.x * _bRight$1.x + car.fwdFlat.z * _bRight$1.z) * 2.05;
	const bumperKeep = hx + .22 + alongFwd * .85;
	const cabinKeep = hx + 1.08;
	const minLx = MathUtils.lerp(cabinKeep, bumperKeep, leftover);
	if (Math.abs(lz) > BARRIER_HALF.z + 1.1) return false;
	const side = lx >= 0 ? 1 : -1;
	if (lx * side >= minLx) return false;
	const extra = minLx - lx * side;
	const push = Math.min(extra, .16);
	car.group.position.x += _bRight$1.x * side * push;
	car.group.position.z += _bRight$1.z * side * push;
	car.group.updateMatrixWorld();
	car.refreshBasis();
	const vn = car.velocity.x * _bRight$1.x * side + car.velocity.z * _bRight$1.z * side;
	if (car.deform.massActive) {
		car.deform.separateAlong(_bRight$1.x * side, 0, _bRight$1.z * side, push);
		if (vn < 0) car.deform.kickCore(_bRight$1.x * side, 0, _bRight$1.z * side, -vn);
	}
	if (vn < 0) {
		car.velocity.x -= _bRight$1.x * side * vn;
		car.velocity.z -= _bRight$1.z * side * vn;
	}
	return true;
}
function satTwoHulls(a, ha, b, hb) {
	hullCenter(a, ha, _ha$1);
	hullCenter(b, hb, _hb$1);
	const axes = [
		a.rightFlat,
		a.fwdFlat,
		b.rightFlat,
		b.fwdFlat
	];
	let minOverlap = Infinity;
	_mtv$1.set(0, 0, 0);
	for (const axis of axes) {
		const ax = axis.x;
		const az = axis.z;
		const len = Math.hypot(ax, az);
		if (len < 1e-6) continue;
		const nx = ax / len;
		const nz = az / len;
		const ca = _ha$1.x * nx + _ha$1.z * nz;
		const ra = Math.abs(a.rightFlat.x * nx + a.rightFlat.z * nz) * ha.hx + Math.abs(a.fwdFlat.x * nx + a.fwdFlat.z * nz) * ha.hz;
		const cb = _hb$1.x * nx + _hb$1.z * nz;
		const rb = Math.abs(b.rightFlat.x * nx + b.rightFlat.z * nz) * hb.hx + Math.abs(b.fwdFlat.x * nx + b.fwdFlat.z * nz) * hb.hz;
		const overlap = Math.min(ca + ra, cb + rb) - Math.max(ca - ra, cb - rb);
		if (overlap <= 0) return null;
		if (overlap < minOverlap) {
			minOverlap = overlap;
			_mtv$1.set(nx, 0, nz);
		}
	}
	if ((_ha$1.x - _hb$1.x) * _mtv$1.x + (_ha$1.z - _hb$1.z) * _mtv$1.z < 0) _mtv$1.negate();
	return minOverlap;
}
function satCars(a, b, normalOut, contactOut, hullsOf = (c) => c.hulls()) {
	const pa = a.group.position;
	const pb = b.group.position;
	const dx = pb.x - pa.x;
	const dz = pb.z - pa.z;
	if (dx * dx + dz * dz > 36) return null;
	a.refreshBasis();
	b.refreshBasis();
	let best = 0;
	let found = false;
	for (const ha of hullsOf(a)) for (const hb of hullsOf(b)) {
		const hit = satTwoHulls(a, ha, b, hb);
		if (hit && hit > best) {
			found = true;
			best = hit;
			normalOut.copy(_mtv$1);
			hullCenter(a, ha, _ha$1);
			hullCenter(b, hb, _hb$1);
			contactOut.set((_ha$1.x + _hb$1.x) * .5, .36, (_ha$1.z + _hb$1.z) * .5);
		}
	}
	return found ? best : null;
}
var FLEET_PAINT = [
	{
		body: 12961998,
		accent: 10133672,
		name: "Titanium"
	},
	{
		body: 4033158,
		accent: 2777952,
		name: "Petrol"
	},
	{
		body: 9127232,
		accent: 6041131,
		name: "Oxide"
	},
	{
		body: 4017530,
		accent: 2765912,
		name: "Ink"
	},
	{
		body: 7035454,
		accent: 4865580,
		name: "Bronze"
	},
	{
		body: 4873292,
		accent: 3358776,
		name: "Moss"
	},
	{
		body: 9072716,
		accent: 6048306,
		name: "Sand"
	},
	{
		body: 5917282,
		accent: 3945284,
		name: "Slate"
	},
	{
		body: 8027782,
		accent: 5132888,
		name: "Ash"
	},
	{
		body: 3095106,
		accent: 1844264,
		name: "Coal"
	},
	{
		body: 10127978,
		accent: 6970952,
		name: "Khaki"
	},
	{
		body: 4876914,
		accent: 3295312,
		name: "Teal"
	}
];
var MAX_CARS = 24;
var FIXED = 1 / 60;
var IMPACT_SCALE = .032;
var PRE_IMPACT_LEAD = .07;
var BALL_EXPOSE = .25;
var _v = new Vector3();
var _w = new Vector3();
var _n = new Vector3();
var _r = new Vector3();
var _p = new Vector3();
var _bn = new Vector3();
var _bp = new Vector3();
var _bRight = new Vector3();
var _bFwd = new Vector3();
var _ha = new Vector3();
var _hb = new Vector3();
var _mtv = new Vector3();
var _cn = new Vector3();
var _cp = new Vector3();
var CrashEngine = class {
	playing = true;
	looping = true;
	showRig = false;
	showBarrier = false;
	showBalls = false;
	showCompactor = false;
	autoRotate = true;
	autoSlomo = true;
	audioOn = false;
	deformMode = "shape";
	canvas;
	renderer;
	scene = new Scene();
	camera;
	cars = [];
	carCount = 2;
	get carA() {
		return this.cars[0];
	}
	get carB() {
		return this.cars[1] ?? this.cars[0];
	}
	disposed = false;
	acc = 0;
	last = 0;
	phase = "approach";
	timeScale = 1;
	targetScale = 1;
	wallSinceImpact = 0;
	impactKph = null;
	trauma = 0;
	orbitAngle = 0;
	orbitRadius = 14;
	orbitPitch = .4;
	orbitDragging = false;
	orbitLastX = 0;
	orbitLastY = 0;
	userFramed = false;
	elapsedWall = 0;
	elapsedSim = 0;
	camPos = new Vector3(10, 6, 16);
	camLook = new Vector3();
	camFrom = new Vector3();
	camBlend = 1;
	reduceMotion = false;
	impactLight;
	impactLightLife = 0;
	debris;
	sparks;
	glassDots;
	smoke;
	audio;
	hudAcc = 0;
	resizeObs;
	approachSide = new Vector3(1, 0, 0);
	ring;
	barrier;
	barrierYaw = 0;
	barrierVel = new Vector3();
	barrierCrush = 0;
	barrierHits = [];
	fxPoofed = false;
	squash = .4;
	buckle = .45;
	fxDensity = .7;
	speedMin = 0;
	speedMax = 32;
	balls = [];
	poles = [];
	ballHits = [];
	smokeUntil = [];
	compactFace = COMPACTOR.startFace;
	compactFxAt = 0;
	press;
	pressFront;
	pressRear;
	traceInitial = null;
	traceSamples = [];
	traceAcc = 0;
	constructor(canvas) {
		this.canvas = canvas;
		this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		this.renderer = new WebGLRenderer({
			canvas,
			antialias: true,
			alpha: false,
			powerPreference: "high-performance"
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setClearColor(1184794, 1);
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = 4;
		this.renderer.toneMappingExposure = 1.55;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = 1;
		this.camera = new PerspectiveCamera(50, 1, .1, 180);
		this.camera.position.copy(this.camPos);
		this.scene.background = new Color(1184794);
		this.scene.fog = new FogExp2(1184794, .008);
		this.scene.environmentIntensity = .4;
		const pmrem = new PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), .06).texture;
		pmrem.dispose();
		this.buildWorld();
		this.barrier = makeJerseyBarrier();
		this.barrier.visible = false;
		this.scene.add(this.barrier);
		this.buildPress();
		this.glassDots = new GlassDotSystem(this.scene);
		this.ensureCars(2);
		this.debris = new DebrisSystem(this.scene);
		this.sparks = new SparkSystem(this.scene);
		this.smoke = new TireSmokeSystem(this.scene);
		this.audio = new CrashAudio();
		this.impactLight = new PointLight(16761466, 0, 22, 2);
		this.scene.add(this.impactLight);
		this.resize();
		this.resizeObs = new ResizeObserver(() => this.resize());
		this.resizeObs.observe(canvas.parentElement ?? canvas);
		window.addEventListener("keydown", this.onKey);
		this.canvas.style.touchAction = "none";
		this.canvas.style.cursor = "grab";
		this.canvas.addEventListener("pointerdown", this.onPointerDown);
		this.canvas.addEventListener("pointermove", this.onPointerMove);
		this.canvas.addEventListener("pointerup", this.onPointerUp);
		this.canvas.addEventListener("pointercancel", this.onPointerUp);
		this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
		try {
			this.randomizeAndReset();
		} catch (err) {
			console.error("randomizeAndReset failed", err);
			throw err;
		}
		window.__crush = this;
		this.emitHud(true);
		this.renderer.render(this.scene, this.camera);
	}
	start() {
		this.last = performance.now();
		this.renderer.setAnimationLoop(this.tick);
	}
	dispose() {
		this.disposed = true;
		this.renderer.setAnimationLoop(null);
		window.removeEventListener("keydown", this.onKey);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointercancel", this.onPointerUp);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.resizeObs.disconnect();
		for (const car of this.cars) car.dispose();
		this.sparks.dispose();
		this.glassDots.dispose();
		this.smoke.dispose();
		this.audio.dispose();
		this.scene.clear();
		const gl = this.renderer.getContext();
		this.renderer.dispose();
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
	togglePlay() {
		this.playing = !this.playing;
		this.tryUnlockAudio();
		this.emitHud(true);
	}
	toggleLoop() {
		this.looping = !this.looping;
		this.emitHud(true);
	}
	toggleRig() {
		this.showRig = !this.showRig;
		for (const car of this.live()) car.setRigVisible(this.showRig);
		this.emitHud(true);
	}
	toggleOrbit() {
		this.autoRotate = !this.autoRotate;
		this.emitHud(true);
	}
	toggleSlomo() {
		this.autoSlomo = !this.autoSlomo;
		if (!this.autoSlomo) {
			this.timeScale = 1;
			this.targetScale = 1;
		}
		this.emitHud(true);
	}
	toggleAudio() {
		this.audioOn = !this.audioOn;
		this.tryUnlockAudio();
		this.emitHud(true);
	}
	toggleDeformMode() {
		this.deformMode = this.deformMode === "shape" ? "lattice" : "shape";
		for (const car of this.live()) car.deform.setMode(this.deformMode);
		this.tryUnlockAudio();
		this.randomizeAndReset();
		this.emitHud(true);
	}
	tryUnlockAudio() {
		if (this.audioOn) this.audio.unlock();
	}
	toggleBarrier() {
		if (this.showCompactor) return;
		this.showBarrier = !this.showBarrier;
		this.barrier.visible = this.showBarrier;
		if (this.showBarrier) this.orientBarrier();
		this.tryUnlockAudio();
		this.emitHud(true);
	}
	toggleBalls() {
		if (this.showCompactor) return;
		this.showBalls = !this.showBalls;
		this.scatterBalls();
		this.tryUnlockAudio();
		this.emitHud(true);
	}
	toggleCompactor() {
		this.showCompactor = !this.showCompactor;
		this.tryUnlockAudio();
		this.randomizeAndReset();
		this.emitHud(true);
	}
	setSquash(value) {
		this.squash = MathUtils.clamp(value, 0, 1);
		for (const car of this.live()) car.deform.squash = this.squash;
		this.emitHud(true);
	}
	setBuckle(value) {
		this.buckle = MathUtils.clamp(value, 0, 1);
		for (const car of this.live()) car.deform.buckle = this.buckle;
		this.emitHud(true);
	}
	setFxDensity(value) {
		this.fxDensity = MathUtils.clamp(value, 0, 1.2);
		this.emitHud(true);
	}
	setCarCount(n) {
		this.ensureCars(n);
		this.tryUnlockAudio();
		this.randomizeAndReset();
		this.emitHud(true);
	}
	setSpeedRange(min, max) {
		const a = Number.isFinite(min) ? MathUtils.clamp(min, 0, 48) : 0;
		const b = Number.isFinite(max) ? MathUtils.clamp(max, 0, 48) : 32;
		this.speedMin = Math.min(a, b);
		this.speedMax = Math.max(a, b);
		this.emitHud(true);
	}
	copyTraceJson() {
		return JSON.stringify({
			version: 1,
			capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
			squash: this.squash,
			buckle: this.buckle,
			deformMode: this.deformMode,
			fxDensity: this.fxDensity,
			barrier: this.showBarrier,
			balls: this.showBalls,
			compactor: this.showCompactor,
			carCount: this.carCount,
			speedMin: this.speedMin,
			speedMax: this.speedMax,
			barrierYaw: this.barrierYaw,
			sampleHz: 4,
			initial: this.traceInitial,
			ballHits: this.ballHits,
			samples: this.traceSamples
		}, null, 2);
	}
	reset() {
		this.tryUnlockAudio();
		this.randomizeAndReset();
		this.emitHud(true);
	}
	live() {
		return this.cars.slice(0, this.carCount);
	}
	centroid(out, cars = this.live()) {
		out.set(0, 0, 0);
		const n = cars.length;
		if (n === 0) return out;
		for (const car of cars) out.add(car.group.position);
		return out.multiplyScalar(1 / n);
	}
	ensureCars(n) {
		const count = MathUtils.clamp(Math.round(n) || 1, 1, MAX_CARS);
		this.carCount = count;
		while (this.cars.length < count) {
			const i = this.cars.length;
			const base = FLEET_PAINT[i % FLEET_PAINT.length];
			const car = new DeformableCar(i < FLEET_PAINT.length ? base : {
				...base,
				name: `${base.name}-${Math.floor(i / FLEET_PAINT.length) + 1}`
			}, this.scene, (origin, vel, count) => this.glassDots.burst(origin, vel, count));
			car.group.visible = false;
			this.scene.add(car.group);
			this.cars.push(car);
		}
		for (let i = 0; i < this.cars.length; i++) this.cars[i].group.visible = i < count;
		this.barrierHits = Array.from({ length: count }, () => false);
		while (this.smokeUntil.length < count) this.smokeUntil.push(0);
		this.smokeUntil.length = count;
	}
	dressCar(car) {
		car.deform.squash = this.squash;
		car.deform.buckle = this.buckle;
		car.deform.setMode(this.deformMode);
		car.setRigVisible(this.showRig);
	}
	onKey = (e) => {
		const tag = e.target?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;
		if (e.code === "Space") {
			e.preventDefault();
			this.togglePlay();
		} else if (e.code === "KeyR") {
			e.preventDefault();
			this.reset();
		} else if (e.code === "KeyL") this.toggleLoop();
		else if (e.code === "KeyG") this.toggleRig();
		else if (e.code === "KeyB") this.toggleBarrier();
		else if (e.code === "KeyK") this.toggleBalls();
		else if (e.code === "KeyC") this.toggleCompactor();
		else if (e.code === "KeyO") this.toggleOrbit();
		else if (e.code === "KeyM") this.toggleSlomo();
		else if (e.code === "KeyU") this.toggleAudio();
		else if (e.code === "KeyY") this.toggleDeformMode();
	};
	onPointerDown = (e) => {
		if (e.button !== 0) return;
		this.orbitDragging = true;
		this.orbitLastX = e.clientX;
		this.orbitLastY = e.clientY;
		this.userFramed = true;
		this.canvas.setPointerCapture(e.pointerId);
		this.canvas.style.cursor = "grabbing";
	};
	onPointerMove = (e) => {
		if (!this.orbitDragging) return;
		const dx = e.clientX - this.orbitLastX;
		const dy = e.clientY - this.orbitLastY;
		this.orbitLastX = e.clientX;
		this.orbitLastY = e.clientY;
		this.orbitAngle -= dx * .005;
		this.orbitPitch = MathUtils.clamp(this.orbitPitch + dy * .004, .08, 1.22);
	};
	onPointerUp = (e) => {
		if (!this.orbitDragging) return;
		this.orbitDragging = false;
		this.canvas.style.cursor = "grab";
		try {
			this.canvas.releasePointerCapture(e.pointerId);
		} catch {}
	};
	onWheel = (e) => {
		e.preventDefault();
		const delta = e.deltaY;
		const scale = Math.exp(delta * .00115);
		this.orbitRadius = MathUtils.clamp(this.orbitRadius * scale, 4.2, 32);
		this.userFramed = true;
	};
	randomizeAndReset() {
		this.compactFace = COMPACTOR.startFace;
		this.compactFxAt = 0;
		if (this.showCompactor) {
			this.parkCompactor();
			this.finishResetCommon();
			return;
		}
		if (this.press) this.press.visible = false;
		this.spawnFleet();
		this.barrierHits.fill(false);
		this.barrier.visible = this.showBarrier;
		if (this.showBarrier) this.orientBarrier();
		this.scatterBalls();
		this.resetPoles();
		this.finishResetCommon();
	}
	spawnFleet() {
		const cars = this.live();
		const minSep = 5.4;
		const padR = 7 + Math.min(16, cars.length * 1.1);
		for (let i = 0; i < cars.length; i++) {
			let x = 0;
			let z = 0;
			let placed = false;
			for (let attempt = 0; attempt < 48; attempt++) {
				const ang = Math.random() * Math.PI * 2;
				const r = 6.4 + Math.random() * padR;
				x = Math.sin(ang) * r;
				z = Math.cos(ang) * r;
				placed = true;
				for (let j = 0; j < i; j++) {
					const o = cars[j];
					if (Math.hypot(x - o.group.position.x, z - o.group.position.z) < minSep) {
						placed = false;
						break;
					}
				}
				if (placed) break;
			}
			if (!placed) {
				const ang = i / Math.max(1, cars.length) * Math.PI * 2;
				const r = Math.max(8.2, minSep * cars.length / (Math.PI * 1.7));
				x = Math.sin(ang) * r;
				z = Math.cos(ang) * r;
			}
			const span = this.speedMax - this.speedMin;
			const spd = this.speedMin + (span <= 0 ? 0 : Math.random() * span);
			const car = cars[i];
			car.group.visible = true;
			car.spawn(x, z, spd);
			this.dressCar(car);
		}
		for (let i = this.carCount; i < this.cars.length; i++) {
			const extra = this.cars[i];
			extra.group.visible = false;
			extra.group.position.set(80 + i * 6, 0, 80);
			extra.velocity.set(0, 0, 0);
		}
	}
	parkCompactor() {
		this.ensureCars(Math.max(this.carCount, 1));
		const parked = this.carA;
		parked.resetVisual();
		parked.group.visible = true;
		parked.yaw = 0;
		parked.pitch = 0;
		parked.roll = 0;
		parked.group.position.set(0, 0, 0);
		parked.group.rotation.set(0, 0, 0, "YXZ");
		parked.group.quaternion.identity();
		parked.velocity.set(0, 0, 0);
		parked.angular.set(0, 0, 0);
		parked.crashed = false;
		parked.speed = 0;
		parked.spawnSpeed = 0;
		parked.refreshBasis();
		this.dressCar(parked);
		parked.deform.bidirectional = true;
		parked.deform.deepCrush = false;
		parked.deform.bindKinematic(parked.group, parked.velocity, parked.angular);
		for (let i = 1; i < this.cars.length; i++) {
			const extra = this.cars[i];
			extra.resetVisual();
			extra.group.visible = false;
			extra.group.position.set(48 + i * 4, 0, 48);
			extra.velocity.set(0, 0, 0);
		}
		this.barrier.visible = false;
		this.barrierHits.fill(false);
		for (const b of this.balls) b.mesh.visible = false;
		this.press.visible = true;
		this.syncPress();
	}
	finishResetCommon() {
		this.phase = "approach";
		this.timeScale = 1;
		this.targetScale = 1;
		this.wallSinceImpact = 0;
		this.elapsedWall = 0;
		this.elapsedSim = 0;
		this.userFramed = false;
		this.impactKph = null;
		this.trauma = 0;
		this.camBlend = 1;
		this.impactLightLife = 0;
		this.impactLight.intensity = 0;
		this.debris.reset();
		this.sparks.reset();
		this.glassDots.reset();
		this.smoke.reset();
		if (this.showCompactor) {
			this.camLook.set(0, .55, 0);
			this.orbitRadius = 9.4;
			this.orbitPitch = .44;
			this.orbitAngle = .85;
			const cp = Math.cos(this.orbitPitch);
			this.camPos.set(Math.sin(this.orbitAngle) * this.orbitRadius * cp, this.camLook.y + this.orbitRadius * Math.sin(this.orbitPitch), Math.cos(this.orbitAngle) * this.orbitRadius * cp);
		} else {
			const cars = this.live();
			this.centroid(_v, cars);
			if (cars.length >= 2) _w.copy(cars[1].group.position).sub(cars[0].group.position).normalize();
			else _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
			this.approachSide.crossVectors(_w, _n.set(0, 1, 0)).normalize();
			if (this.approachSide.lengthSq() < .1) this.approachSide.set(1, 0, 0);
			this.placeApproachCamera(1);
		}
		this.camera.position.copy(this.camPos);
		this.camera.lookAt(this.camLook);
		this.orbitAngle = Math.atan2(this.camPos.x - this.camLook.x, this.camPos.z - this.camLook.z);
		const dx = this.camPos.x - this.camLook.x;
		const dy = this.camPos.y - this.camLook.y;
		const dz = this.camPos.z - this.camLook.z;
		this.orbitRadius = Math.hypot(dx, dy, dz);
		this.orbitPitch = Math.asin(MathUtils.clamp(dy / Math.max(this.orbitRadius, .01), -.99, .99));
		this.smokeUntil.fill(0);
		this.fxPoofed = false;
		this.barrierVel.set(0, 0, 0);
		this.barrierCrush = 0;
		this.barrier.position.set(0, 0, 0);
		restoreBarrierRest(this.barrier);
		this.beginTrace();
	}
	beginTrace() {
		this.traceAcc = 0;
		this.traceSamples = [];
		this.ballHits = [];
		this.traceInitial = {
			barrier: this.showBarrier,
			barrierYaw: this.barrierYaw,
			squash: this.squash,
			buckle: this.buckle,
			fxDensity: this.fxDensity,
			balls: this.showBalls,
			compactor: this.showCompactor,
			compactFace: this.compactFace,
			carCount: this.carCount,
			speedMin: this.speedMin,
			speedMax: this.speedMax,
			cars: this.live().map((car) => ({
				paint: car.paint.name,
				spawn: {
					x: car.group.position.x,
					y: car.group.position.y,
					z: car.group.position.z
				},
				yaw: car.yaw,
				speed: car.spawnSpeed,
				vel: {
					x: car.velocity.x,
					y: car.velocity.y,
					z: car.velocity.z
				}
			}))
		};
		this.pushTraceSample();
	}
	pushTraceSample() {
		if (this.traceSamples.length >= 96) return;
		this.traceSamples.push({
			t: Math.round(this.elapsedWall * 1e3) / 1e3,
			sim: Math.round(this.elapsedSim * 1e3) / 1e3,
			phase: this.phase,
			timeScale: Math.round(this.timeScale * 1e3) / 1e3,
			squash: this.squash,
			buckle: this.buckle,
			fxDensity: this.fxDensity,
			compactFace: round4(this.compactFace),
			compactStage: compactorStage(this.compactFace),
			closing: Math.round(this.fleetClosing() * 3.6 * 10) / 10,
			collision: {
				leftover: this.live().map((c) => round4(leftoverCrumple(c.deform.crumpleTravelCorner()))),
				transfer: this.live().map((c) => round4(c.deform.frontTransfer())),
				dist: round4(this.nearestPairDist()),
				barrierHit: this.barrierHits.some(Boolean),
				barrierCrush: round4(this.barrierCrush)
			},
			ballHits: this.ballHits,
			barrier: {
				pos: vec3(this.barrier.position),
				vel: vec3(this.barrierVel),
				yaw: round4(this.barrierYaw),
				crush: round4(this.barrierCrush),
				mass: BARRIER_MASS
			},
			balls: this.balls.map((b) => ({
				intact: b.intact,
				radius: round4(b.radius),
				expose: BALL_EXPOSE,
				kicked: [...b.kicked],
				pos: vec3(b.mesh.position)
			})),
			particles: {
				sparks: this.sparks.snapshot(),
				smoke: this.smoke.snapshot(),
				debris: this.debris.snapshot()
			},
			cars: this.live().map((c) => c.snapshot())
		});
	}
	fleetClosing() {
		if (this.showCompactor) return COMPACTOR.speed * 2;
		const cars = this.live();
		if (cars.length < 2) return cars[0]?.velocity.length() ?? 0;
		let best = 0;
		for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
			const d = cars[i].velocity.distanceTo(cars[j].velocity);
			if (d > best) best = d;
		}
		return best;
	}
	nearestPairDist() {
		const cars = this.live();
		if (cars.length < 2) return 0;
		let best = Infinity;
		for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
			const d = cars[i].group.position.distanceTo(cars[j].group.position);
			if (d < best) best = d;
		}
		return best;
	}
	orientBarrier() {
		const a = this.carA.group.position;
		const len = Math.hypot(a.x, a.z);
		if (len < .01) this.barrierYaw = 0;
		else {
			const nx = a.x / len;
			const nz = a.z / len;
			this.barrierYaw = Math.atan2(-nz, nx);
		}
		this.barrier.rotation.y = this.barrierYaw;
	}
	placeApproachCamera(alpha) {
		const cars = this.live();
		const mid = this.centroid(_v, cars);
		mid.y = .6;
		if (cars.length >= 2) _w.copy(cars[1].group.position).sub(cars[0].group.position);
		else _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
		const dist = Math.max(_w.length(), 4);
		if (_w.lengthSq() > 1e-8) _w.normalize();
		else _w.set(0, 0, 1);
		const side = this.approachSide;
		const pull = MathUtils.lerp(16, 11, MathUtils.clamp(1 - dist / 28, 0, 1)) + Math.max(0, cars.length - 2) * .55;
		this.camPos.copy(mid).addScaledVector(side, pull).addScaledVector(_n.set(0, 1, 0), 5.2).addScaledVector(_w, -1.4);
		this.camLook.copy(mid);
	}
	tick = (now) => {
		if (this.disposed) return;
		try {
			this.tickInner(now);
		} catch (err) {
			console.error("Crush Stream tick failed", err);
			this.renderer.render(this.scene, this.camera);
		}
	};
	tickInner(now) {
		if (this.disposed) return;
		const wallDt = Math.min((now - this.last) / 1e3, .1);
		this.last = now;
		if (this.playing) {
			this.elapsedWall += wallDt;
			this.maybePreSlowmo(wallDt);
			this.timeScale += (this.targetScale - this.timeScale) * Math.min(1, wallDt * (this.phase === "aftermath" ? 1.15 : 3.2));
			const simDt = wallDt * this.timeScale;
			const cars = this.live();
			let vmax = 8;
			for (const car of cars) if (car.speed > vmax) vmax = car.speed;
			this.acc += simDt;
			if (this.acc > .05) this.acc = .05;
			while (this.acc > 1e-5) {
				const h = physicsSlice(this.acc, vmax);
				this.fixedStep(h);
				this.elapsedSim += h;
				this.acc -= h;
				for (const car of cars) {
					if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
					if (this.wallSinceImpact > .2 && car.crashed) this.bleedAfterSlide(car, h);
				}
			}
			this.updatePhase(wallDt);
			if (this.phase !== "approach") this.emitContactFx();
			if (this.impactLightLife > 0) {
				this.impactLightLife -= wallDt;
				this.impactLight.intensity = Math.max(0, this.impactLightLife * 90);
			}
			this.trauma = Math.max(0, this.trauma - wallDt * 1.6);
			this.stepBarrier(simDt);
			const fxDt = Math.max(simDt, wallDt * .6);
			this.debris.update(fxDt, this.bounceWorld);
			this.sparks.update(fxDt, this.bounceGround);
			this.glassDots.update(fxDt, this.bounceGround);
			this.smoke.update(fxDt, this.bounceGround, this.camera);
			for (let i = 0; i < cars.length; i++) if (this.elapsedWall < (this.smokeUntil[i] ?? 0)) this.puffEngine(cars[i]);
			this.traceAcc += wallDt;
			if (this.traceAcc >= .25) {
				this.traceAcc = 0;
				this.pushTraceSample();
			}
		}
		this.updateCamera(wallDt);
		this.renderer.render(this.scene, this.camera);
		this.hudAcc += wallDt;
		if (this.hudAcc > (this.timeScale < .5 ? .05 : .12)) {
			this.hudAcc = 0;
			this.emitHud(false);
		}
	}
	maybePreSlowmo(wallDt) {
		if (!this.autoSlomo) return;
		if (this.showCompactor) return;
		if (this.phase !== "approach") return;
		const scale = this.reduceMotion ? .16 : IMPACT_SCALE;
		if (this.timeScale <= scale * 1.2) return;
		const eta = this.contactEta();
		if (!Number.isFinite(eta)) return;
		if (eta > Math.max(PRE_IMPACT_LEAD, wallDt + FIXED)) return;
		this.timeScale = scale;
		this.targetScale = scale;
	}
	contactEta() {
		const cars = this.live();
		for (const car of cars) car.refreshBasis();
		let eta = Number.POSITIVE_INFINITY;
		for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
			const a = cars[i];
			const b = cars[j];
			const ax = a.group.position.x;
			const az = a.group.position.z;
			const bx = b.group.position.x;
			const bz = b.group.position.z;
			const dx = bx - ax;
			const dz = bz - az;
			const dist = Math.hypot(dx, dz);
			if (dist <= .001) continue;
			const nx = dx / dist;
			const nz = dz / dist;
			const relVx = b.velocity.x - a.velocity.x;
			const relVz = b.velocity.z - a.velocity.z;
			const closing = -(relVx * nx + relVz * nz);
			if (closing > .35) {
				const halfA = Math.abs(a.right.x * nx + a.right.z * nz) * CAR_HALF.x + Math.abs(a.forward.x * nx + a.forward.z * nz) * CAR_HALF.z;
				const halfB = Math.abs(b.right.x * nx + b.right.z * nz) * CAR_HALF.x + Math.abs(b.forward.x * nx + b.forward.z * nz) * CAR_HALF.z;
				const gap = dist - halfA - halfB;
				eta = Math.min(eta, Math.max(0, gap) / closing);
			}
		}
		if (!this.showBarrier) return eta;
		_bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
		_bFwd.set(Math.sin(this.barrierYaw), 0, Math.cos(this.barrierYaw));
		for (const car of cars) {
			const px = car.group.position.x;
			const pz = car.group.position.z;
			const lx = px * _bRight.x + pz * _bRight.z;
			const lz = px * _bFwd.x + pz * _bFwd.z;
			const rX = Math.abs(car.right.x * _bRight.x + car.right.z * _bRight.z) * CAR_HALF.x + Math.abs(car.forward.x * _bRight.x + car.forward.z * _bRight.z) * CAR_HALF.z;
			const rZ = Math.abs(car.right.x * _bFwd.x + car.right.z * _bFwd.z) * CAR_HALF.x + Math.abs(car.forward.x * _bFwd.x + car.forward.z * _bFwd.z) * CAR_HALF.z;
			const vLx = car.velocity.x * _bRight.x + car.velocity.z * _bRight.z;
			const vLz = car.velocity.x * _bFwd.x + car.velocity.z * _bFwd.z;
			const gapX = Math.abs(lx) - BARRIER_HALF.x - rX;
			const gapZ = Math.abs(lz) - BARRIER_HALF.z - rZ;
			const towardX = -(lx >= 0 ? 1 : -1) * vLx;
			const towardZ = -(lz >= 0 ? 1 : -1) * vLz;
			if (towardX > .4 && gapZ < .55) eta = Math.min(eta, Math.max(0, gapX) / towardX);
			if (towardZ > .4 && gapX < .55) eta = Math.min(eta, Math.max(0, gapZ) / towardZ);
		}
		return eta;
	}
	fixedStep(dt) {
		const cars = this.live();
		let nearWall = false;
		if (this.showBarrier) {
			for (const car of cars) if (car.group.position.lengthSq() < 160) {
				nearWall = true;
				break;
			}
		}
		const slices = nearWall && dt > .006 ? 3 : dt > .012 ? 2 : 1;
		const h = dt / slices;
		let cinematicImpulse = 0;
		let cinematicContact = null;
		let cinematicNormal = null;
		for (let i = 0; i < slices; i++) {
			if (this.showCompactor) {
				this.stepCompactor(h);
				this.carA.afterContacts(h, this.bounceWorld);
				continue;
			}
			for (const car of cars) {
				if (!car.deform.massActive) car.integrate(h);
				if (car.deform.massActive) car.syncPose(h);
				else car.refreshBasis();
			}
			for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
				const ca = cars[a];
				const cb = cars[b];
				if (this.showBarrier && this.barrierBlocksPair(ca, cb)) continue;
				const dx = ca.group.position.x - cb.group.position.x;
				const dz = ca.group.position.z - cb.group.position.z;
				if (dx * dx + dz * dz > 28) continue;
				if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform);
			}
			for (let k = 0; k < 3; k++) {
				for (const car of cars) if (car.deform.massActive) car.syncPose(0);
				else car.refreshBasis();
				const feed = k === 0;
				let moved = false;
				if (this.showBarrier) for (let ci = 0; ci < cars.length; ci++) {
					const car = cars[ci];
					const hit = this.resolveBarrier(car, !car.crashed, feed, h);
					if (hit) {
						this.barrierHits[ci] = true;
						moved = true;
						if (hit.impulse >= cinematicImpulse) {
							cinematicImpulse = hit.impulse;
							cinematicContact = hit.contact;
							cinematicNormal = hit.normal;
						}
					}
				}
				for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
					const pair = this.resolvePair(cars[a], cars[b], !(cars[a].crashed && cars[b].crashed), feed, h);
					if (pair) {
						moved = true;
						if (pair.impulse >= cinematicImpulse) {
							cinematicImpulse = pair.impulse;
							cinematicContact = pair.contact;
							cinematicNormal = pair.normal;
						}
					}
				}
				if (this.showBalls) for (const car of cars) {
					const ballHit = this.resolveBalls(car, h);
					if (ballHit) {
						moved = true;
						if (ballHit.impulse >= cinematicImpulse) {
							cinematicImpulse = ballHit.impulse;
							cinematicContact = ballHit.contact;
							cinematicNormal = ballHit.normal;
						}
					}
				}
				for (const car of cars) if (this.resolvePoles(car, h)) moved = true;
				if (this.showBarrier) {
					for (const car of cars) if (this.resolveBarrier(car, false, false, h)) moved = true;
				}
				if (!moved) break;
			}
			for (const car of cars) {
				if (car.deform.massActive) car.deform.stepStructure(h);
				if (car.deform.massActive) car.syncPose(h);
				if (this.showBarrier) clipCarToBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), leftoverCrumple(car.deform.crumpleTravelCorner()));
				car.afterContacts(h, this.bounceWorld);
			}
		}
		for (const car of cars) {
			if (this.showCompactor && car !== this.carA) continue;
			car.updateDeform(dt);
		}
		if (this.phase === "approach" && cinematicContact && cinematicNormal && cinematicImpulse > .4) this.beginCinematic(cinematicContact, cinematicNormal, cinematicImpulse);
	}
	impulseCar(car, nx, ny, nz, j) {
		if (j === 0) return;
		if (car.deform.massActive) {
			car.deform.applyImpulse(nx, ny, nz, j);
			return;
		}
		const inv = 1 / car.deform.totalMass;
		car.velocity.x += nx * j * inv;
		car.velocity.y += ny * j * inv;
		car.velocity.z += nz * j * inv;
	}
	pushCar(car, nx, ny, nz, amount) {
		if (car.deform.massActive) {
			const sep = Math.min(amount, .09);
			car.deform.separateAlong(nx, ny, nz, sep);
			car.deform.followGroup(car.group, car.velocity, car.angular, 0);
			car.refreshBasis();
			return;
		}
		car.group.position.x += nx * amount;
		car.group.position.y += ny * amount;
		car.group.position.z += nz * amount;
		car.group.updateMatrixWorld();
		car.refreshBasis();
		car.deform.bindKinematic(car.group, car.velocity, car.angular);
	}
	resolveBarrier(car, deform, feed, dt) {
		const crushHit = satCarBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), _cn, _cp, car.crushHulls());
		const overlap = satCarBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), _bn, _bp, car.hulls());
		clipCarToBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), leftoverCrumple(car.deform.crumpleTravelCorner()));
		if (!crushHit && !overlap) return null;
		car.deform.notifyContact();
		const n = crushHit ? _cn : overlap ? _bn : _cn;
		n.y = 0;
		if (n.lengthSq() > 1e-8) n.normalize();
		_bn.y = 0;
		if (_bn.lengthSq() > 1e-8) _bn.normalize();
		_cn.y = 0;
		if (_cn.lengthSq() > 1e-8) _cn.normalize();
		const p = crushHit ? _cp : _bp;
		const closing = -car.velocity.dot(n);
		if (deform && closing > .2 && (crushHit ?? overlap ?? 0) > .004 && !car.crashed) car.applyImpact(p, n.clone(), closing);
		let remain = Math.max(0, closing);
		if (feed && crushHit && crushHit > 0) remain = car.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
		if (overlap) {
			const leftover = leftoverCrumple(car.deform.crumpleTravelCorner());
			const incoming = Math.max(0, -car.velocity.dot(_bn)) * dt;
			const maxPen = car.deform.massActive ? leftover * .4 : .015;
			const extra = Math.max(0, overlap - maxPen);
			const push = car.deform.massActive ? Math.min(extra + .004, .12) : Math.min(Math.max(overlap, incoming) + .012, .22);
			this.pushCar(car, _bn.x, 0, _bn.z, push);
			if (feed && remain > .3) {
				const dtS = dtImpulseScale(dt);
				const pass = car.deform.frontTransfer();
				const used = leftoverPass(remain, pass);
				const e = pass >= .97 ? .02 : 0;
				const invC = 1 / car.deform.totalMass;
				const invB = 1 / BARRIER_MASS;
				const j = Math.min((1 + e) * used * dtS / (invC + invB), 18 + pass * 40);
				this.impulseCar(car, _bn.x, 0, _bn.z, j);
				this.barrierVel.addScaledVector(_bn, -j / BARRIER_MASS);
				_r.copy(_bp).sub(car.group.position);
				car.angular.y += (_r.x * _bn.z - _r.z * _bn.x) * used * -.04;
			}
			if (feed && crushHit) this.indentBarrier(_cp, _cn, Math.min(.012, crushHit * .12));
		}
		clipCarToBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), leftoverCrumple(car.deform.crumpleTravelCorner()));
		return (crushHit ?? overlap ?? 0) > .001 ? {
			impulse: Math.max(closing, .5),
			contact: p.clone(),
			normal: n.clone()
		} : null;
	}
	resolvePair(carA, carB, deform, feed, dt) {
		const dist = carA.group.position.distanceTo(carB.group.position);
		if (dist > 5.2) return null;
		if (this.showBarrier && this.barrierBlocksPair(carA, carB)) return null;
		const crushHit = satCars(carA, carB, _cn, _cp, (c) => c.crushHulls());
		const hit = satCars(carA, carB, _n, _p, (c) => c.hulls());
		if (!crushHit && !hit) return null;
		carA.deform.notifyContact();
		carB.deform.notifyContact();
		const n = crushHit ? _cn : _n;
		n.y = 0;
		if (n.lengthSq() > 1e-8) n.normalize();
		_n.y = 0;
		if (_n.lengthSq() > 1e-8) _n.normalize();
		_cn.y = 0;
		if (_cn.lengthSq() > 1e-8) _cn.normalize();
		const p = crushHit ? _cp : _p;
		const closing = -_v.copy(carA.velocity).sub(carB.velocity).dot(n);
		if (deform && closing > .2 && (crushHit ?? hit ?? 0) > .006) {
			if (!carA.crashed) carA.applyImpact(p, n.clone(), closing);
			if (!carB.crashed) carB.applyImpact(p, n.clone().negate(), closing);
		}
		let remain = Math.max(0, closing);
		if (feed && crushHit) {
			const remainA = carA.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
			const remainB = carB.deform.feedOverlap(_cp, _w.copy(_cn).negate(), crushHit, Math.max(0, closing), dt);
			remain = Math.max(0, Math.min(remainA, remainB));
		}
		const leftoverA = leftoverCrumple(carA.deform.crumpleTravelCorner());
		const leftoverB = leftoverCrumple(carB.deform.crumpleTravelCorner());
		const pass = Math.min(carA.deform.frontTransfer(), carB.deform.frontTransfer());
		if (hit) {
			const maxPen = Math.min(leftoverA, leftoverB) * .1;
			const extra = Math.max(0, hit - maxPen);
			const push = Math.min(extra + .006, .09);
			const aAmt = carA.deform.massActive && carB.deform.massActive ? push * .5 : carA.deform.massActive ? push * .62 : push * .38;
			this.pushCar(carA, _n.x, 0, _n.z, aAmt);
			this.pushCar(carB, -_n.x, 0, -_n.z, push - aAmt);
		} else if (crushHit) {
			const allowed = leftoverA * .45 + leftoverB * .45 + .08;
			const extra = Math.min(crushHit - allowed, .04);
			if (extra > .012) {
				this.pushCar(carA, _cn.x, 0, _cn.z, extra * .5);
				this.pushCar(carB, -_cn.x, 0, -_cn.z, extra * .5);
			}
		}
		const minSep = 2.15 + leftoverA * .28 + leftoverB * .28;
		if (dist < minSep && dist > 1e-4) {
			_w.copy(carA.group.position).sub(carB.group.position).setY(0);
			if (_w.lengthSq() > 1e-8) {
				_w.normalize();
				const extra = Math.min((minSep - dist) * .5, .05);
				this.pushCar(carA, _w.x, 0, _w.z, extra);
				this.pushCar(carB, -_w.x, 0, -_w.z, extra);
			}
		}
		if (hit && feed && remain > .25) {
			const dtS = dtImpulseScale(dt);
			const used = leftoverPass(remain, pass);
			const e = pass >= .97 ? .02 : 0;
			const invA = 1 / carA.deform.totalMass;
			const invB = 1 / carB.deform.totalMass;
			const jMax = 18 + pass * 36;
			const j = Math.min((1 + e) * used * dtS / (invA + invB), jMax);
			this.impulseCar(carA, _n.x, 0, _n.z, j);
			this.impulseCar(carB, -_n.x, 0, -_n.z, j);
			const tAx = carA.velocity.x - carB.velocity.x;
			const tAz = carA.velocity.z - carB.velocity.z;
			const relT = tAx * _n.z - tAz * _n.x;
			const jt = MathUtils.clamp(relT / (invA + invB), -.45 * j, .45 * j);
			this.impulseCar(carA, _n.z, 0, -_n.x, -jt);
			this.impulseCar(carB, _n.z, 0, -_n.x, jt);
			_r.copy(_p).sub(carA.group.position);
			carA.angular.y += (_r.x * _n.z - _r.z * _n.x) * j * 8e-5;
			_r.copy(_p).sub(carB.group.position);
			carB.angular.y += (_r.x * -_n.z - _r.z * -_n.x) * j * 8e-5;
		}
		return {
			impulse: Math.max(closing, (crushHit ?? hit ?? 0) * 6),
			contact: p.clone(),
			normal: n.clone()
		};
	}
	/** True when the jersey slab sits between this pair so they must not SAT through it. */
	barrierBlocksPair(a, b) {
		_bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
		const ax = a.group.position.x * _bRight.x + a.group.position.z * _bRight.z;
		const bx = b.group.position.x * _bRight.x + b.group.position.z * _bRight.z;
		const pad = BARRIER_HALF.x + .2;
		return ax * bx < 0 && Math.abs(ax) > pad && Math.abs(bx) > pad;
	}
	beginCinematic(contact, normal, impulse) {
		this.phase = "impact";
		this.wallSinceImpact = 0;
		this.impactKph = impulse * 3.6;
		if (this.autoSlomo) {
			const scale = this.reduceMotion ? .16 : IMPACT_SCALE;
			this.targetScale = scale;
			if (this.timeScale > scale * 1.15) this.timeScale = scale;
		} else {
			this.targetScale = 1;
			this.timeScale = 1;
		}
		this.trauma = this.reduceMotion ? .15 : .85;
		this.camBlend = 1;
		if (!this.userFramed) {
			this.orbitAngle = Math.atan2(this.camera.position.x - this.camLook.x, this.camera.position.z - this.camLook.z);
			this.orbitRadius = MathUtils.clamp(this.orbitRadius + Math.max(0, this.carCount - 2) * .4, 8, 22);
		}
		this.impactLight.position.copy(contact);
		this.impactLight.position.y = .8;
		this.impactLightLife = .35;
		this.debris.burst(contact, normal, Math.min(90, 28 + impulse * .9) * this.fxDensity);
		this.sparks.poof(contact, normal, Math.min(90, 36 + impulse * 1.1) * this.fxDensity);
		const src = this.nearestCar(contact);
		this.smoke.plume(contact, src.velocity, Math.max(8, 14 * this.fxDensity | 0));
		this.armEngineSmoke(src, 4.5);
		for (const car of this.live()) if (car.crashed && car !== src) this.armEngineSmoke(car, 4.5);
		this.fxPoofed = true;
		if (this.audioOn) this.audio.impact(impulse);
		this.emitHud(true);
	}
	emitContactFx() {
		if (this.phase === "approach") return;
		const cars = this.live();
		let contact = null;
		let normal = null;
		outer: for (let i = 0; i < cars.length; i++) {
			const massesA = cars[i].deform.masses;
			for (let j = i + 1; j < cars.length; j++) {
				const massesB = cars[j].deform.masses;
				for (const a of massesA) for (const b of massesB) {
					const dx = a.world.x - b.world.x;
					const dy = a.world.y - b.world.y;
					const dz = a.world.z - b.world.z;
					const dist = Math.hypot(dx, dy, dz);
					if (dist >= a.radius + b.radius + .08 || dist < 1e-5) continue;
					_p.set((a.world.x + b.world.x) * .5, (a.world.y + b.world.y) * .5, (a.world.z + b.world.z) * .5);
					_n.set(dx / dist, dy / dist, dz / dist);
					contact = _p;
					normal = _n;
					break outer;
				}
			}
		}
		if (!contact && this.showBarrier) {
			const hi = this.barrierHits.findIndex(Boolean);
			const hitCar = hi >= 0 ? cars[hi] : null;
			if (hitCar) {
				_bp.copy(hitCar.deform.massWorld("bumperFL")).add(hitCar.deform.massWorld("bumperFR")).multiplyScalar(.5);
				_bp.y = .32;
				_bn.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
				contact = _bp;
				normal = _bn;
			}
		}
		if (!contact) return;
		const src = this.nearestCar(contact);
		this.armEngineSmoke(src, 2.8);
		if (!this.fxPoofed) {
			this.sparks.poof(contact, normal, Math.max(24, 48 * this.fxDensity | 0));
			this.smoke.plume(contact, src.velocity, Math.max(10, 16 * this.fxDensity | 0));
			this.fxPoofed = true;
		}
	}
	nearestCar(point) {
		const cars = this.live();
		let best = cars[0];
		let bestD = best.group.position.distanceToSquared(point);
		for (let i = 1; i < cars.length; i++) {
			const d = cars[i].group.position.distanceToSquared(point);
			if (d < bestD) {
				bestD = d;
				best = cars[i];
			}
		}
		return best;
	}
	bleedAfterSlide(car, dt) {
		if (!car.crashed) return;
		const q = car.deform.quietTime();
		const mu = q < .15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q));
		applyGroundFriction(car.velocity, dt, mu, true);
		if (car.deform.massActive && q > .08) car.deform.dragGround(dt, MathUtils.clamp((q - .08) / 1.1, 0, 1));
	}
	armEngineSmoke(car, extra) {
		if (!car.crashed) return;
		const until = this.elapsedWall + extra;
		const i = Math.max(0, this.cars.indexOf(car));
		this.smokeUntil[i] = Math.max(this.smokeUntil[i] ?? 0, until);
	}
	puffEngine(car) {
		if (!car.crashed || !car.deform.massActive) return;
		if (car.deform.drivetrainAlive && car.deform.partCompression("bonnet") < .08) return;
		const n = Math.max(2, 4 * this.fxDensity | 0);
		for (const name of ["engineL", "engineR"]) {
			const m = car.deform.massWorld(name);
			_v.copy(m);
			_v.y = .12;
			this.smoke.plume(_v, car.velocity, n);
		}
	}
	updatePhase(wallDt) {
		if (this.phase === "approach") return;
		this.wallSinceImpact += wallDt;
		if (this.phase === "impact") {
			if (this.wallSinceImpact > .12) this.phase = "slowmo";
		} else if (this.phase === "slowmo") {
			const hold = this.reduceMotion ? 1.4 : 6.5;
			if (this.wallSinceImpact > hold) {
				this.targetScale = 1;
				this.phase = "aftermath";
			}
		} else if (this.phase === "aftermath") {
			if (this.wallSinceImpact > 8.2) this.targetScale = 1;
			if (this.looping && this.wallSinceImpact > (this.showCompactor ? 14 : 10.4)) this.randomizeAndReset();
		}
	}
	updateCamera(wallDt) {
		if (this.showCompactor) this.camLook.set(this.carA.group.position.x, .55, this.carA.group.position.z);
		else {
			this.centroid(_v);
			this.camLook.set(_v.x, .7, _v.z);
		}
		if (this.autoRotate && this.playing && !this.orbitDragging && !this.reduceMotion) {
			const rate = this.phase === "approach" ? .12 : .32;
			this.orbitAngle += rate * wallDt;
		}
		const cp = Math.cos(this.orbitPitch);
		const sp = Math.sin(this.orbitPitch);
		this.camPos.set(this.camLook.x + Math.sin(this.orbitAngle) * this.orbitRadius * cp, this.camLook.y + this.orbitRadius * sp, this.camLook.z + Math.cos(this.orbitAngle) * this.orbitRadius * cp);
		const k = 1 - Math.exp((this.orbitDragging ? -18 : -5.5) * wallDt);
		this.camera.position.lerp(this.camPos, k);
		if (this.trauma > 0 && this.playing) {
			const shake = this.trauma * this.trauma;
			const t = performance.now() * .017;
			this.camera.position.x += Math.sin(t * 37.1) * shake * .28;
			this.camera.position.y += Math.cos(t * 29.4) * shake * .18;
			this.camera.rotation.z = Math.sin(t * 21.2) * shake * .025;
		} else this.camera.rotation.z = 0;
		this.camera.lookAt(this.camLook);
	}
	barrierHx() {
		return Math.max(.18, BARRIER_HALF.x * (1 - this.barrierCrush * .45));
	}
	stepBarrier(dt) {
		if (!this.showBarrier || dt <= 0) return;
		this.barrier.position.x += this.barrierVel.x * dt;
		this.barrier.position.z += this.barrierVel.z * dt;
		applyGroundFriction(this.barrierVel, dt, 1.8, true);
	}
	indentBarrier(contact, normal, amount) {
		this.barrierCrush = Math.min(.55, this.barrierCrush + amount * .7);
		this.barrier.traverse((obj) => {
			if (!(obj instanceof Mesh)) return;
			if (!obj.userData.rest) return;
			const geo = obj.geometry;
			const attr = geo.getAttribute("position");
			const arr = attr.array;
			obj.updateMatrixWorld();
			for (let i = 0; i < arr.length; i += 3) {
				_v.set(arr[i], arr[i + 1], arr[i + 2]);
				obj.localToWorld(_v);
				const dx = _v.x - contact.x;
				const dy = _v.y - contact.y;
				const dz = _v.z - contact.z;
				const fall = Math.exp(-Math.hypot(dx, dy, dz) * 2.2);
				_v.x -= normal.x * amount * fall;
				_v.z -= normal.z * amount * fall;
				obj.worldToLocal(_v);
				arr[i] = _v.x;
				arr[i + 1] = _v.y;
				arr[i + 2] = _v.z;
			}
			attr.needsUpdate = true;
			geo.computeVertexNormals();
		});
	}
	bounceGround = (pos, vel, r) => {
		if (pos.y < r) {
			pos.y = r;
			if (vel.y < 0) vel.y *= -.28;
			vel.x *= .86;
			vel.z *= .86;
		}
	};
	bounceWorld = (pos, vel, r) => {
		this.bounceGround(pos, vel, r);
		for (const car of this.live()) this.bounceAgainstCar(car, pos, vel, r);
		if (this.showCompactor) {
			const hz = .24;
			const hy = 1.05;
			const hx = 1.8;
			const z = this.compactFace + .24;
			separateSphereFromAabb(pos, vel, r, 0, 1.02, z, hx, hy, hz);
			separateSphereFromAabb(pos, vel, r, 0, 1.02, -z, hx, hy, hz);
		}
		if (!this.showBarrier) return;
		_bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
		_bFwd.set(Math.sin(this.barrierYaw), 0, Math.cos(this.barrierYaw));
		const oxp = pos.x - this.barrier.position.x;
		const ozp = pos.z - this.barrier.position.z;
		const lx = oxp * _bRight.x + ozp * _bRight.z;
		const lz = oxp * _bFwd.x + ozp * _bFwd.z;
		const ox = this.barrierHx() + r - Math.abs(lx);
		const oz = BARRIER_HALF.z + r - Math.abs(lz);
		if (ox <= 0 || oz <= 0 || pos.y > 1.45) return;
		if (ox < oz) {
			const s = lx >= 0 ? 1 : -1;
			pos.addScaledVector(_bRight, s * ox);
			const vn = vel.x * _bRight.x * s + vel.z * _bRight.z * s;
			if (vn < 0) {
				vel.x -= _bRight.x * s * vn * 1.5;
				vel.z -= _bRight.z * s * vn * 1.5;
			}
		} else {
			const s = lz >= 0 ? 1 : -1;
			pos.addScaledVector(_bFwd, s * oz);
			const vn = vel.x * _bFwd.x * s + vel.z * _bFwd.z * s;
			if (vn < 0) {
				vel.x -= _bFwd.x * s * vn * 1.5;
				vel.z -= _bFwd.z * s * vn * 1.5;
			}
		}
	};
	bounceAgainstCar(car, pos, vel, r) {
		car.group.updateMatrixWorld();
		_ha.copy(pos);
		car.group.worldToLocal(_ha);
		if (_ha.y < .02 - r || _ha.y > 1.45 + r) return;
		for (const h of car.hulls()) {
			const dx = _ha.x - h.cx;
			const dz = _ha.z - h.cz;
			const ox = h.hx + r - Math.abs(dx);
			const oz = h.hz + r - Math.abs(dz);
			if (ox <= 0 || oz <= 0) continue;
			if (ox < oz) {
				const s = dx >= 0 ? 1 : -1;
				_ha.x += s * ox;
				const nx = car.rightFlat.x * s;
				const nz = car.rightFlat.z * s;
				const vn = vel.x * nx + vel.z * nz;
				if (vn < 0) {
					vel.x -= vn * nx * 1.55;
					vel.z -= vn * nz * 1.55;
					vel.y += Math.abs(vn) * .15;
				}
			} else {
				const s = dz >= 0 ? 1 : -1;
				_ha.z += s * oz;
				const nx = car.fwdFlat.x * s;
				const nz = car.fwdFlat.z * s;
				const vn = vel.x * nx + vel.z * nz;
				if (vn < 0) {
					vel.x -= vn * nx * 1.55;
					vel.z -= vn * nz * 1.55;
					vel.y += Math.abs(vn) * .15;
				}
			}
			_hb.copy(_ha);
			car.group.localToWorld(_hb);
			pos.copy(_hb);
			return;
		}
	}
	buildBalls() {
		const mat = new MeshStandardMaterial({
			color: 12041414,
			roughness: .52,
			metalness: .1
		});
		for (let i = 0; i < 3; i++) {
			const mesh = new Mesh(new SphereGeometry(1, 22, 16), mat);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.visible = false;
			this.scene.add(mesh);
			this.balls.push({
				mesh,
				radius: .78,
				intact: true,
				kicked: /* @__PURE__ */ new Set()
			});
		}
	}
	scatterBalls() {
		const base = Math.random() * Math.PI * 2;
		for (let i = 0; i < this.balls.length; i++) {
			const b = this.balls[i];
			b.radius = .68 + Math.random() * .24;
			b.mesh.scale.setScalar(b.radius);
			const a = base + i / 3 * Math.PI * 2 + (Math.random() - .5) * .55;
			const r = 5.32 + Math.random();
			b.mesh.position.set(Math.sin(a) * r, -.75 * b.radius, Math.cos(a) * r);
			b.intact = true;
			b.kicked.clear();
			b.mesh.visible = this.showBalls;
		}
	}
	resolveBalls(car, dt) {
		let hit = null;
		const px = car.group.position.x;
		const pz = car.group.position.z;
		const id = car.paint.name;
		for (const ball of this.balls) {
			if (!ball.intact || !this.showBalls) continue;
			const c = ball.mesh.position;
			for (const h of car.hulls()) {
				const relx = (c.x - px) * car.rightFlat.x + (c.z - pz) * car.rightFlat.z;
				const relz = (c.x - px) * car.fwdFlat.x + (c.z - pz) * car.fwdFlat.z;
				const qx = MathUtils.clamp(relx, h.cx - h.hx, h.cx + h.hx);
				const qz = MathUtils.clamp(relz, h.cz - h.hz, h.cz + h.hz);
				_hb.set(px + car.rightFlat.x * qx + car.fwdFlat.x * qz, .28, pz + car.rightFlat.z * qx + car.fwdFlat.z * qz);
				const dx = _hb.x - c.x;
				const dz = _hb.z - c.z;
				const distXz = Math.hypot(dx, dz);
				const ringR = Math.sqrt(Math.max(1e-6, ball.radius * ball.radius * .4375));
				if (distXz > ringR + Math.hypot(h.hx, h.hz)) continue;
				const overlap = ringR + .22 - distXz;
				if (overlap <= 0) continue;
				if (distXz < 1e-4) continue;
				_mtv.set(dx / distXz, .18, dz / distXz).normalize();
				const push = Math.min(overlap * .35, .018);
				this.pushCar(car, _mtv.x, 0, _mtv.z, push);
				car.deform.notifyContact();
				const closing = -(car.velocity.x * _mtv.x + car.velocity.z * _mtv.z);
				if (!ball.kicked.has(id) && closing > .4) {
					ball.kicked.add(id);
					if (!car.deform.massActive) car.deform.armMasses(car.group, car.velocity, car.angular);
					const dv = Math.min(closing * .08, 3.2);
					car.velocity.x += _mtv.x * dv;
					car.velocity.z += _mtv.z * dv;
					car.velocity.y += Math.min(1.6, closing * .035);
					const jUp = MathUtils.clamp(closing * 1.6, 3, 14);
					const hub = car.deform.kickNearestHub(_hb, jUp);
					const broken = closing > 7.5 || overlap > .22;
					if (broken) {
						ball.intact = false;
						ball.mesh.visible = false;
						this.debris.burst(_hb, _mtv, Math.min(48, 14 + closing * 1.2) * this.fxDensity);
						this.sparks.poof(_hb, _mtv, Math.min(28, 8 + closing * .6) * this.fxDensity);
						if (hub) {
							const node = car.deform.masses.find((m) => m.name === hub);
							if (node) car.deform.popHub(node);
						}
					}
					this.ballHits.push({
						t: round4(this.elapsedWall),
						car: id,
						hub,
						closing: round4(closing),
						lift: round4(jUp / 26),
						overlap: round4(overlap),
						broken,
						pos: vec3(_hb),
						n: {
							x: round4(_mtv.x),
							y: round4(_mtv.y),
							z: round4(_mtv.z)
						}
					});
				}
				hit = {
					impulse: Math.max(closing, 2),
					contact: _hb.clone(),
					normal: _mtv.clone()
				};
			}
		}
		return hit;
	}
	resetPoles() {
		for (let i = 0; i < this.poles.length; i++) {
			const pole = this.poles[i];
			const a = i / 6 * Math.PI * 2;
			pole.intact = true;
			pole.kicked.clear();
			pole.group.visible = true;
			pole.group.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
			pole.group.rotation.set(0, 0, 0);
		}
	}
	resolvePoles(car, dt) {
		let hit = null;
		const px = car.group.position.x;
		const pz = car.group.position.z;
		const id = car.paint.name;
		for (const pole of this.poles) {
			if (!pole.intact) continue;
			const c = pole.group.position;
			for (const h of car.hulls()) {
				const relx = (c.x - px) * car.rightFlat.x + (c.z - pz) * car.rightFlat.z;
				const relz = (c.x - px) * car.fwdFlat.x + (c.z - pz) * car.fwdFlat.z;
				const qx = MathUtils.clamp(relx, h.cx - h.hx, h.cx + h.hx);
				const qz = MathUtils.clamp(relz, h.cz - h.hz, h.cz + h.hz);
				_hb.set(px + car.rightFlat.x * qx + car.fwdFlat.x * qz, .4, pz + car.rightFlat.z * qx + car.fwdFlat.z * qz);
				_mtv.set(_hb.x - c.x, 0, _hb.z - c.z);
				const dist = Math.hypot(_mtv.x, _mtv.z);
				if (dist >= pole.radius + .04 || dist < 1e-5) continue;
				_mtv.multiplyScalar(1 / dist);
				const overlap = pole.radius + .04 - dist;
				this.pushCar(car, _mtv.x, 0, _mtv.z, Math.min(overlap, .04));
				car.deform.notifyContact();
				const closing = -(car.velocity.x * _mtv.x + car.velocity.z * _mtv.z);
				if (!pole.kicked.has(id) && closing > .8) {
					pole.kicked.add(id);
					const j = MathUtils.clamp(closing * 40, 80, 400);
					this.impulseCar(car, _mtv.x, 0, _mtv.z, j);
					if (!car.deform.massActive && closing > 4) car.applyImpact(_hb, _mtv, closing);
					else if (car.deform.massActive) car.deform.kickNearest(_hb, _mtv.x, .15, _mtv.z, closing * 8);
					if (closing > 3.5) {
						pole.intact = false;
						pole.group.rotation.z = Math.atan2(_mtv.x, _mtv.z) ? 1.15 * Math.sign(_mtv.x || 1) : 1.15;
						pole.group.rotation.x = _mtv.z > 0 ? -1.05 : 1.05;
						this.debris.burst(_hb, _mtv, Math.min(40, 10 + closing) * this.fxDensity);
						this.sparks.poof(_hb, _mtv, Math.min(22, 6 + closing * .5) * this.fxDensity);
					}
				}
				hit = {
					impulse: Math.max(closing, 2),
					contact: _hb.clone(),
					normal: _mtv.clone()
				};
			}
		}
		return hit;
	}
	buildPress() {
		const mat = new MeshStandardMaterial({
			color: 6975094,
			roughness: .48,
			metalness: .72
		});
		const geo = new BoxGeometry(3.6, 2.05, .48);
		this.pressFront = new Mesh(geo, mat);
		this.pressRear = new Mesh(geo, mat);
		this.pressFront.castShadow = true;
		this.pressRear.castShadow = true;
		this.pressFront.receiveShadow = true;
		this.pressRear.receiveShadow = true;
		this.press = new Group();
		this.press.add(this.pressFront, this.pressRear);
		this.press.visible = false;
		this.scene.add(this.press);
		this.syncPress();
	}
	syncPress() {
		if (!this.pressFront) return;
		const z = this.compactFace + .24;
		this.pressFront.position.set(0, 1.02, z);
		this.pressRear.position.set(0, 1.02, -z);
	}
	stepCompactor(dt) {
		const target = COMPACTOR.maxFace;
		this.compactFace = Math.max(target, this.compactFace - COMPACTOR.speed * dt);
		this.syncPress();
		this.carA.refreshBasis();
		if (!this.carA.deform.massActive && this.compactFace < COMPACTOR.bumperZ + .12) {
			this.carA.deform.beginCrush(new Vector3(0, .36, 2.06), new Vector3(0, 0, -1), 18, this.carA.group, this.carA.velocity, this.carA.angular);
			this.carA.crashed = true;
		}
		this.carA.deform.bidirectional = true;
		this.carA.deform.deepCrush = this.compactFace < COMPACTOR.midFace;
		if (this.carA.deform.massActive) {
			this.carA.deform.notifyContact();
			const hit = enforceWalls(this.carA.deform, this.compactFace, dt);
			this.carA.deform.stepStructure(dt);
			enforceWalls(this.carA.deform, this.compactFace, dt);
			this.carA.syncPose(dt);
			if (hit.hits > 0 && this.elapsedWall > this.compactFxAt) {
				this.compactFxAt = this.elapsedWall + .2;
				_bp.set(0, .34, this.compactFace);
				_bn.set(0, 0, -1);
				this.sparks.poof(_bp, _bn, Math.max(10, 18 * this.fxDensity | 0));
				_bp.z = -this.compactFace;
				_bn.set(0, 0, 1);
				this.sparks.poof(_bp, _bn, Math.max(10, 18 * this.fxDensity | 0));
				if (this.phase === "approach") {
					this.beginCinematic(_bp, _bn, COMPACTOR.speed * 8);
					if (this.autoSlomo) this.targetScale = this.reduceMotion ? .28 : .42;
				}
			}
		}
		const stage = compactorStage(this.compactFace);
		if (stage === "contact" || stage === "wells") this.phase = this.phase === "approach" ? "impact" : this.phase;
		if (stage === "mid") this.phase = "slowmo";
		if (stage === "max") this.phase = "aftermath";
	}
	emitHud(force) {
		const cars = this.live();
		const relVel = this.fleetClosing();
		const eta = this.phase === "approach" && !this.showCompactor ? this.contactEta() : 0;
		publishHud({
			playing: this.playing,
			looping: this.looping,
			showRig: this.showRig,
			showBarrier: this.showBarrier,
			showBalls: this.showBalls,
			showCompactor: this.showCompactor,
			autoRotate: this.autoRotate,
			autoSlomo: this.autoSlomo,
			audioOn: this.audioOn,
			deformMode: this.deformMode,
			phase: this.phase,
			timeScale: this.timeScale,
			elapsed: this.elapsedWall,
			speedA: this.showCompactor ? 0 : cars[0]?.velocity.length() ?? 0,
			speedB: this.showCompactor ? 0 : cars[1]?.velocity.length() ?? 0,
			closingKph: relVel * 3.6,
			impactKph: this.impactKph,
			eta: Number.isFinite(eta) ? eta : 0,
			cageCount: this.carA.deform.cageCount,
			sensorCount: this.carA.deform.sensorCount,
			squash: this.squash,
			buckle: this.buckle,
			fxDensity: this.fxDensity,
			carCount: this.carCount,
			speedMin: this.speedMin,
			speedMax: this.speedMax,
			traceSamples: this.traceSamples.length,
			wallGap: this.showCompactor ? this.compactFace * 2 : 0,
			compactStage: this.showCompactor ? compactorStage(this.compactFace) : "open"
		});
	}
	resize = () => {
		const parent = this.canvas.parentElement ?? this.canvas;
		const w = Math.max(1, parent.clientWidth);
		const h = Math.max(1, parent.clientHeight);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	};
	buildWorld() {
		const hemi = new HemisphereLight(12043480, 1710102, 1.1);
		this.scene.add(hemi);
		const dir = new DirectionalLight(15922687, 2.4);
		dir.position.set(-10, 22, 9);
		dir.castShadow = true;
		dir.shadow.mapSize.set(2048, 2048);
		dir.shadow.camera.near = 2;
		dir.shadow.camera.far = 60;
		dir.shadow.camera.left = -24;
		dir.shadow.camera.right = 24;
		dir.shadow.camera.top = 24;
		dir.shadow.camera.bottom = -24;
		dir.shadow.bias = -4e-4;
		this.scene.add(dir);
		const pad = new SpotLight(15265528, 32, 40, .55, .6, 1.1);
		pad.position.set(4, 18, 6);
		pad.target.position.set(0, 0, 0);
		pad.castShadow = true;
		pad.shadow.mapSize.set(1024, 1024);
		pad.shadow.bias = -3e-4;
		this.scene.add(pad, pad.target);
		const bounce = new PointLight(12964064, 12, 28, 1.6);
		bounce.position.set(0, 6, 0);
		this.scene.add(bounce);
		const fill = new DirectionalLight(13226976, 1.35);
		fill.position.set(10, 12, -14);
		this.scene.add(fill);
		const ground = new Mesh(new CircleGeometry(48, 64), new MeshStandardMaterial({
			color: 2763828,
			roughness: .88,
			metalness: .06,
			map: makeAsphalt()
		}));
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		this.scene.add(ground);
		const grid = new GridHelper(60, 30, 2763826, 1579294);
		grid.position.y = .012;
		this.scene.add(grid);
		const ringGeo = new RingGeometry(2.15, 2.32, 64);
		const ringMat = new MeshBasicMaterial({
			color: 14210252,
			transparent: true,
			opacity: .22,
			side: 2
		});
		this.ring = new Mesh(ringGeo, ringMat);
		this.ring.rotation.x = -Math.PI / 2;
		this.ring.position.y = .03;
		this.scene.add(this.ring);
		const inner = new Mesh(new RingGeometry(.12, .22, 24), new MeshBasicMaterial({
			color: 14210252,
			transparent: true,
			opacity: .35,
			side: 2
		}));
		inner.rotation.x = -Math.PI / 2;
		inner.position.y = .03;
		this.scene.add(inner);
		this.buildBalls();
		for (let i = 0; i < 6; i++) {
			const a = i / 6 * Math.PI * 2;
			const pole = makeLamp();
			pole.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
			this.scene.add(pole);
			this.poles.push({
				group: pole,
				intact: true,
				radius: .12,
				kicked: /* @__PURE__ */ new Set()
			});
		}
	}
};
function makeConcrete() {
	const c = document.createElement("canvas");
	c.width = 256;
	c.height = 256;
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#b7b1a4";
	ctx.fillRect(0, 0, 256, 256);
	for (let i = 0; i < 2800; i++) {
		const n = Math.random();
		ctx.fillStyle = n > .55 ? `rgba(255,255,255,${n * .07})` : `rgba(30,26,22,${(1 - n) * .1})`;
		ctx.fillRect(Math.random() * 256, Math.random() * 256, n > .88 ? 3 : 1, 1);
	}
	ctx.fillStyle = "rgba(40,38,34,0.18)";
	ctx.fillRect(0, 200, 256, 56);
	const tex = new CanvasTexture(c);
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.anisotropy = 4;
	tex.colorSpace = SRGBColorSpace;
	return tex;
}
function makeAsphalt() {
	const c = document.createElement("canvas");
	c.width = 512;
	c.height = 512;
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#17181d";
	ctx.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 9e3; i++) {
		const n = Math.random();
		ctx.fillStyle = `rgba(255,255,255,${n * .045})`;
		ctx.fillRect(Math.random() * 512, Math.random() * 512, n > .8 ? 2 : 1, 1);
	}
	for (let i = 0; i < 400; i++) {
		ctx.fillStyle = `rgba(0,0,0,${.08 + Math.random() * .12})`;
		ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 2);
	}
	const tex = new CanvasTexture(c);
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.repeat.set(18, 18);
	tex.anisotropy = 8;
	tex.colorSpace = SRGBColorSpace;
	return tex;
}
function makeJerseyBarrier() {
	const g = new Group();
	g.name = "jersey-barrier";
	const shape = new Shape();
	shape.moveTo(-.305, 0);
	shape.lineTo(.305, 0);
	shape.lineTo(.305, .075);
	shape.lineTo(.215, .33);
	shape.lineTo(.075, .81);
	shape.lineTo(-.075, .81);
	shape.lineTo(-.215, .33);
	shape.lineTo(-.305, .075);
	shape.closePath();
	const concreteTex = makeConcrete();
	const concrete = new MeshStandardMaterial({
		color: 12894131,
		roughness: .94,
		metalness: .05,
		map: concreteTex
	});
	const weathered = new MeshStandardMaterial({
		color: 11446685,
		roughness: .96,
		metalness: .04,
		map: concreteTex
	});
	const jointMat = new MeshStandardMaterial({
		color: 6051922,
		roughness: .8,
		metalness: .2
	});
	const segLen = 1.78;
	for (const [zOff, mat] of [[-.95, concrete], [.95, weathered]]) {
		const geo = new ExtrudeGeometry(shape, {
			depth: segLen,
			bevelEnabled: false,
			steps: 1
		});
		geo.translate(0, 0, -1.78 / 2);
		geo.computeVertexNormals();
		const mesh = new Mesh(geo, mat);
		mesh.position.z = zOff;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.userData.rest = geo.getAttribute("position").array.slice();
		g.add(mesh);
	}
	const pin = new Mesh(new CylinderGeometry(.04, .04, .18, 8), jointMat);
	pin.position.set(0, .09, 0);
	pin.castShadow = true;
	g.add(pin);
	const cap = new Mesh(new BoxGeometry(.1, .04, .12), jointMat);
	cap.position.set(0, .82, 0);
	g.add(cap);
	return g;
}
function restoreBarrierRest(group) {
	group.traverse((obj) => {
		if (!(obj instanceof Mesh)) return;
		const rest = obj.userData.rest;
		if (!rest) return;
		const geo = obj.geometry;
		const attr = geo.getAttribute("position");
		attr.array.set(rest);
		attr.needsUpdate = true;
		geo.computeVertexNormals();
	});
}
function makeLamp() {
	const g = new Group();
	const pole = new Mesh(new CylinderGeometry(.08, .1, 5.2, 8), new MeshStandardMaterial({
		color: 2763826,
		roughness: .7,
		metalness: .4
	}));
	pole.position.y = 2.6;
	pole.castShadow = true;
	const head = new Mesh(new BoxGeometry(.5, .1, .22), new MeshStandardMaterial({
		color: 15787720,
		emissive: 15787720,
		emissiveIntensity: 1.4,
		roughness: .4
	}));
	head.position.set(0, 5.15, .15);
	const light = new PointLight(15787720, 2.4, 14, 2);
	light.position.set(0, 5, .2);
	g.add(pole, head, light);
	return g;
}
var DebrisSystem = class {
	mesh;
	life;
	vx;
	vy;
	vz;
	dummy = new Object3D();
	vel = new Vector3();
	n;
	constructor(scene, n = 180) {
		this.n = n;
		const geo = new BoxGeometry(.038, .016, .026);
		const mat = new MeshStandardMaterial({
			color: 6975092,
			metalness: .72,
			roughness: .4
		});
		this.mesh = new InstancedMesh(geo, mat, n);
		this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		this.mesh.castShadow = true;
		this.mesh.count = 0;
		this.life = new Float32Array(n);
		this.vx = new Float32Array(n);
		this.vy = new Float32Array(n);
		this.vz = new Float32Array(n);
		scene.add(this.mesh);
	}
	reset() {
		this.mesh.count = 0;
		this.life.fill(0);
	}
	snapshot() {
		const items = [];
		for (let i = 0; i < this.mesh.count && items.length < 16; i++) {
			if (this.life[i] <= 0) continue;
			this.mesh.getMatrixAt(i, this.dummy.matrix);
			this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
			items.push({
				x: round4(this.dummy.position.x),
				y: round4(this.dummy.position.y),
				z: round4(this.dummy.position.z),
				life: round4(this.life[i])
			});
		}
		return {
			count: items.length,
			items
		};
	}
	burst(origin, normal, count) {
		const n = Math.min(this.n, Math.floor(count));
		this.mesh.count = n;
		for (let i = 0; i < n; i++) {
			this.life[i] = .9 + Math.random() * 1.5;
			const side = Math.random() - .5;
			this.vx[i] = -normal.x * (2 + Math.random() * 6) + (Math.random() - .5) * 5 + normal.z * side * 4;
			this.vy[i] = 1.4 + Math.random() * 4.2;
			this.vz[i] = -normal.z * (2 + Math.random() * 6) + (Math.random() - .5) * 5 - normal.x * side * 4;
			this.dummy.position.copy(origin);
			this.dummy.position.y += .08;
			this.dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
			this.dummy.scale.setScalar(.45 + Math.random() * .7);
			this.dummy.updateMatrix();
			this.mesh.setMatrixAt(i, this.dummy.matrix);
		}
		this.mesh.instanceMatrix.needsUpdate = true;
	}
	update(dt, bounce) {
		if (this.mesh.count === 0) return;
		let any = false;
		for (let i = 0; i < this.mesh.count; i++) {
			if (this.life[i] <= 0) continue;
			any = true;
			this.life[i] -= dt;
			this.vy[i] -= 9.6 * dt;
			this.mesh.getMatrixAt(i, this.dummy.matrix);
			this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
			this.dummy.position.x += this.vx[i] * dt;
			this.dummy.position.y += this.vy[i] * dt;
			this.dummy.position.z += this.vz[i] * dt;
			this.vel.set(this.vx[i], this.vy[i], this.vz[i]);
			bounce(this.dummy.position, this.vel, .03);
			this.dummy.position.y = Math.max(.04, this.dummy.position.y);
			this.vx[i] = this.vel.x;
			this.vy[i] = this.vel.y;
			this.vz[i] = this.vel.z;
			this.dummy.rotation.x += dt * 5;
			this.dummy.rotation.y += dt * 3.2;
			this.dummy.updateMatrix();
			this.mesh.setMatrixAt(i, this.dummy.matrix);
		}
		this.mesh.instanceMatrix.needsUpdate = true;
		if (!any) this.mesh.count = 0;
	}
	dispose() {
		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
	}
};
function makeDotTexture(color, glow) {
	const c = document.createElement("canvas");
	c.width = 64;
	c.height = 64;
	const ctx = c.getContext("2d");
	const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
	g.addColorStop(0, color);
	g.addColorStop(.35, glow);
	g.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	return tex;
}
var SparkSystem = class {
	points;
	geo;
	pos;
	vx;
	vy;
	vz;
	life;
	tmp = new Vector3();
	vel = new Vector3();
	n;
	cursor = 0;
	constructor(scene, n = 480) {
		this.n = n;
		this.pos = new Float32Array(n * 3);
		this.vx = new Float32Array(n);
		this.vy = new Float32Array(n);
		this.vz = new Float32Array(n);
		this.life = new Float32Array(n);
		for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
		this.geo = new BufferGeometry();
		this.geo.setAttribute("position", new BufferAttribute(this.pos, 3));
		this.geo.setDrawRange(0, n);
		const mat = new PointsMaterial({
			map: makeDotTexture("rgba(255,248,220,1)", "rgba(255,170,70,0.7)"),
			color: 16777215,
			size: .055,
			transparent: true,
			opacity: .95,
			depthWrite: false,
			blending: 2,
			sizeAttenuation: true
		});
		this.points = new Points(this.geo, mat);
		this.points.frustumCulled = false;
		scene.add(this.points);
	}
	reset() {
		this.life.fill(0);
		this.cursor = 0;
		for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
		this.geo.setDrawRange(0, this.n);
		this.geo.getAttribute("position").needsUpdate = true;
	}
	burst(origin, normal, count) {
		this.poof(origin, normal, count);
	}
	poof(origin, normal, count) {
		const n = Math.min(this.n, Math.max(0, Math.floor(count)));
		for (let i = 0; i < n; i++) {
			const k = this.cursor;
			this.cursor = (this.cursor + 1) % this.n;
			const ox = (Math.random() - .5) * 2;
			const oy = Math.random();
			const oz = (Math.random() - .5) * 2;
			const mag = Math.hypot(ox, oy, oz) || 1;
			this.pos[k * 3] = origin.x + (Math.random() - .5) * .22;
			this.pos[k * 3 + 1] = Math.max(.08, origin.y) + Math.random() * .12;
			this.pos[k * 3 + 2] = origin.z + (Math.random() - .5) * .22;
			const speed = 1.1 + Math.random() * 2.4;
			this.vx[k] = ox / mag * speed - normal.x * .6;
			this.vy[k] = oy / mag * speed * .85 + .8;
			this.vz[k] = oz / mag * speed - normal.z * .6;
			this.life[k] = .14 + Math.random() * .2;
		}
		this.geo.setDrawRange(0, this.n);
		this.geo.getAttribute("position").needsUpdate = true;
	}
	snapshot() {
		return snapshotPoints(this.pos, null, null, this.life, true);
	}
	update(dt, bounce) {
		let any = false;
		for (let i = 0; i < this.n; i++) {
			if (this.life[i] <= 0) {
				this.pos[i * 3 + 1] = 250;
				continue;
			}
			any = true;
			this.life[i] -= dt;
			if (this.life[i] <= 0) {
				this.pos[i * 3 + 1] = 250;
				continue;
			}
			this.tmp.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
			this.vel.set(this.vx[i], this.vy[i], this.vz[i]);
			this.tmp.addScaledVector(this.vel, dt);
			this.vel.y -= 6.5 * dt;
			bounce(this.tmp, this.vel, .025);
			this.tmp.y = Math.max(.04, this.tmp.y);
			this.pos[i * 3] = this.tmp.x;
			this.pos[i * 3 + 1] = this.tmp.y;
			this.pos[i * 3 + 2] = this.tmp.z;
			this.vx[i] = this.vel.x;
			this.vy[i] = this.vel.y;
			this.vz[i] = this.vel.z;
		}
		if (any) this.geo.getAttribute("position").needsUpdate = true;
	}
	dispose() {
		this.geo.dispose();
		const mat = this.points.material;
		mat.map?.dispose();
		mat.dispose();
	}
};
var GlassDotSystem = class {
	points;
	geo;
	pos;
	vx;
	vy;
	vz;
	life;
	tmp = new Vector3();
	vel = new Vector3();
	n;
	cursor = 0;
	constructor(scene, n = 320) {
		this.n = n;
		this.pos = new Float32Array(n * 3);
		this.vx = new Float32Array(n);
		this.vy = new Float32Array(n);
		this.vz = new Float32Array(n);
		this.life = new Float32Array(n);
		for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
		this.geo = new BufferGeometry();
		this.geo.setAttribute("position", new BufferAttribute(this.pos, 3));
		this.geo.setDrawRange(0, n);
		const mat = new PointsMaterial({
			map: makeDotTexture("rgba(255,255,255,1)", "rgba(210,230,245,0.55)"),
			color: 16777215,
			size: .042,
			transparent: true,
			opacity: .9,
			depthWrite: false,
			blending: 2,
			sizeAttenuation: true
		});
		this.points = new Points(this.geo, mat);
		this.points.frustumCulled = false;
		scene.add(this.points);
	}
	reset() {
		this.life.fill(0);
		this.cursor = 0;
		for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
		this.geo.getAttribute("position").needsUpdate = true;
	}
	burst(origin, inherit, count) {
		const n = Math.min(this.n, Math.floor(count));
		for (let i = 0; i < n; i++) {
			const k = this.cursor;
			this.cursor = (this.cursor + 1) % this.n;
			this.pos[k * 3] = origin.x + (Math.random() - .5) * .55;
			this.pos[k * 3 + 1] = Math.max(.12, origin.y) + (Math.random() - .2) * .28;
			this.pos[k * 3 + 2] = origin.z + (Math.random() - .5) * .4;
			this.vx[k] = inherit.x * .85 + (Math.random() - .5) * 5.5;
			this.vy[k] = inherit.y * .55 + 1.4 + Math.random() * 3.6;
			this.vz[k] = inherit.z * .85 + (Math.random() - .5) * 5.5;
			this.life[k] = 1.1 + Math.random() * 1.1;
		}
		this.geo.getAttribute("position").needsUpdate = true;
	}
	update(dt, bounce) {
		let any = false;
		for (let i = 0; i < this.n; i++) {
			if (this.life[i] <= 0) continue;
			any = true;
			this.life[i] -= dt;
			if (this.life[i] <= 0) {
				this.pos[i * 3 + 1] = 250;
				continue;
			}
			this.tmp.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
			this.vel.set(this.vx[i], this.vy[i], this.vz[i]);
			this.tmp.addScaledVector(this.vel, dt);
			this.vel.y -= 9.6 * dt;
			bounce(this.tmp, this.vel, .02);
			this.tmp.y = Math.max(.04, this.tmp.y);
			this.pos[i * 3] = this.tmp.x;
			this.pos[i * 3 + 1] = this.tmp.y;
			this.pos[i * 3 + 2] = this.tmp.z;
			this.vx[i] = this.vel.x;
			this.vy[i] = this.vel.y;
			this.vz[i] = this.vel.z;
		}
		if (any) this.geo.getAttribute("position").needsUpdate = true;
	}
	dispose() {
		this.geo.dispose();
		const mat = this.points.material;
		mat.map?.dispose();
		mat.dispose();
	}
};
var TireSmokeSystem = class {
	mesh;
	px;
	py;
	pz;
	vx;
	vy;
	vz;
	life;
	maxLife;
	size;
	dummy = new Object3D();
	n;
	cursor = 0;
	constructor(scene, n = 420) {
		this.n = n;
		this.px = new Float32Array(n);
		this.py = new Float32Array(n);
		this.pz = new Float32Array(n);
		this.vx = new Float32Array(n);
		this.vy = new Float32Array(n);
		this.vz = new Float32Array(n);
		this.life = new Float32Array(n);
		this.maxLife = new Float32Array(n);
		this.size = new Float32Array(n);
		const geo = new PlaneGeometry(1, 1);
		const mat = new MeshBasicMaterial({
			map: makeDotTexture("rgba(210,210,206,0.95)", "rgba(70,70,68,0.25)"),
			transparent: true,
			opacity: .85,
			depthWrite: false,
			blending: 1,
			side: 2
		});
		this.mesh = new InstancedMesh(geo, mat, n);
		this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
		this.mesh.frustumCulled = false;
		this.mesh.count = n;
		scene.add(this.mesh);
		this.hideAll();
	}
	hideAll() {
		this.dummy.scale.setScalar(.001);
		this.dummy.position.set(0, 250, 0);
		this.dummy.updateMatrix();
		for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
		this.mesh.instanceMatrix.needsUpdate = true;
	}
	reset() {
		this.life.fill(0);
		this.cursor = 0;
		this.hideAll();
	}
	emitAt(origin, inherit, count) {
		this.spawn(origin, inherit, count, .28, 1.2, .7);
	}
	plume(origin, inherit, count) {
		this.spawn(origin, inherit, count, .55, 2.2, 1.4);
	}
	spawn(origin, inherit, count, size, life, rise) {
		const n = Math.min(this.n, Math.max(0, Math.floor(count)));
		for (let i = 0; i < n; i++) {
			const k = this.cursor;
			this.cursor = (this.cursor + 1) % this.n;
			this.px[k] = origin.x + (Math.random() - .5) * .35;
			this.py[k] = Math.max(.08, origin.y);
			this.pz[k] = origin.z + (Math.random() - .5) * .35;
			this.vx[k] = inherit.x * .04 + (Math.random() - .5) * .22;
			this.vy[k] = rise + Math.random() * .7;
			this.vz[k] = inherit.z * .04 + (Math.random() - .5) * .22;
			const L = life + Math.random() * 1.1;
			this.life[k] = L;
			this.maxLife[k] = L;
			this.size[k] = size + Math.random() * .4;
		}
	}
	snapshot() {
		return snapshotPoints(this.px, this.py, this.pz, this.life, false);
	}
	update(dt, _bounce, camera) {
		const damp = Math.exp(-.7 * dt);
		for (let i = 0; i < this.n; i++) {
			if (this.life[i] <= 0) {
				this.dummy.position.set(0, 250, 0);
				this.dummy.scale.setScalar(.001);
				this.dummy.updateMatrix();
				this.mesh.setMatrixAt(i, this.dummy.matrix);
				continue;
			}
			this.life[i] -= dt;
			const fade = Math.max(0, this.life[i] / Math.max(this.maxLife[i], 1e-4));
			if (fade <= 0) {
				this.life[i] = 0;
				this.dummy.position.set(0, 250, 0);
				this.dummy.scale.setScalar(.001);
				this.dummy.updateMatrix();
				this.mesh.setMatrixAt(i, this.dummy.matrix);
				continue;
			}
			this.px[i] += this.vx[i] * dt;
			this.py[i] += this.vy[i] * dt;
			this.pz[i] += this.vz[i] * dt;
			this.vy[i] += .55 * dt;
			this.vx[i] *= damp;
			this.vz[i] *= damp;
			this.dummy.position.set(this.px[i], this.py[i], this.pz[i]);
			this.dummy.scale.setScalar(this.size[i] * (.7 + (1 - fade) * 1.8));
			this.dummy.quaternion.copy(camera.quaternion);
			this.dummy.updateMatrix();
			this.mesh.setMatrixAt(i, this.dummy.matrix);
			const g = .55 + fade * .4;
			this.mesh.setColorAt(i, _smokeColor.setRGB(g, g, g * .96));
		}
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
	}
	dispose() {
		this.mesh.geometry.dispose();
		const mat = this.mesh.material;
		mat.map?.dispose();
		mat.dispose();
	}
};
var _smokeColor = new Color();
var CrashAudio = class {
	ctx = null;
	unlocked = false;
	unlock() {
		if (this.unlocked) {
			this.ctx?.resume();
			return;
		}
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return;
		this.ctx = new AC();
		this.unlocked = true;
		this.ctx.resume();
	}
	impact(impulse) {
		if (!this.ctx) return;
		const ctx = this.ctx;
		const t = ctx.currentTime;
		const dur = .35 + Math.min(.4, impulse * .01);
		const thump = ctx.createOscillator();
		const thumpG = ctx.createGain();
		thump.type = "sine";
		thump.frequency.setValueAtTime(48, t);
		thump.frequency.exponentialRampToValueAtTime(22, t + dur);
		thumpG.gain.setValueAtTime(Math.min(.7, .22 + impulse * .012), t);
		thumpG.gain.exponentialRampToValueAtTime(.001, t + dur);
		thump.connect(thumpG).connect(ctx.destination);
		thump.start(t);
		thump.stop(t + dur);
		const noise = ctx.createBufferSource();
		const nbuf = ctx.createBuffer(1, ctx.sampleRate * .25, ctx.sampleRate);
		const data = nbuf.getChannelData(0);
		for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
		noise.buffer = nbuf;
		const ng = ctx.createGain();
		const bp = ctx.createBiquadFilter();
		bp.type = "bandpass";
		bp.frequency.value = 900;
		bp.Q.value = .7;
		ng.gain.setValueAtTime(Math.min(.45, .12 + impulse * .008), t);
		ng.gain.exponentialRampToValueAtTime(.001, t + .28);
		noise.connect(bp).connect(ng).connect(ctx.destination);
		noise.start(t);
	}
	dispose() {
		this.ctx?.close();
		this.ctx = null;
	}
};
//#endregion
export { CrashEngine };
