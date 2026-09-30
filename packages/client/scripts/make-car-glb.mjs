// Writes a minimal toy-car GLB that follows the car model contract (see
// src/gfx/cars.ts): a "Paint" material for the tinted bodywork, and
// Wheel_FL / Wheel_FR / Wheel_RL / Wheel_RR nodes centred on each wheel.
//
// It exists to exercise the asset pipeline end to end and to give artists a
// working reference file. The default game does NOT ship this (the built-in
// procedural car looks better); drop a real model at public/assets/car.glb.
//
//   node scripts/make-car-glb.mjs [out.glb]
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'car.glb';

// --- tiny geometry helpers --------------------------------------------------
function box(w, h, d) {
  const [x, y, z] = [w / 2, h / 2, d / 2];
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  const pos = [], nor = [], idx = [];
  for (const f of faces) {
    const base = pos.length / 3;
    for (const p of f.v) { pos.push(...p); nor.push(...f.n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nor, idx };
}

/** A cylinder whose axis runs along X (a wheel). */
function wheel(r, len, seg = 14) {
  const pos = [], nor = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const y = Math.cos(a) * r, z = Math.sin(a) * r;
    const base = pos.length / 3;
    pos.push(-len / 2, y, z, len / 2, y, z);
    nor.push(0, Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a));
    if (i > 0) idx.push(base - 2, base - 1, base, base - 1, base + 1, base);
  }
  for (const sx of [-1, 1]) {
    const c = pos.length / 3;
    pos.push(sx * len / 2, 0, 0);
    nor.push(sx, 0, 0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(sx * len / 2, Math.cos(a) * r, Math.sin(a) * r);
      nor.push(sx, 0, 0);
      if (i > 0) idx.push(c, c + i, c + i + 1);
    }
  }
  return { pos, nor, idx };
}

// --- assemble the glTF ---------------------------------------------------------
const materials = [
  { name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0.1, roughnessFactor: 0.4 } },
  { name: 'Glass', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.16, 0.24, 1], metallicFactor: 0.6, roughnessFactor: 0.1 } },
  { name: 'Rubber', pbrMetallicRoughness: { baseColorFactor: [0.08, 0.08, 0.09, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
];
const parts = [
  { name: 'Body', geo: box(0.96, 0.28, 1.92), mat: 0, t: [0, 0.26, 0] },
  { name: 'Cabin', geo: box(0.7, 0.24, 0.8), mat: 1, t: [0, 0.52, -0.1] },
  { name: 'Roof', geo: box(0.72, 0.05, 0.68), mat: 0, t: [0, 0.66, -0.1] },
  { name: 'Wheel_FL', geo: wheel(0.21, 0.17), mat: 2, t: [0.53, 0.21, 0.62] },
  { name: 'Wheel_FR', geo: wheel(0.21, 0.17), mat: 2, t: [-0.53, 0.21, 0.62] },
  { name: 'Wheel_RL', geo: wheel(0.21, 0.17), mat: 2, t: [0.53, 0.21, -0.62] },
  { name: 'Wheel_RR', geo: wheel(0.21, 0.17), mat: 2, t: [-0.53, 0.21, -0.62] },
];

const chunks = [];
const bufferViews = [], accessors = [], meshes = [], nodes = [];
let offset = 0;
const push = (typed, target) => {
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (buf.length % 4)) % 4;
  chunks.push(buf, Buffer.alloc(pad));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
  offset += buf.length + pad;
  return bufferViews.length - 1;
};

parts.forEach((p, i) => {
  const pos = new Float32Array(p.geo.pos), nor = new Float32Array(p.geo.nor), idx = new Uint16Array(p.geo.idx);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[k + c]); max[c] = Math.max(max[c], pos[k + c]); }
  const bvP = push(pos, 34962), bvN = push(nor, 34962), bvI = push(idx, 34963);
  const aP = accessors.push({ bufferView: bvP, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }) - 1;
  const aN = accessors.push({ bufferView: bvN, componentType: 5126, count: nor.length / 3, type: 'VEC3' }) - 1;
  const aI = accessors.push({ bufferView: bvI, componentType: 5123, count: idx.length, type: 'SCALAR' }) - 1;
  meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: aP, NORMAL: aN }, indices: aI, material: p.mat }] });
  nodes.push({ name: p.name, mesh: i, translation: p.t });
});
nodes.push({ name: 'ToyCar', children: parts.map((_, i) => i) });

const json = {
  asset: { version: '2.0', generator: 'make-car-glb.mjs' },
  scene: 0,
  scenes: [{ nodes: [nodes.length - 1] }],
  nodes, meshes, materials, accessors, bufferViews,
  buffers: [{ byteLength: offset }],
};

const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const bin = Buffer.concat(chunks);
const total = 12 + 8 + jsonBuf.length + jsonPad.length + 8 + bin.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length + jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(out, Buffer.concat([header, jh, jsonBuf, jsonPad, bh, bin]));
console.log(`wrote ${out} (${total} bytes)`);
