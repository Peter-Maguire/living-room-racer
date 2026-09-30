import * as THREE from 'three';
import type { Textures } from './textures.js';

/**
 * Visual effects: GPU-cheap particles (drift smoke, boost flame, sparks), skid
 * marks, and the recovery claw. Particle pools and skid buffers are fixed-size
 * ring buffers, so effects can never grow memory or draw calls no matter how
 * long a race runs or how many cars are sliding.
 */

// --- particles ------------------------------------------------------------------

export interface Emit {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size0: number; size1: number;
  color: number;
  alpha: number;
}

const VERT = `
  attribute float size;
  attribute float alpha;
  attribute vec3 pcolor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = alpha;
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = `
  uniform sampler2D map;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor, vAlpha * t.a);
  }
`;

/** A fixed-size pool of camera-facing soft particles drawn in one call. */
export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly geom = new THREE.BufferGeometry();
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly col: Float32Array;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tmp = new THREE.Color();
  /** Gravity-ish pull on particles (m/s^2, negative = falls). */
  gravity = 0;
  /** Velocity damping per second (0 = none). */
  drag = 0;

  constructor(max: number, map: THREE.Texture, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(Infinity);
    this.life = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uScale: { value: 400 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    // Particles move every frame; skip culling against the initial (empty) bounds.
    this.points.frustumCulled = false;
  }

  /** Pixels-per-world-unit scale at distance 1, from the viewport and FOV. */
  setScale(viewportHeightPx: number, fovDeg: number): void {
    this.mat.uniforms.uScale!.value = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(e: Emit): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = e.x; this.pos[i * 3 + 1] = e.y; this.pos[i * 3 + 2] = e.z;
    this.vel[i * 3] = e.vx; this.vel[i * 3 + 1] = e.vy; this.vel[i * 3 + 2] = e.vz;
    this.age[i] = 0;
    this.life[i] = e.life;
    this.s0[i] = e.size0; this.s1[i] = e.size1; this.a0[i] = e.alpha;
    this.tmp.setHex(e.color);
    this.col[i * 3] = this.tmp.r; this.col[i * 3 + 1] = this.tmp.g; this.col[i * 3 + 2] = this.tmp.b;
  }

  update(dt: number): void {
    const damp = Math.max(0, 1 - this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      const a = this.age[i]! + dt;
      this.age[i] = a;
      const life = this.life[i]!;
      if (a >= life) {
        this.alpha[i] = 0;
        continue;
      }
      const f = a / life;
      this.vel[i * 3] = this.vel[i * 3]! * damp;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2]! * damp;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * damp + this.gravity * dt;
      this.pos[i * 3] = this.pos[i * 3]! + this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
      this.size[i] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * f;
      // Quick fade-in, long fade-out.
      this.alpha[i] = this.a0[i]! * Math.min(1, f * 8) * (1 - f);
    }
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.pcolor as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}

// --- skid marks ------------------------------------------------------------------------

/** Rubber streaks left on the road, as a ring buffer of quads in one mesh. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly max: number;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly geom = new THREE.BufferGeometry();
  /** Last point per tracked wheel, to extend its streak. */
  private last = new Map<string, { x: number; y: number; z: number }>();

  constructor(max: number, tex: Textures) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    const uv = new Float32Array(max * 4 * 2);
    const idx: number[] = [];
    for (let i = 0; i < max; i++) {
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
      const v = i * 4;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geom.setIndex(idx);
    this.mesh = new THREE.Mesh(
      this.geom,
      new THREE.MeshBasicMaterial({
        map: tex.skid,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Extend the streak for wheel `key` to (x,y,z), or end it when not sliding. */
  mark(key: string, x: number, y: number, z: number, sliding: boolean, width = 0.16): void {
    const prev = this.last.get(key);
    if (!sliding) {
      this.last.delete(key);
      return;
    }
    this.last.set(key, { x, y, z });
    if (!prev) return;
    const dx = x - prev.x;
    const dz = z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || len > 3) return; // too short to draw, or a teleport (respawn)
    const nx = (-dz / len) * width;
    const nz = (dx / len) * width;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const y0 = prev.y + 0.045;
    const y1 = y + 0.045;
    this.pos.set(
      [prev.x - nx, y0, prev.z - nz, prev.x + nx, y0, prev.z + nz, x - nx, y1, z - nz, x + nx, y1, z + nz],
      i * 12,
    );
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.pos.fill(0);
    this.last.clear();
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// --- recovery claw -------------------------------------------------------------------------

/**
 * The claw that picks a fallen car up off the floor. Purely visual: the server
 * decides when and where the car is re-dropped; this just shows a hand coming
 * down, grabbing, and lifting during the recovery window.
 */
export class Claw {
  readonly group = new THREE.Group();
  private readonly prongs: THREE.Object3D[] = [];
  private readonly arm: THREE.Mesh;

  constructor() {
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9bfcb, metalness: 0.85, roughness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x33363e, metalness: 0.5, roughness: 0.5 });
    // A long cable/arm running up out of view.
    this.arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 14, 8), dark);
    this.arm.position.y = 7.4;
    this.group.add(this.arm);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), metal);
    hub.castShadow = true;
    this.group.add(hub);
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = (i / 3) * Math.PI * 2;
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.12), metal);
      finger.position.set(0, -0.45, 0);
      finger.castShadow = true;
      const arm = new THREE.Group();
      arm.position.set(0.22, 0, 0);
      arm.add(finger);
      pivot.add(arm);
      this.group.add(pivot);
      this.prongs.push(arm);
    }
    this.group.visible = false;
  }

  /**
   * p: progress 0..1 through the recovery. Returns how far the car should be
   * lifted (metres) so the caller can raise it with the claw.
   */
  update(x: number, y: number, z: number, p: number): number {
    if (p <= 0 || p >= 1) {
      this.group.visible = false;
      return 0;
    }
    this.group.visible = true;
    const reach = 4.2; // height the claw hovers at
    const grab = 0.3;
    const lift = 0.78;
    let h: number; // claw hub height above the car
    let open: number;
    if (p < grab) {
      const k = p / grab; // descend
      h = 0.55 + (reach - 0.55) * (1 - k * k);
      open = 0.9;
    } else if (p < lift) {
      const k = (p - grab) / (lift - grab); // close and rise with the car
      h = 0.55 + k * 2.6;
      open = 0.9 - Math.min(1, k * 4) * 0.75;
    } else {
      const k = (p - lift) / (1 - lift); // release and retract
      h = 0.55 + 2.6 + k * 2;
      open = 0.15 + k * 0.75;
    }
    this.group.position.set(x, y + h + 0.3, z);
    for (const a of this.prongs) {
      a.rotation.z = -open * 0.6; // fingers swing out (open) or in (closed)
      a.position.x = 0.14 + open * 0.42;
    }
    // The car rides the claw between grab and release.
    return p < grab ? 0 : p < lift ? (p - grab) / (lift - grab) * 2.6 : 2.6;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
