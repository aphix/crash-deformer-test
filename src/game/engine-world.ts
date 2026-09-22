import * as THREE from "three";

function makeConcrete(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b7b1a4";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    const n = Math.random();
    ctx.fillStyle = n > 0.55 ? `rgba(255,255,255,${n * 0.07})` : `rgba(30,26,22,${(1 - n) * 0.1})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, n > 0.88 ? 3 : 1, 1);
  }
  ctx.fillStyle = "rgba(40,38,34,0.18)";
  ctx.fillRect(0, 200, 256, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeAsphalt(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#17181d";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const n = Math.random();
    ctx.fillStyle = `rgba(255,255,255,${n * 0.045})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, n > 0.8 ? 2 : 1, 1);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 18);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeJerseyBarrier(): THREE.Group {
  const g = new THREE.Group();
  g.name = "jersey-barrier";

  const shape = new THREE.Shape();
  shape.moveTo(-0.305, 0);
  shape.lineTo(0.305, 0);
  shape.lineTo(0.305, 0.075);
  shape.lineTo(0.215, 0.33);
  shape.lineTo(0.075, 0.81);
  shape.lineTo(-0.075, 0.81);
  shape.lineTo(-0.215, 0.33);
  shape.lineTo(-0.305, 0.075);
  shape.closePath();

  const concreteTex = makeConcrete();
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xc4bfb3,
    roughness: 0.94,
    metalness: 0.05,
    map: concreteTex,
  });
  const weathered = new THREE.MeshStandardMaterial({
    color: 0xaea99d,
    roughness: 0.96,
    metalness: 0.04,
    map: concreteTex,
  });
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x5c5852,
    roughness: 0.8,
    metalness: 0.2,
  });

  const segLen = 1.78;
  for (const [zOff, mat] of [
    [-0.95, concrete],
    [0.95, weathered],
  ] as const) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: segLen, bevelEnabled: false, steps: 1 });
    geo.translate(0, 0, -segLen / 2);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = zOff;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.rest = (geo.getAttribute("position") as THREE.BufferAttribute).array.slice();
    g.add(mesh);
  }

  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 8), jointMat);
  pin.position.set(0, 0.09, 0);
  pin.castShadow = true;
  g.add(pin);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), jointMat);
  cap.position.set(0, 0.82, 0);
  g.add(cap);
  return g;
}

export function restoreBarrierRest(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const rest = obj.userData.rest as Float32Array | undefined;
    if (!rest) return;
    const geo = obj.geometry as THREE.BufferGeometry;
    const attr = geo.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(rest);
    attr.needsUpdate = true;
    geo.computeVertexNormals();
  });
}

export function makeLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.7, metalness: 0.4 }),
  );
  pole.position.y = 2.6;
  pole.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.1, 0.22),
    new THREE.MeshStandardMaterial({
      color: 0xf0e6c8,
      emissive: 0xf0e6c8,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    }),
  );
  head.position.set(0, 5.15, 0.15);
  g.add(pole, head);
  return g;
}
