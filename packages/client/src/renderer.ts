import * as THREE from 'three';
import type { CarPhase, Quat, Track, Vec3 } from '@racer/shared';

/** A car to draw this frame, from prediction (local) or interpolation (remote). */
export interface RenderCar {
  playerId: string;
  position: Vec3;
  rotation: Quat;
  phase: CarPhase;
  isLocal: boolean;
}

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

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Steep top-down perspective camera (Micro Machines style), framed high
    // enough to keep the whole oval (~38m x 22m) in view.
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 46, 18);
    this.camera.lookAt(0, 0, 0);

    this.scene.background = new THREE.Color(0x202028);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    // Living-room "floor" the track sits on (the off-track area).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 60),
      new THREE.MeshStandardMaterial({ color: 0x2f6b3f }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);

    window.addEventListener('resize', () => this.onResize());
  }

  /**
   * Build a visible track surface from the SAME geometry the physics uses: a
   * ribbon along the recovery-spline centerline, `trackHalfWidth` to each side.
   * This makes the drivable corridor visible so players can see where "off
   * track" begins, and it exactly matches the collision test.
   */
  buildTrack(track: Track): void {
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

      // Two edge vertices (left/right of centerline) per sample.
      positions.push(cur.x + nx * half, 0, cur.z + nz * half);
      positions.push(cur.x - nx * half, 0, cur.z - nz * half);
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
        color: 0x33343a, // dark asphalt, clearly distinct from the floor
        side: THREE.DoubleSide,
      }),
    );
    this.scene.add(mesh);

    // Start/finish line marker at the finish checkpoint.
    const finish = track.checkpoints.find((c) => c.isFinish);
    if (finish) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(half * 2, 0.6),
        new THREE.MeshStandardMaterial({ color: 0xffffff }),
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(finish.center.x, 0.01, finish.center.z);
      this.scene.add(line);
    }
  }

  /** Update rendered car meshes from the unified render list for this frame. */
  setCars(cars: RenderCar[]): void {
    const present = new Set<string>();
    for (const car of cars) {
      present.add(car.playerId);
      let mesh = this.carMeshes.get(car.playerId);
      if (!mesh) {
        mesh = new THREE.Mesh(
          this.carGeometry,
          new THREE.MeshStandardMaterial({
            // Local car is a distinct color so you can spot yourself.
            color: car.isLocal ? 0x3388ff : 0xff5533,
          }),
        );
        this.scene.add(mesh);
        this.carMeshes.set(car.playerId, mesh);
      }
      mesh.position.set(car.position.x, car.position.y + 0.25, car.position.z);
      mesh.quaternion.set(
        car.rotation.x,
        car.rotation.y,
        car.rotation.z,
        car.rotation.w,
      );
      // Dim cars that are being recovered.
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = car.phase === 'recovering' ? 0.4 : 1;
      mat.transparent = car.phase === 'recovering';
    }

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
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
