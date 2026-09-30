import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Textures } from './textures.js';

/**
 * Toy car models. By default a car is assembled from rounded primitives (chunky
 * plastic bevels, separate wheels, lights, a spoiler), which reads as a toy
 * rather than a box. If an artist supplies `assets/car.glb` it is used instead,
 * following this contract:
 *
 *  - Forward is +Z, up is +Y. Any scale/origin: it is normalised to a 2 m
 *    length sitting on the ground.
 *  - Bodywork that takes the player's colour uses a material named "Paint"
 *    (case-insensitive). Everything else keeps its own look, so tyres, glass and
 *    decals are never tinted.
 *  - Wheels are nodes named Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR with their
 *    origin at the wheel centre (so they can spin and, at the front, steer).
 */

export interface CarWheel {
  obj: THREE.Object3D;
  front: boolean;
}

/** One car instance in the scene. */
export interface CarRig {
  /** Origin on the ground under the car; +Z forward. */
  root: THREE.Group;
  /** This car's paint materials (tinted per player). */
  paint: THREE.MeshPhysicalMaterial[];
  wheels: CarWheel[];
  /** Wheel radius in metres, to turn ground speed into spin. */
  wheelRadius: number;
  dispose(): void;
}

const TARGET_LENGTH = 2.0;

export class CarFactory {
  private shared: {
    chassis: THREE.BufferGeometry;
    cabin: THREE.BufferGeometry;
    roof: THREE.BufferGeometry;
    stripe: THREE.BufferGeometry;
    wing: THREE.BufferGeometry;
    post: THREE.BufferGeometry;
    bumper: THREE.BufferGeometry;
    light: THREE.BufferGeometry;
    tyre: THREE.BufferGeometry;
    hub: THREE.BufferGeometry;
    blob: THREE.BufferGeometry;
    glass: THREE.Material;
    trim: THREE.Material;
    white: THREE.Material;
    head: THREE.Material;
    tail: THREE.Material;
    rubber: THREE.Material;
    hubMat: THREE.Material;
    blobMat: THREE.Material;
  };

  constructor(
    tex: Textures,
    /** Optional artist model (already loaded); null = build procedurally. */
    private readonly template: THREE.Object3D | null,
  ) {
    const axisX = (g: THREE.BufferGeometry) => g.rotateZ(Math.PI / 2);
    this.shared = {
      chassis: new RoundedBoxGeometry(0.96, 0.26, 1.92, 4, 0.09),
      cabin: new RoundedBoxGeometry(0.72, 0.24, 0.85, 4, 0.11),
      roof: new RoundedBoxGeometry(0.74, 0.05, 0.7, 2, 0.02),
      stripe: new THREE.BoxGeometry(0.16, 0.012, 1.02),
      wing: new RoundedBoxGeometry(1.0, 0.05, 0.26, 2, 0.02),
      post: new THREE.BoxGeometry(0.05, 0.2, 0.05),
      bumper: new RoundedBoxGeometry(0.98, 0.1, 0.13, 2, 0.04),
      light: new THREE.BoxGeometry(0.2, 0.08, 0.05),
      tyre: axisX(new THREE.CylinderGeometry(0.21, 0.21, 0.17, 20)),
      hub: axisX(new THREE.CylinderGeometry(0.11, 0.11, 0.19, 12)),
      blob: new THREE.PlaneGeometry(2.0, 3.1),
      glass: new THREE.MeshStandardMaterial({ color: 0x1b2a3c, roughness: 0.08, metalness: 0.6 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x1a1b20, roughness: 0.6 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf2f2f5, roughness: 0.4 }),
      head: new THREE.MeshStandardMaterial({ color: 0xfff4c8, emissive: 0xfff0b0, emissiveIntensity: 0.9 }),
      tail: new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff1a0a, emissiveIntensity: 0.8 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.92 }),
      hubMat: new THREE.MeshStandardMaterial({ color: 0xc9ccd4, roughness: 0.3, metalness: 0.8 }),
      blobMat: new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    };
    this.shared.blob.rotateX(-Math.PI / 2);
  }

  /** Does the loaded artist model follow the contract well enough to use? */
  static usable(template: THREE.Object3D): boolean {
    let paint = false;
    let wheels = 0;
    template.traverse((o) => {
      if (/^wheel[_ ]?[fr][lr]$/i.test(o.name)) wheels++;
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        if (/paint/i.test(m.name)) paint = true;
      }
    });
    return paint && wheels === 4;
  }

  create(color: number): CarRig {
    if (this.template) {
      try {
        return this.fromTemplate(color);
      } catch (err) {
        console.warn('[gfx] car model unusable, using the built-in car:', err);
      }
    }
    try {
      return this.procedural(color);
    } catch (err) {
      console.error('[gfx] could not build the car model; using a plain box:', err);
      return this.greybox(color);
    }
  }

  /** The original placeholder: a coloured box. Only used if everything else fails. */
  private greybox(color: number): CarRig {
    const paint = this.newPaint(color);
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 2), paint);
    body.position.y = 0.25;
    body.castShadow = true;
    root.add(body);
    return {
      root,
      paint: [paint],
      wheels: [],
      wheelRadius: 0.2,
      dispose: () => {
        body.geometry.dispose();
        paint.dispose();
      },
    };
  }

  private newPaint(color: number): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({ color, roughness: 0.36, metalness: 0.1, clearcoat: 0.7, clearcoatRoughness: 0.22 });
  }

  /**
   * The static bodywork (everything but the wheels) merged into one geometry per
   * material, built once and shared by every car. A car is then 6 meshes plus
   * its wheels instead of ~20, which matters with 8 cars and a shadow pass.
   */
  private bodyParts: { geom: THREE.BufferGeometry; mat: THREE.Material | 'paint'; cast: boolean }[] | null = null;

  private buildBodyParts(): NonNullable<CarFactory['bodyParts']> {
    const s = this.shared;
    type Part = [THREE.BufferGeometry, number, number, number];
    const groups: { mat: THREE.Material | 'paint'; cast: boolean; parts: Part[] }[] = [
      { mat: 'paint', cast: true, parts: [[s.chassis, 0, 0.26, 0], [s.roof, 0, 0.645, -0.12], [s.wing, 0, 0.58, -0.86]] },
      { mat: s.glass, cast: true, parts: [[s.cabin, 0, 0.51, -0.12]] },
      { mat: s.trim, cast: true, parts: [[s.bumper, 0, 0.2, 0.98], [s.bumper, 0, 0.2, -0.98], [s.post, 0.3, 0.46, -0.84], [s.post, -0.3, 0.46, -0.84]] },
      { mat: s.white, cast: false, parts: [[s.stripe, 0, 0.398, 0.55]] },
      { mat: s.head, cast: false, parts: [[s.light, 0.3, 0.3, 0.97], [s.light, -0.3, 0.3, 0.97]] },
      { mat: s.tail, cast: false, parts: [[s.light, 0.3, 0.3, -0.97], [s.light, -0.3, 0.3, -0.97]] },
    ];
    return groups.map((g) => ({
      mat: g.mat,
      cast: g.cast,
      // Normalise to non-indexed first: RoundedBoxGeometry and BoxGeometry differ,
      // and mergeGeometries refuses to mix the two.
      geom: mergeGeometries(
        g.parts.map(([geom, x, y, z]) => (geom.index ? geom.toNonIndexed() : geom.clone()).translate(x, y, z)),
        false,
      )!,
    }));
  }

  private procedural(color: number): CarRig {
    const s = this.shared;
    const root = new THREE.Group();
    const paint = this.newPaint(color);
    this.bodyParts ??= this.buildBodyParts();
    for (const part of this.bodyParts) {
      const m = new THREE.Mesh(part.geom, part.mat === 'paint' ? paint : part.mat);
      m.castShadow = part.cast;
      root.add(m);
    }

    const wheels: CarWheel[] = [];
    for (const [x, z, front] of [[0.53, 0.62, true], [-0.53, 0.62, true], [0.53, -0.62, false], [-0.53, -0.62, false]] as const) {
      const w = new THREE.Group();
      w.position.set(x, 0.21, z);
      w.rotation.order = 'YXZ';
      const tyre = new THREE.Mesh(s.tyre, s.rubber);
      const hub = new THREE.Mesh(s.hub, s.hubMat);
      tyre.castShadow = true;
      w.add(tyre, hub);
      root.add(w);
      wheels.push({ obj: w, front });
    }

    const blob = new THREE.Mesh(s.blob, s.blobMat);
    blob.position.y = 0.03;
    root.add(blob);

    return { root, paint: [paint], wheels, wheelRadius: 0.21, dispose: () => paint.dispose() };
  }

  private fromTemplate(color: number): CarRig {
    const model = this.template!.clone(true);
    const paints: THREE.MeshPhysicalMaterial[] = [];
    const wheels: CarWheel[] = [];
    model.traverse((o) => {
      if (/^wheel[_ ]?[fr][lr]$/i.test(o.name)) {
        o.rotation.order = 'YXZ';
        wheels.push({ obj: o, front: /^wheel[_ ]?f/i.test(o.name) });
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      const swap = (m: THREE.Material): THREE.Material => {
        if (!/paint/i.test(m.name)) return m;
        const src = m as THREE.MeshStandardMaterial;
        const p = this.newPaint(color);
        p.map = src.map ?? null;
        p.normalMap = src.normalMap ?? null;
        p.name = m.name;
        paints.push(p);
        return p;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    if (paints.length === 0 || wheels.length !== 4) throw new Error('model has no Paint material or four wheels');

    // Normalise: 2 m long, sitting on the ground, centred.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const k = TARGET_LENGTH / Math.max(size.z, 1e-6);
    const holder = new THREE.Group();
    model.scale.setScalar(k);
    model.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    holder.add(model);

    const root = new THREE.Group();
    root.add(holder);
    const blob = new THREE.Mesh(this.shared.blob, this.shared.blobMat);
    blob.position.y = 0.03;
    root.add(blob);

    const wheelBox = new THREE.Box3().setFromObject(wheels[0]!.obj);
    // Bounds are in world space, so the normalising scale is already included.
    const radius = Math.max(0.1, (wheelBox.max.y - wheelBox.min.y) / 2);
    return { root, paint: paints, wheels, wheelRadius: radius, dispose: () => paints.forEach((p) => p.dispose()) };
  }
}
