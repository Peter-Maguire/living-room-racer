import * as THREE from 'three';
import {
  HAZARDS,
  RECOVERY_LIFT_SECONDS,
  hasRelief,
  trackSampleAt,
  type CarPhase,
  type HazardState,
  type HazardType,
  type Quat,
  type Track,
  type Vec3,
} from '@racer/shared';
import type { Assets } from './gfx/assets.js';
import { CarFactory, type CarRig } from './gfx/cars.js';
import { Claw, Particles, SkidMarks } from './gfx/effects.js';
import { buildScenery } from './gfx/scenery.js';
import { buildTextures, disposeTextures, type Textures } from './gfx/textures.js';
import { buildTrackMeshes } from './gfx/trackMesh.js';

/** A car to draw this frame, from prediction (local) or interpolation (remote). */
export interface RenderCar {
  playerId: string;
  position: Vec3;
  rotation: Quat;
  phase: CarPhase;
  isLocal: boolean;
  /** True while boosting, for a visual highlight. */
  boosting: boolean;
  /** Tilt to lie on ramps and banks: pitch (nose up +) and roll (right side up +), radians. */
  pitch?: number;
  roll?: number;
  /** Active effect types, for visual flourishes (e.g. a scrambled car flickers). */
  effects?: string[];
  /** Signed speed along the heading (m/s), for wheel spin and smoke. */
  speed?: number;
  /** How sideways the car is sliding, 0..1, for tyre smoke and skid marks. */
  slip?: number;
  /**
   * Body colour (packed RGB) from the server-assigned palette index. Every
   * client renders a given player in the same colour, so colours are a reliable
   * way to refer to opponents.
   */
  color: number;
}

/** Render cost, for the ?debug overlay. */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

export type Quality = 'high' | 'low';

/** Axis-aligned XZ extent of a track, used to frame the camera and shadows. */
interface TrackBounds {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
}

/**
 * How far the camera leans back from straight-down, in degrees. Matches the
 * original hand-tuned framing (atan(18/46) ~= 21 degrees) but is now applied
 * relative to whatever track is loaded.
 */
const CAMERA_TILT_DEG = 21;

/** Extra room around the track extents so cars near the edge aren't clipped. */
const CAMERA_MARGIN = 1.18;
/** Resting vertical FOV; speed/boost widen it temporarily for a sense of speed. */
const BASE_FOV = 50;
const MAX_SPEED_FOV_KICK = 4;
const BOOST_FOV_KICK = 3;
const BOOST_SHAKE = 0.18;
/** Metres of floorboard pattern per texture repeat. */
const FLOOR_TILE = 3.4;

/** Per-car animation state that outlives a frame. */
interface RigState {
  rig: CarRig;
  wheelAngle: number;
  prevYaw: number | null;
  steer: number;
  recoveryStart: number | null;
  claw: Claw | null;
  /** Smoothed yaw rate (rad/s), for cornering smoke and skid marks. */
  yawRate: number;
}

/**
 * three.js rendering layer. Top-down camera looking at the track. It draws a
 * model per car from a unified RenderCar list: the local car comes from client
 * prediction, remote cars from entity interpolation.
 */
export class Renderer {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private textures: Textures;
  private carFactory: CarFactory;
  private rigs = new Map<string, RigState>();
  private pickupMeshes: THREE.Mesh[] = [];
  /** Oil, tape and marbles, by server id. Geometry and materials are shared per type. */
  private hazardMeshes = new Map<number, THREE.Mesh>();
  private hazardAssets = new Map<HazardType, { geom: THREE.BufferGeometry; mat: THREE.Material }>();
  private track: Track | null = null;
  /** All track geometry (road, curbs, pads) so it can be rebuilt. */
  private trackGroup: THREE.Group | null = null;
  private sceneryGroup: THREE.Group | null = null;
  /** Warm key light; also the shadow caster, refitted per track. */
  private keyLight: THREE.DirectionalLight;
  /** Floor plane, kept so it can be resized to cover larger tracks. */
  private ground: THREE.Mesh;
  /**
   * Floor ring drawn under the local player's car. Necessary because every car
   * now has its own palette colour, so "the blue one is me" no longer holds.
   */
  private localRing: THREE.Mesh;
  /** Extents of the currently loaded track, for camera + shadow fitting. */
  private trackBounds: TrackBounds | null = null;
  /** Camera rest position (shake is applied around it). */
  private camBase = new THREE.Vector3();
  private fxSpeed = 0;
  private fxBoosting = false;
  private fovKick = 0;
  /** Dev camera (?cam=follow): hover close behind the focused car instead of framing the track. */
  private followCam = false;
  private focus: THREE.Vector3 | null = null;

  // Effects (high quality only).
  private smoke: Particles | null = null;
  private flame: Particles | null = null;
  private sparks: Particles | null = null;
  private skids: SkidMarks | null = null;
  private lastFrame = performance.now();
  private readonly tmpV = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    assets: Assets,
    private readonly quality: Quality = 'high',
  ) {
    const hi = quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: hi, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, hi ? 2 : 1));
    // Filmic tone mapping keeps the warm lamp and bright props from clipping.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // Shadows are the cheapest way to make the cars feel like physical objects
    // sitting on a floor rather than sprites floating above it.
    this.renderer.shadowMap.enabled = hi;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.textures = buildTextures(this.renderer.capabilities.getMaxAnisotropy());
    this.carFactory = new CarFactory(this.textures, assets.car);

    // Steep top-down perspective camera (Micro Machines style). Position is set
    // by frameCamera() once a track is loaded, so it adapts to track size.
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 46, 18);
    this.camera.lookAt(0, 0, 0);

    this.scene.background = new THREE.Color(0x1a1714);

    // Lighting: a warm overhead "lamp" key that casts shadows, a cool window
    // fill from the opposite side, and a hemisphere bounce so shadowed sides
    // read as indoor light rather than going flat black.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x6a5646, 0.62));
    this.keyLight = new THREE.DirectionalLight(0xffe9c4, 1.35);
    this.keyLight.castShadow = hi;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    // Bias tuned to kill shadow acne on the near-flat track ribbon without
    // detaching contact shadows from the cars casting them.
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    // A DirectionalLight aims at its target object, which must be in the scene.
    this.scene.add(this.keyLight.target);
    const fill = new THREE.DirectionalLight(0x9fbfff, 0.35);
    fill.position.set(-30, 40, -20);
    this.scene.add(fill);

    // The room's floor: wooden boards, the off-track area.
    const floorTex = this.textures.floorWood;
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.78 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.ground.receiveShadow = true;
    this.ground.scale.set(80, 60, 1);
    this.scene.add(this.ground);

    this.localRing = new THREE.Mesh(
      new THREE.RingGeometry(1.15, 1.45, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        // Drawn flat on the track; skip depth writes so it never z-fights.
        depthWrite: false,
      }),
    );
    this.localRing.rotation.x = -Math.PI / 2;
    this.localRing.visible = false;
    this.scene.add(this.localRing);

    if (hi) {
      this.smoke = new Particles(260, this.textures.puff, false);
      this.flame = new Particles(200, this.textures.puff, true);
      this.sparks = new Particles(200, this.textures.puff, true);
      this.sparks.gravity = -9;
      this.smoke.drag = 1.6;
      this.flame.drag = 2;
      this.skids = new SkidMarks(700, this.textures);
      this.scene.add(this.smoke.points, this.flame.points, this.sparks.points, this.skids.mesh);
      this.updateParticleScale();
    }

    window.addEventListener('resize', () => this.onResize());
  }

  /**
   * Build a visible track surface from the SAME geometry the physics uses: a
   * ribbon along the recovery-spline centerline, `trackHalfWidth` to each side.
   * This makes the drivable corridor visible so players can see where "off
   * track" begins, and it exactly matches the collision test.
   */
  buildTrack(track: Track): void {
    this.track = track;
    this.clearHazards();
    this.skids?.clear();
    // Clear any previously-built track (track switch in the lobby).
    if (this.trackGroup) {
      this.disposeGroup(this.trackGroup);
      this.scene.remove(this.trackGroup);
    }
    if (this.sceneryGroup) {
      this.disposeGroup(this.sceneryGroup);
      this.scene.remove(this.sceneryGroup);
      this.sceneryGroup = null;
    }

    const built = buildTrackMeshes(track, this.textures);
    this.trackGroup = built.group;
    this.scene.add(built.group);
    this.pickupMeshes = built.pads;
    for (const pad of built.pads) pad.userData.baseY = pad.position.y;

    // Fit camera, floor, and shadow frustum to this track's actual extents so
    // switching tracks (or adding new ones) doesn't need hand-tuned numbers.
    this.trackBounds = computeTrackBounds(track, track.trackHalfWidth ?? 4);
    this.fitToTrack();

    if (this.quality === 'high') {
      this.sceneryGroup = buildScenery(track, this.textures, this.trackBounds).group;
      this.scene.add(this.sceneryGroup);
    }
  }

  /** Point the camera, floor, and shadow camera at the loaded track. */
  private fitToTrack(): void {
    const b = this.trackBounds;
    if (!b) return;

    this.frameCamera(b);

    // Floor large enough that its edge is never visible past the track.
    const fw = b.halfX * 4;
    const fh = b.halfZ * 4;
    this.ground.scale.set(fw, fh, 1);
    this.ground.position.set(b.centerX, -0.02, b.centerZ);
    // Keep the floorboards a constant real-world size however big the floor is.
    this.textures.floorWood.repeat.set(fw / FLOOR_TILE, fh / FLOOR_TILE);

    // Key light sits up and to one side of the track center, aimed at it.
    const reach = Math.max(b.halfX, b.halfZ);
    this.keyLight.position.set(
      b.centerX + reach * 0.6,
      reach * 1.7,
      b.centerZ + reach * 0.5,
    );
    this.keyLight.target.position.set(b.centerX, 0, b.centerZ);
    this.keyLight.target.updateMatrixWorld();

    // Orthographic shadow frustum fitted to the track: a tight fit is what
    // keeps shadow texels small enough to read as contact shadows under cars.
    const shadowCam = this.keyLight.shadow.camera;
    const extent = reach * 1.35;
    shadowCam.left = -extent;
    shadowCam.right = extent;
    shadowCam.top = extent;
    shadowCam.bottom = -extent;
    shadowCam.near = 1;
    shadowCam.far = reach * 4.5;
    shadowCam.updateProjectionMatrix();
  }

  /**
   * Place the camera so the whole track fits on screen at the current aspect
   * ratio. Distance is solved separately for the horizontal and vertical field
   * of view and the larger taken, so neither axis is cropped.
   *
   * The depth (Z) extent is fitted against the vertical FOV without correcting
   * for the camera tilt. Tilt compresses depth on screen, so this over-fits
   * slightly — deliberately conservative, since cropping the track is far worse
   * than a little extra padding.
   */
  private frameCamera(b: TrackBounds): void {
    const vFov = (BASE_FOV * Math.PI) / 180;
    // Fit against the resting FOV so the speed kick can't feed back into framing.
    const aspect = this.camera.aspect;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distForWidth = (b.halfX * CAMERA_MARGIN) / Math.tan(hFov / 2);
    const distForDepth = (b.halfZ * CAMERA_MARGIN) / Math.tan(vFov / 2);
    const dist = Math.max(distForWidth, distForDepth);

    const tilt = (CAMERA_TILT_DEG * Math.PI) / 180;
    this.camera.position.set(
      b.centerX,
      Math.cos(tilt) * dist,
      b.centerZ + Math.sin(tilt) * dist,
    );
    this.camBase.copy(this.camera.position);
    this.camera.lookAt(b.centerX, 0, b.centerZ);
    this.camera.updateProjectionMatrix();
  }

  /** Local car's normalised speed (0..1) and boost state, driving camera FX. */
  setSpeedFx(speedNorm: number, boosting: boolean): void {
    this.fxSpeed = Math.max(0, Math.min(1, speedNorm));
    this.fxBoosting = boosting;
  }

  /** Dispose all geometries/materials under a group before removing it. */
  private disposeGroup(group: THREE.Group): void {
    group.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  private hazardAsset(type: HazardType): { geom: THREE.BufferGeometry; mat: THREE.Material } {
    let a = this.hazardAssets.get(type);
    if (a) return a;
    const r = HAZARDS[type].radius;
    if (type === 'oil') {
      // A dark, glossy puddle.
      a = {
        geom: new THREE.CylinderGeometry(r, r, 0.05, 28),
        mat: new THREE.MeshStandardMaterial({ color: 0x14141c, emissive: 0x0a0a22, roughness: 0.08, metalness: 0.85 }),
      };
    } else if (type === 'tape') {
      // A strip of sticky tape, tan with a slight sheen.
      a = {
        geom: new THREE.BoxGeometry(r * 2.2, 0.05, r * 1.4),
        mat: new THREE.MeshStandardMaterial({ color: 0xd9c38a, roughness: 0.35, transparent: true, opacity: 0.92 }),
      };
    } else {
      // A glass marble.
      a = {
        geom: new THREE.SphereGeometry(r, 20, 14),
        mat: new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x113355, roughness: 0.08, metalness: 0.2 }),
      };
    }
    this.hazardAssets.set(type, a);
    return a;
  }

  private clearHazards(): void {
    for (const m of this.hazardMeshes.values()) this.scene.remove(m);
    this.hazardMeshes.clear();
  }

  /**
   * Draw the server's hazards. Marbles move fast (26 m/s) and snapshots are
   * discrete, so they are extrapolated along their velocity since the last
   * snapshot (capped, in case packets stall).
   */
  setHazards(hazards: HazardState[], snapshotAt: number, now: number): void {
    const since = Math.min(0.15, Math.max(0, (now - snapshotAt) / 1000));
    const seen = new Set<number>();
    for (const h of hazards) {
      seen.add(h.id);
      let mesh = this.hazardMeshes.get(h.id);
      if (!mesh) {
        const a = this.hazardAsset(h.type);
        mesh = new THREE.Mesh(a.geom, a.mat);
        mesh.castShadow = h.type === 'marble';
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.hazardMeshes.set(h.id, mesh);
      }
      const x = h.x + h.vx * since;
      const z = h.z + h.vz * since;
      const floor = this.track && hasRelief(this.track) ? trackSampleAt(this.track, { x, z }).y : 0;
      const lift = h.type === 'marble' ? HAZARDS.marble.radius : 0.06;
      mesh.position.set(x, floor + lift, z);
      if (h.type === 'marble') mesh.rotation.x = now / 50; // rolling
    }
    for (const [id, mesh] of this.hazardMeshes) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      this.hazardMeshes.delete(id);
    }
  }

  /** Show/hide + spin pickup boxes based on active state from the snapshot. */
  setPickups(active: boolean[], now: number): void {
    for (let i = 0; i < this.pickupMeshes.length; i++) {
      const pad = this.pickupMeshes[i]!;
      pad.visible = active[i] ?? true;
      pad.rotation.y = now * 0.0015 + i;
      // A gentle bob so the boxes read as things to drive into.
      pad.position.y = (pad.userData.baseY as number) + Math.sin(now / 420 + i * 1.7) * 0.12;
    }
  }

  /** Update rendered cars from the unified render list for this frame. */
  setCars(cars: RenderCar[]): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const present = new Set<string>();
    let localSeen = false;

    for (const car of cars) {
      present.add(car.playerId);
      let st = this.rigs.get(car.playerId);
      if (!st) {
        const rig = this.carFactory.create(car.color);
        this.scene.add(rig.root);
        st = { rig, wheelAngle: 0, prevYaw: null, steer: 0, recoveryStart: null, claw: null, yawRate: 0 };
        this.rigs.set(car.playerId, st);
      }
      const { rig } = st;
      const yaw = 2 * Math.atan2(car.rotation.y, car.rotation.w);

      // --- recovery: the claw comes down, grabs, lifts ---------------------------------
      let lift = 0;
      if (car.phase === 'recovering') {
        st.recoveryStart ??= now;
        const p = (now - st.recoveryStart) / (RECOVERY_LIFT_SECONDS * 1000);
        if (!st.claw) {
          st.claw = new Claw();
          this.scene.add(st.claw.group);
        }
        lift = st.claw.update(car.position.x, car.position.y, car.position.z, p);
      } else {
        st.recoveryStart = null;
        if (st.claw) st.claw.update(0, 0, 0, 0);
      }

      rig.root.position.set(car.position.x, car.position.y + lift, car.position.z);
      if (car.pitch || car.roll) {
        // Yaw from the car's heading, then lie on the road: pitch (x) and roll (z).
        rig.root.rotation.set(-(car.pitch ?? 0), yaw, car.roll ?? 0, 'YXZ');
      } else {
        rig.root.quaternion.set(car.rotation.x, car.rotation.y, car.rotation.z, car.rotation.w);
      }
      // A car hanging in the claw swings a little.
      if (lift > 0) rig.root.rotation.z += Math.sin(now / 130) * 0.08;

      // --- paint and status glow -----------------------------------------------------------
      const flicker = car.effects?.includes('scramble') && Math.sin(now / 55) > 0;
      const glow = car.boosting ? 0x33ccff : flicker ? 0xffdd33 : 0x000000;
      for (const p of rig.paint) {
        // Re-apply the colour every frame: lobby state (which carries the palette
        // index) can arrive after the car was first created, and colours are
        // reassigned when a player leaves and their slot is reused.
        p.color.setHex(car.color);
        p.emissive.setHex(glow);
        p.emissiveIntensity = car.boosting ? 0.55 : 0.8;
      }
      const s = car.boosting ? 1.06 : 1;
      rig.root.scale.set(s, s, s);

      // --- wheels: spin with speed, front pair steers into the turn --------------------------
      const speed = car.speed ?? 0;
      st.wheelAngle += (speed * dt) / rig.wheelRadius;
      let dyaw = st.prevYaw === null ? 0 : yaw - st.prevYaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      st.prevYaw = yaw;
      st.yawRate += ((dyaw / dt) - st.yawRate) * Math.min(1, dt * 8);
      const target = Math.max(-0.5, Math.min(0.5, (dyaw / dt) * 0.18));
      st.steer += (target - st.steer) * Math.min(1, dt * 12);
      for (const w of rig.wheels) {
        w.obj.rotation.x = st.wheelAngle;
        if (w.front) w.obj.rotation.y = st.steer;
      }

      // --- effects ------------------------------------------------------------------------------
      if (car.phase === 'racing') {
        // Sliding sideways (slick surfaces) or cornering hard at speed both squeal.
        const cornering = Math.min(1, (Math.abs(st.yawRate) * Math.abs(speed)) / 60);
        this.carEffects(car, rig, yaw, speed, Math.max(car.slip ?? 0, cornering));
      }
      if (car.isLocal) this.focus = (this.focus ?? new THREE.Vector3()).set(car.position.x, car.position.y, car.position.z);

      if (car.isLocal) {
        localSeen = true;
        this.localRing.position.set(car.position.x, car.position.y + 0.06, car.position.z);
      }
    }

    // Only show the "you" ring when the local car is actually on screen.
    this.localRing.visible = localSeen;

    // Remove cars for players no longer present (e.g. disconnected),
    // disposing their GPU resources so they don't leak.
    for (const [playerId, st] of this.rigs) {
      if (!present.has(playerId)) this.removeCar(playerId, st);
    }
  }

  /** Tyre smoke and skid marks while sliding, exhaust flame on boost, sparks when shocked. */
  private carEffects(car: RenderCar, rig: CarRig, yaw: number, speed: number, slip: number): void {
    if (!this.smoke || !this.flame || !this.sparks || !this.skids) return;
    rig.root.updateMatrixWorld(true);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const sliding = slip > 0.2 && Math.abs(speed) > 3;

    for (const side of [-1, 1] as const) {
      const w = this.tmpV.set(side * 0.53, 0.05, -0.62);
      rig.root.localToWorld(w);
      this.skids.mark(`${car.playerId}:${side}`, w.x, w.y, w.z, sliding && slip > 0.3);
      if (sliding && Math.random() < 0.6 + slip) {
        this.smoke.emit({
          x: w.x, y: w.y + 0.1, z: w.z,
          vx: (Math.random() - 0.5) * 0.8 - fx * speed * 0.05, vy: 0.4 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.8 - fz * speed * 0.05,
          life: 0.7 + Math.random() * 0.5, size0: 0.9, size1: 3.2, color: 0xdedcd6, alpha: 0.5,
        });
      }
    }

    if (car.boosting) {
      const p = this.tmpV.set(0, 0.32, -1.08);
      rig.root.localToWorld(p);
      for (let i = 0; i < 2; i++) {
        this.flame.emit({
          x: p.x, y: p.y, z: p.z,
          vx: -fx * (5 + Math.random() * 3) + (Math.random() - 0.5), vy: (Math.random() - 0.5) * 0.6, vz: -fz * (5 + Math.random() * 3) + (Math.random() - 0.5),
          life: 0.12 + Math.random() * 0.1, size0: 0.7, size1: 0.1, color: i ? 0xffd27a : 0x63c7ff, alpha: 0.95,
        });
      }
    }

    if (car.effects?.includes('scramble') && Math.random() < 0.7) {
      this.sparks.emit({
        x: car.position.x + (Math.random() - 0.5) * 1.2, y: car.position.y + 0.5 + Math.random() * 0.5, z: car.position.z + (Math.random() - 0.5) * 1.6,
        vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 4,
        life: 0.35, size0: 0.28, size1: 0.05, color: 0xffe36a, alpha: 1,
      });
    }
  }

  /** A burst of sparks at a collision (strength 0..1). */
  burst(x: number, y: number, z: number, strength: number): void {
    if (!this.sparks) return;
    const n = 6 + Math.round(strength * 18);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * (4 + strength * 5);
      this.sparks.emit({
        x, y: y + 0.4, z,
        vx: Math.cos(a) * sp, vy: 2 + Math.random() * 3, vz: Math.sin(a) * sp,
        life: 0.3 + Math.random() * 0.3, size0: 0.3, size1: 0.05, color: 0xffd98a, alpha: 1,
      });
    }
  }

  private removeCar(playerId: string, st: RigState): void {
    this.scene.remove(st.rig.root);
    // Geometry and most materials are shared across cars; only per-car paint is disposed.
    st.rig.dispose();
    if (st.claw) {
      this.scene.remove(st.claw.group);
      st.claw.dispose();
    }
    this.rigs.delete(playerId);
  }

  render(): void {
    const dt = Math.min(0.1, Math.max(0.001, (performance.now() - this.lastFrame) / 1000));
    this.smoke?.update(dt);
    this.flame?.update(dt);
    this.sparks?.update(dt);

    // Ease the FOV toward its target so the kick swells rather than snaps.
    const target =
      this.fxSpeed * MAX_SPEED_FOV_KICK + (this.fxBoosting ? BOOST_FOV_KICK : 0);
    this.fovKick += (target - this.fovKick) * 0.08;
    const fov = BASE_FOV + this.fovKick;
    if (Math.abs(fov - this.camera.fov) > 0.005) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
    // Shake only while boosting; otherwise rest exactly on the framed position.
    if (this.fxBoosting && this.trackBounds) {
      this.camera.position.set(
        this.camBase.x + (Math.random() - 0.5) * BOOST_SHAKE,
        this.camBase.y + (Math.random() - 0.5) * BOOST_SHAKE,
        this.camBase.z + (Math.random() - 0.5) * BOOST_SHAKE,
      );
    } else if (this.trackBounds && !this.followCam) {
      this.camera.position.copy(this.camBase);
    }
    if (this.followCam && this.focus) {
      const want = new THREE.Vector3(this.focus.x, this.focus.y + 9, this.focus.z + 7);
      this.camera.position.lerp(want, 0.2);
      this.camera.lookAt(this.focus);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Dev camera: follow the local car closely (used to inspect models and effects). */
  setFollowCamera(on: boolean): void {
    this.followCam = on;
  }

  /** Draw-call and memory counts from the last frame, for the ?debug overlay. */
  getStats(): RenderStats {
    const i = this.renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
    };
  }

  private updateParticleScale(): void {
    const h = this.renderer.domElement.height || window.innerHeight;
    for (const p of [this.smoke, this.flame, this.sparks]) p?.setScale(h, this.camera.fov);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.updateParticleScale();
    // Aspect changed, so the fit has to be recomputed or the track gets cropped.
    if (this.trackBounds) this.frameCamera(this.trackBounds);
    else this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    disposeTextures(this.textures);
  }
}

/**
 * XZ extents of the drivable corridor: the racing line expanded by the track
 * half-width, which is exactly the area the physics treats as on-track.
 */
function computeTrackBounds(track: Track, half: number): TrackBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of track.recoverySpline) {
    minX = Math.min(minX, p.position.x);
    maxX = Math.max(maxX, p.position.x);
    minZ = Math.min(minZ, p.position.z);
    maxZ = Math.max(maxZ, p.position.z);
  }
  // Guard against a degenerate track so the camera can't end up at infinity.
  if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
    return { centerX: 0, centerZ: 0, halfX: 20, halfZ: 15 };
  }
  minX -= half;
  maxX += half;
  minZ -= half;
  maxZ += half;
  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    halfX: Math.max((maxX - minX) / 2, 1),
    halfZ: Math.max((maxZ - minZ) / 2, 1),
  };
}
