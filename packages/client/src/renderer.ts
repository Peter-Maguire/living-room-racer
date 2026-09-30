import * as THREE from 'three';
import type { CarPhase, Quat, Track, Vec3 } from '@racer/shared';

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
  /**
   * Body colour (packed RGB) from the server-assigned palette index. Every
   * client renders a given player in the same colour, so colours are a reliable
   * way to refer to opponents.
   */
  color: number;
}

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
/** Overlay colours for tagged road sections (floor is the plain asphalt). */
/** Base road colour by the track's default surface. */
const BASE_ROAD_COLOR: Record<string, number> = {
  floor: 0x33343a,
  wood: 0x5a4028,
  rug: 0x7a4a3a,
  tile: 0x56606e,
  milk: 0xd8d4c8,
  cushion: 0x6a5478,
};
const SURFACE_TINT: Partial<Record<string, { color: number; opacity: number }>> = {
  rug: { color: 0xa0522d, opacity: 0.85 },
  tile: { color: 0x9fb4c8, opacity: 0.5 },
  milk: { color: 0xf4f1e8, opacity: 0.75 },
  cushion: { color: 0x8a6a9a, opacity: 0.8 },
  wood: { color: 0x8b5a2b, opacity: 0.6 },
};
/** Resting vertical FOV; speed/boost widen it temporarily for a sense of speed. */
const BASE_FOV = 50;
const MAX_SPEED_FOV_KICK = 4;
const BOOST_FOV_KICK = 3;
const BOOST_SHAKE = 0.18;

/**
 * three.js rendering layer. Top-down camera looking at the track. It draws a
 * mesh per car from a unified RenderCar list: the local car comes from client
 * prediction, remote cars from entity interpolation.
 */
export class Renderer {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private carMeshes = new Map<string, THREE.Mesh>();
  private carGeometry = new THREE.BoxGeometry(1, 0.5, 2);
  private pickupMeshes: THREE.Mesh[] = [];
  /** All track geometry (ribbon, finish line, pads) so it can be rebuilt. */
  private trackGroup: THREE.Group | null = null;
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

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Shadows are the cheapest way to make the cars feel like physical objects
    // sitting on a floor rather than sprites floating above it.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Steep top-down perspective camera (Micro Machines style). Position is set
    // by frameCamera() once a track is loaded, so it adapts to track size.
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 46, 18);
    this.camera.lookAt(0, 0, 0);

    this.scene.background = new THREE.Color(0x202028);

    // Lighting: a warm overhead "lamp" key that casts shadows, plus a cool
    // hemisphere fill so shadowed sides read as indoor bounce light rather than
    // going flat black. Reads as "indoors" far better than a single white light.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x35502f, 0.55));
    this.keyLight = new THREE.DirectionalLight(0xfff2d6, 1.15);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    // Bias tuned to kill shadow acne on the near-flat track ribbon without
    // detaching contact shadows from the cars casting them.
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    // A DirectionalLight aims at its target object, which must be in the scene.
    this.scene.add(this.keyLight.target);

    // Living-room "floor" the track sits on (the off-track area).
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.95 }),
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

    window.addEventListener('resize', () => this.onResize());
  }

  /**
   * Build a visible track surface from the SAME geometry the physics uses: a
   * ribbon along the recovery-spline centerline, `trackHalfWidth` to each side.
   * This makes the drivable corridor visible so players can see where "off
   * track" begins, and it exactly matches the collision test.
   */
  buildTrack(track: Track): void {
    // Clear any previously-built track (track switch in the lobby).
    if (this.trackGroup) {
      this.disposeGroup(this.trackGroup);
      this.scene.remove(this.trackGroup);
    }
    const group = new THREE.Group();
    this.trackGroup = group;
    this.scene.add(group);

    const half = track.trackHalfWidth ?? 4;
    const spline = track.recoverySpline;
    const n = spline.length;

    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < n; i++) {
      const cur = spline[i]!.position;
      const next = spline[(i + 1) % n]!.position;
      // Tangent along the line, then the left-hand normal in the XZ plane.
      let tx = next.x - cur.x;
      let tz = next.z - cur.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const nx = -tz; // perpendicular
      const nz = tx;

      // Two edge vertices (left/right of centerline) per sample. Height comes
      // from the racing line; banking raises one edge and lowers the other.
      const rise = Math.tan(spline[i]!.bank) * half;
      positions.push(cur.x + nx * half, cur.y + rise, cur.z + nz * half);
      positions.push(cur.x - nx * half, cur.y - rise, cur.z - nz * half);
    }

    // Stitch consecutive rib pairs into quads (two triangles), wrapping around.
    for (let i = 0; i < n; i++) {
      const a = (i * 2) % (n * 2);
      const b = (i * 2 + 1) % (n * 2);
      const c = ((i + 1) * 2) % (n * 2);
      const d = ((i + 1) * 2 + 1) % (n * 2);
      indices.push(a, b, c);
      indices.push(b, d, c);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        // Dark asphalt by default, clearly distinct from the floor; other default
        // surfaces (e.g. a tiled kitchen) recolour the whole road.
        color: BASE_ROAD_COLOR[track.defaultSurface] ?? 0x33343a,
        roughness: 0.8,
        side: THREE.DoubleSide,
      }),
    );
    mesh.receiveShadow = true;
    group.add(mesh);

    // Surface tints: each tagged section gets a coloured overlay so players can
    // read where grip changes. A tile/floor-only track adds nothing here.
    for (const sec of track.surfaces) {
      const tint = SURFACE_TINT[sec.surface];
      if (!tint) continue;
      const overlay = this.buildSectionMesh(track, sec.from, sec.to, half, tint);
      if (overlay) group.add(overlay);
    }

    // Start/finish line marker at the finish checkpoint.
    const finish = track.checkpoints.find((c) => c.isFinish);
    if (finish) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(half * 2, 0.6),
        new THREE.MeshStandardMaterial({ color: 0xffffff }),
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(finish.center.x, 0.01, finish.center.z);
      line.receiveShadow = true;
      group.add(line);
    }

    // Pickup pads: floating gold octahedra spun for a bit of life.
    this.pickupMeshes = track.pickups.map((p) => {
      const pad = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.7),
        new THREE.MeshStandardMaterial({
          color: 0xffcc33,
          emissive: 0x554400,
        }),
      );
      pad.position.set(p.x, p.y + 0.6, p.z);
      pad.castShadow = true;
      group.add(pad);
      return pad;
    });

    // Fit camera, floor, and shadow frustum to this track's actual extents so
    // switching tracks (or adding new ones) doesn't need hand-tuned numbers.
    this.trackBounds = computeTrackBounds(track, half);
    this.fitToTrack();
  }

  /** A ribbon over the spline samples in [from, to) (wrapping), slightly above the road. */
  private buildSectionMesh(
    track: Track,
    from: number,
    to: number,
    half: number,
    tint: { color: number; opacity: number },
  ): THREE.Mesh | null {
    const spline = track.recoverySpline;
    const n = spline.length;
    const inside = (t: number) => (from <= to ? t >= from && t < to : t >= from || t < to);
    // Sample indices in driving order, including one past the end to close the gap.
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = k;
      if (inside(spline[i]!.t)) idx.push(i);
    }
    if (idx.length < 2) return null;
    // Rotate so a wrapping section starts at its first in-range sample.
    const start = idx.findIndex((_, j) => (idx[j]! + 1) % n !== idx[(j + 1) % idx.length]);
    const ordered = start >= 0 ? [...idx.slice(start + 1), ...idx.slice(0, start + 1)] : idx;
    ordered.push((ordered[ordered.length - 1]! + 1) % n);

    const positions: number[] = [];
    const indices: number[] = [];
    ordered.forEach((i, r) => {
      const cur = spline[i]!.position;
      const next = spline[(i + 1) % n]!.position;
      let tx = next.x - cur.x;
      let tz = next.z - cur.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const rise = Math.tan(spline[i]!.bank) * half;
      positions.push(cur.x - tz * half, cur.y + rise + 0.02, cur.z + tx * half);
      positions.push(cur.x + tz * half, cur.y - rise + 0.02, cur.z - tx * half);
      if (r > 0) {
        const a = (r - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: tint.color,
        roughness: 0.5,
        transparent: true,
        opacity: tint.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Point the camera, floor, and shadow camera at the loaded track. */
  private fitToTrack(): void {
    const b = this.trackBounds;
    if (!b) return;

    this.frameCamera(b);

    // Floor large enough that its edge is never visible past the track.
    this.ground.scale.set(b.halfX * 4, b.halfZ * 4, 1);
    this.ground.position.set(b.centerX, -0.02, b.centerZ);

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
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  /** Show/hide + spin pickup pads based on active state from the snapshot. */
  setPickups(active: boolean[], now: number): void {
    for (let i = 0; i < this.pickupMeshes.length; i++) {
      const pad = this.pickupMeshes[i]!;
      pad.visible = active[i] ?? true;
      pad.rotation.y = now * 0.002;
    }
  }

  /** Update rendered car meshes from the unified render list for this frame. */
  setCars(cars: RenderCar[]): void {
    const present = new Set<string>();
    let localSeen = false;

    for (const car of cars) {
      present.add(car.playerId);
      let mesh = this.carMeshes.get(car.playerId);
      if (!mesh) {
        // Each car owns its material so it can carry its own palette colour.
        // Geometry stays shared (see removeCar, which only disposes material).
        mesh = new THREE.Mesh(
          this.carGeometry,
          new THREE.MeshStandardMaterial({
            color: car.color,
            roughness: 0.45,
            metalness: 0.1,
          }),
        );
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.carMeshes.set(car.playerId, mesh);
      }
      mesh.position.set(car.position.x, car.position.y + 0.25, car.position.z);
      if (car.pitch || car.roll) {
        // Yaw from the car's heading, then lie on the road: pitch (x) and roll (z).
        const yaw = 2 * Math.atan2(car.rotation.y, car.rotation.w);
        mesh.rotation.set(-(car.pitch ?? 0), yaw, car.roll ?? 0, 'YXZ');
      } else {
        mesh.quaternion.set(car.rotation.x, car.rotation.y, car.rotation.z, car.rotation.w);
      }

      const mat = mesh.material as THREE.MeshStandardMaterial;
      // Re-apply the colour every frame: lobby state (which carries the palette
      // index) can arrive after the mesh was first created, and colours are
      // reassigned when a player leaves and their slot is reused.
      mat.color.setHex(car.color);
      // Dim cars that are being recovered; make boosting cars glow.
      mat.opacity = car.phase === 'recovering' ? 0.4 : 1;
      mat.transparent = car.phase === 'recovering';
      mat.emissive.setHex(car.boosting ? 0x33ccff : 0x000000);
      const boostScale = car.boosting ? 1.15 : 1;
      mesh.scale.set(boostScale, boostScale, boostScale);

      if (car.isLocal) {
        localSeen = true;
        this.localRing.position.set(car.position.x, car.position.y + 0.04, car.position.z);
      }
    }

    // Only show the "you" ring when the local car is actually on screen.
    this.localRing.visible = localSeen;

    // Remove meshes for players no longer present (e.g. disconnected),
    // disposing their GPU resources so they don't leak.
    for (const [playerId, mesh] of this.carMeshes) {
      if (!present.has(playerId)) {
        this.removeCar(playerId, mesh);
      }
    }
  }

  private removeCar(playerId: string, mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    // The car geometry is shared across meshes, so only dispose the material.
    (mesh.material as THREE.Material).dispose();
    this.carMeshes.delete(playerId);
  }

  render(): void {
    // Ease the FOV toward its target so the kick swells rather than snaps.
    const target =
      this.fxSpeed * MAX_SPEED_FOV_KICK + (this.fxBoosting ? BOOST_FOV_KICK : 0);
    this.fovKick += (target - this.fovKick) * 0.08;
    const fov = BASE_FOV + this.fovKick;
    if (Math.abs(fov - this.camera.fov) > 0.005) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // Shake only while boosting; otherwise rest exactly on the framed position.
    if (this.fxBoosting && this.trackBounds) {
      this.camera.position.set(
        this.camBase.x + (Math.random() - 0.5) * BOOST_SHAKE,
        this.camBase.y + (Math.random() - 0.5) * BOOST_SHAKE,
        this.camBase.z + (Math.random() - 0.5) * BOOST_SHAKE,
      );
    } else if (this.trackBounds) {
      this.camera.position.copy(this.camBase);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Aspect changed, so the fit has to be recomputed or the track gets cropped.
    if (this.trackBounds) this.frameCamera(this.trackBounds);
    else this.camera.updateProjectionMatrix();
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
