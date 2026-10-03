// Rust -> WASM port of the per-vertex skin (`StreamedDeformation.skin`) and `computeNormalsFast`.
// The same operations in the same order as the JS (f64 arithmetic, f32 stores), so the output is bit-identical to
// it. Raw exports, no wasm-bindgen and no allocator: JS owns the layout. `src/game/deform/skin-kernel.ts` carves
// the tables out of pages it grows (8-byte aligned, for the f64 views) and passes the addresses in. The wrinkle's
// `sin` and `exp` are V8's own `Math.sin` / `Math.exp` (imported), so they cannot drift.
// Build: `npm run build:kernel`. The committed `skin-kernel.wasm` is what the deploy box serves (it has no cargo).

#[inline(always)]
unsafe fn f(p: *const f64, i: usize) -> f64 {
    *p.add(i)
}

// ---- skin: the vertex loop of StreamedDeformation.skin -------------------------------------------------------
// params: [wrinkles(0/1), ampK, extraCap, cap, roofClamp(0/1), ix, iy, iz, shape(0/1)]
// hubs: 5 per mass [popped(0/1), local.x, rest.x, local.z, rest.z] (the JS adds them in its own order)
#[no_mangle]
pub unsafe extern "C" fn skin_shape(
    nverts: usize,
    rest: *const f32,
    r_c: *const f64,
    s_n: *const u8,
    s_xf: *const i32,
    s_w: *const f64,
    r_j: *const i32,
    r_w: *const f64,
    x: *const f64,
    pos: *const f64,
    i_n: *const u8,
    i_co: *const i32,
    i_uvw: *const f64,
    co: *const f64,
    skin_hub: *const i32,
    hubs: *const f64,
    wrinkle_seed: *const f64,
    params: *const f64,
    out: *mut f32,
) {
    let wrinkles = f(params, 0) != 0.0;
    let amp_k = f(params, 1);
    let extra_cap = f(params, 2);
    let cap = f(params, 3);
    let roof_clamp = f(params, 4) != 0.0;
    let (ix, iy, iz) = (f(params, 5), f(params, 6), f(params, 7));
    let shape = f(params, 8) != 0.0;
    let mut r = 0usize;
    for i in 0..nverts {
        let rx = *rest.add(r) as f64;
        let ry = *rest.add(r + 1) as f64;
        let rz = *rest.add(r + 2) as f64;
        let mut px = 0.0f64;
        let mut py = 0.0f64;
        let mut pz = 0.0f64;
        let n = if shape { *s_n.add(i) as usize } else { 0 };
        if n > 0 {
            // A5: the parents' positions plus the blended cluster map on the offset from their rest centroid.
            let dx = rx - f(r_c, r);
            let dy = ry - f(r_c, r + 1);
            let dz = rz - f(r_c, r + 2);
            let mut k = i * 5;
            let e = k + n;
            while k < e {
                let o = *s_xf.add(k) as usize;
                let w = f(s_w, k);
                px += (f(x, o) * dx + f(x, o + 1) * dy + f(x, o + 2) * dz) * w;
                py += (f(x, o + 3) * dx + f(x, o + 4) * dy + f(x, o + 5) * dz) * w;
                pz += (f(x, o + 6) * dx + f(x, o + 7) * dy + f(x, o + 8) * dz) * w;
                k += 1;
            }
            let mut k = i * 5;
            let e = k + 5;
            while k < e {
                let j = *r_j.add(k) as usize;
                let w = f(r_w, k);
                px += f(pos, j) * w;
                py += f(pos, j + 1) * w;
                pz += f(pos, j + 2) * w;
                k += 1;
            }
        } else {
            let mut k = i * 4;
            let e = k + *i_n.add(i) as usize;
            while k < e {
                let o = *i_co.add(k) as usize;
                let u = f(i_uvw, k * 4);
                let v = f(i_uvw, k * 4 + 1);
                let w = f(i_uvw, k * 4 + 2);
                let wt = f(i_uvw, k * 4 + 3);
                px += cage_axis(co, o, u, v, w) * wt;
                py += cage_axis(co, o + 8, u, v, w) * wt;
                pz += cage_axis(co, o + 16, u, v, w) * wt;
                k += 1;
            }
        }
        if wrinkles && ry > 0.34 {
            let dx = rx - ix;
            let dy = ry - iy;
            let dz = rz - iz;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 < 0.82 * 0.82 {
                let n0 = f(wrinkle_seed, i);
                let wave = js_sin(rz * 18.0 + n0 * 1.2);
                let amp = amp_k * js_exp(-d2.sqrt() * 3.4);
                // Math.sign(rx || 1): +1 for 0 and NaN.
                let sgn = if rx > 0.0 || rx.is_nan() { 1.0 } else if rx < 0.0 { -1.0 } else { 1.0 };
                let mut ox = sgn * n0 * amp * 0.12;
                let mut oy = wave.abs() * amp * 0.28;
                let mut oz = wave * amp;
                let extra = (ox * ox + oy * oy + oz * oz).sqrt();
                if extra > extra_cap {
                    let t = extra_cap / extra;
                    ox *= t;
                    oy *= t;
                    oz *= t;
                }
                px += ox;
                py += oy;
                pz += oz;
            }
        }
        let tx = px - rx;
        let ty = py - ry;
        let tz = pz - rz;
        let travel2 = tx * tx + ty * ty + tz * tz;
        if travel2 > cap * cap {
            let t = cap / travel2.sqrt();
            px = rx + tx * t;
            py = ry + ty * t;
            pz = rz + tz * t;
        }
        if roof_clamp && ry > 1.05 {
            // THREE.MathUtils.clamp(py, ry - 0.1, ry + 0.08)
            let lo = ry - 0.1;
            let hi = ry + 0.08;
            py = if py < lo { lo } else if py > hi { hi } else { py };
        }
        let h = *skin_hub.add(i);
        if h >= 0 {
            // Wheel arch: plant the paint at its rest offset from the hub (the hub's rest while the wheel is on).
            let hb = h as usize * 5;
            let popped = f(hubs, hb) != 0.0;
            let keep = if popped { 0.15 } else { 0.82 };
            let hx = if popped { rx + f(hubs, hb + 1) - f(hubs, hb + 2) } else { rx };
            let hz = if popped { rz + f(hubs, hb + 3) - f(hubs, hb + 4) } else { rz };
            px = px * (1.0 - keep) + hx * keep;
            pz = pz * (1.0 - keep) + hz * keep;
        }
        *out.add(i * 3) = px as f32;
        *out.add(i * 3 + 1) = py as f32;
        *out.add(i * 3 + 2) = pz as f32;
        r += 3;
    }
}

#[inline(always)]
unsafe fn cage_axis(co: *const f64, o: usize, u: f64, v: f64, w: f64) -> f64 {
    f(co, o) + u * f(co, o + 1) + v * (f(co, o + 2) + u * f(co, o + 4)) + w * (f(co, o + 3) + u * f(co, o + 5) + v * (f(co, o + 6) + u * f(co, o + 7)))
}

// ---- computeNormalsFast: area-weighted vertex normals ------------------------------------------------------
#[no_mangle]
pub unsafe extern "C" fn normals(pos: *const f32, idx: *const u32, tri_count: usize, nor: *mut f32, nfloats: usize) {
    for i in 0..nfloats {
        *nor.add(i) = 0.0;
    }
    let mut t = 0usize;
    while t + 2 < tri_count {
        let a = *idx.add(t) as usize * 3;
        let b = *idx.add(t + 1) as usize * 3;
        let c = *idx.add(t + 2) as usize * 3;
        let bx = *pos.add(b) as f64;
        let by = *pos.add(b + 1) as f64;
        let bz = *pos.add(b + 2) as f64;
        let cbx = *pos.add(c) as f64 - bx;
        let cby = *pos.add(c + 1) as f64 - by;
        let cbz = *pos.add(c + 2) as f64 - bz;
        let abx = *pos.add(a) as f64 - bx;
        let aby = *pos.add(a + 1) as f64 - by;
        let abz = *pos.add(a + 2) as f64 - bz;
        let nx = cby * abz - cbz * aby;
        let ny = cbz * abx - cbx * abz;
        let nz = cbx * aby - cby * abx;
        for v in [a, b, c] {
            *nor.add(v) = (*nor.add(v) as f64 + nx) as f32;
            *nor.add(v + 1) = (*nor.add(v + 1) as f64 + ny) as f32;
            *nor.add(v + 2) = (*nor.add(v + 2) as f64 + nz) as f32;
        }
        t += 3;
    }
    let mut i = 0usize;
    while i < nfloats {
        let x = *nor.add(i) as f64;
        let y = *nor.add(i + 1) as f64;
        let z = *nor.add(i + 2) as f64;
        let l = (x * x + y * y + z * z).sqrt();
        // JS: 1 / (Math.sqrt(...) || 1)
        let inv = 1.0 / (if l == 0.0 || l.is_nan() { 1.0 } else { l });
        *nor.add(i) = (x * inv) as f32;
        *nor.add(i + 1) = (y * inv) as f32;
        *nor.add(i + 2) = (z * inv) as f32;
        i += 3;
    }
}

// V8's own Math.sin / Math.exp.
#[link(wasm_import_module = "m")]
extern "C" {
    #[link_name = "sin"]
    fn js_sin_raw(x: f64) -> f64;
    #[link_name = "exp"]
    fn js_exp_raw(x: f64) -> f64;
}
#[inline(always)]
fn js_sin(x: f64) -> f64 {
    unsafe { js_sin_raw(x) }
}
#[inline(always)]
fn js_exp(x: f64) -> f64 {
    unsafe { js_exp_raw(x) }
}
