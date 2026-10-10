import { Quaternion, type Euler, type Vector3 } from "three";
import { detCos, detSin, sinCosAt } from "./physics-core.js";

/** `setFromEuler`'s half angles in [x/2, _, y/2, _, z/2, _], their [sin, cos] pairs out (`sinCosAt`: no boxed argument or result). */
const _half = new Float64Array(6);

/**
 * three's `Quaternion.setFromEuler`, `setFromAxisAngle` and `slerp`, term for term in three's own order, with the sines and cosines
 * from the kernel's `detSin`/`detCos`. The engines' `Math.sin`/`Math.cos` differ in the last bit (V8 and SpiderMonkey round some
 * angles differently), and every car pose the sim sets from its Euler angles (`group.rotation.set(pitch, yaw, roll, "YXZ")`) goes
 * through `setFromEuler`: with the built-in trig a clip recorded in Chromium replayed differently in Firefox from frame 302 on
 * (CrossEngine, 1200 frames, 16 cars). With these in place every engine computes the same pose bits.
 *
 * Installed on three's prototype when this module is imported (a side-effect module: import it before anything that builds a
 * quaternion at load), so every caller, sim or drawing, gets the same law.
 */
function setFromEuler(this: Quaternion, euler: Euler, update = true): Quaternion {
  const e = euler as unknown as { _x: number; _y: number; _z: number; _order: string };
  const q = this as unknown as { _x: number; _y: number; _z: number; _w: number; _onChangeCallback: () => void };
  _half[0] = e._x / 2;
  _half[2] = e._y / 2;
  _half[4] = e._z / 2;
  sinCosAt(_half, 0);
  sinCosAt(_half, 2);
  sinCosAt(_half, 4);
  const s1 = _half[0]!;
  const c1 = _half[1]!;
  const s2 = _half[2]!;
  const c2 = _half[3]!;
  const s3 = _half[4]!;
  const c3 = _half[5]!;
  switch (e._order) {
    case "XYZ":
      q._x = s1 * c2 * c3 + c1 * s2 * s3;
      q._y = c1 * s2 * c3 - s1 * c2 * s3;
      q._z = c1 * c2 * s3 + s1 * s2 * c3;
      q._w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case "YXZ":
      q._x = s1 * c2 * c3 + c1 * s2 * s3;
      q._y = c1 * s2 * c3 - s1 * c2 * s3;
      q._z = c1 * c2 * s3 - s1 * s2 * c3;
      q._w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case "ZXY":
      q._x = s1 * c2 * c3 - c1 * s2 * s3;
      q._y = c1 * s2 * c3 + s1 * c2 * s3;
      q._z = c1 * c2 * s3 + s1 * s2 * c3;
      q._w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case "ZYX":
      q._x = s1 * c2 * c3 - c1 * s2 * s3;
      q._y = c1 * s2 * c3 + s1 * c2 * s3;
      q._z = c1 * c2 * s3 - s1 * s2 * c3;
      q._w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    case "YZX":
      q._x = s1 * c2 * c3 + c1 * s2 * s3;
      q._y = c1 * s2 * c3 + s1 * c2 * s3;
      q._z = c1 * c2 * s3 - s1 * s2 * c3;
      q._w = c1 * c2 * c3 - s1 * s2 * s3;
      break;
    case "XZY":
      q._x = s1 * c2 * c3 - c1 * s2 * s3;
      q._y = c1 * s2 * c3 - s1 * c2 * s3;
      q._z = c1 * c2 * s3 + s1 * s2 * c3;
      q._w = c1 * c2 * c3 + s1 * s2 * s3;
      break;
    default:
      throw new Error(`Quaternion.setFromEuler: unknown order ${e._order}`);
  }
  if (update) q._onChangeCallback();
  return this;
}

function setFromAxisAngle(this: Quaternion, axis: Vector3, angle: number): Quaternion {
  const q = this as unknown as { _x: number; _y: number; _z: number; _w: number; _onChangeCallback: () => void };
  const halfAngle = angle / 2;
  const s = detSin(halfAngle);
  q._x = axis.x * s;
  q._y = axis.y * s;
  q._z = axis.z * s;
  q._w = detCos(halfAngle);
  q._onChangeCallback();
  return this;
}

/** three's `slerp` with the sines from `detSin` (`Math.acos` and `Math.sqrt` agree across engines, measured). */
function slerp(this: Quaternion, qb: Quaternion, t: number): Quaternion {
  const q = this as unknown as { _x: number; _y: number; _z: number; _w: number; _onChangeCallback: () => void };
  const b = qb as unknown as { _x: number; _y: number; _z: number; _w: number };
  let x = b._x;
  let y = b._y;
  let z = b._z;
  let w = b._w;
  let dot = this.dot(qb);
  if (dot < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
    dot = -dot;
  }
  let s = 1 - t;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const sin = detSin(theta);
    s = detSin(s * theta) / sin;
    t = detSin(t * theta) / sin;
    q._x = q._x * s + x * t;
    q._y = q._y * s + y * t;
    q._z = q._z * s + z * t;
    q._w = q._w * s + w * t;
    q._onChangeCallback();
  } else {
    q._x = q._x * s + x * t;
    q._y = q._y * s + y * t;
    q._z = q._z * s + z * t;
    q._w = q._w * s + w * t;
    this.normalize();
  }
  return this;
}

// Installed at import, so every module that imports this one first (the car module, the tests) builds its constants on it.
const proto = Quaternion.prototype as unknown as { setFromEuler: unknown; setFromAxisAngle: unknown; slerp: unknown };
proto.setFromEuler = setFromEuler;
proto.setFromAxisAngle = setFromAxisAngle;
proto.slerp = slerp;
