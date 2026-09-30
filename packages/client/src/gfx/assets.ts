import type * as THREE from 'three';
import { CarFactory } from './cars.js';

/**
 * Asset loading. There is no shipped art yet, so the game draws procedural
 * models and textures; but if artists drop files into `public/assets/` they are
 * picked up here with no code change. A missing or broken file is never fatal:
 * every asset has a built-in fallback, so a bad deploy yields a plainer game
 * rather than a blank screen.
 *
 * Optional files:
 *  - assets/car.glb   toy car (see the contract in cars.ts). Draco-compressed
 *                     files work; the decoder is fetched on demand.
 */

export interface Assets {
  /** Loaded car model, or null to build the default one. */
  car: THREE.Object3D | null;
  /** Human-readable notes for the console (what loaded, what fell back). */
  notes: string[];
}

/** glTF binary files start with the ASCII magic "glTF". */
function isGlb(buf: ArrayBuffer): boolean {
  return buf.byteLength > 12 && new DataView(buf).getUint32(0, true) === 0x46546c67;
}

/** Fetch an optional binary asset; null if it doesn't exist (or isn't what it claims). */
async function fetchOptional(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Dev servers answer unknown paths with index.html (status 200), so check
    // the content rather than trusting the status code.
    return isGlb(buf) ? buf : null;
  } catch {
    return null;
  }
}

async function parseGlb(buf: ArrayBuffer): Promise<THREE.Object3D> {
  // Loaded on demand: most players have no car.glb, so they never download these.
  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
  ]);
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);
  return new Promise((resolve, reject) => {
    loader.parse(
      buf,
      '',
      (gltf) => {
        draco.dispose();
        resolve(gltf.scene);
      },
      (err) => {
        draco.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Load everything the scene wants, reporting progress for the loading screen.
 * Always resolves: failures are logged and replaced by fallbacks.
 */
export async function loadAssets(onProgress: (message: string) => void = () => {}): Promise<Assets> {
  const notes: string[] = [];
  let car: THREE.Object3D | null = null;

  onProgress('Loading car model…');
  const buf = await fetchOptional(`${import.meta.env.BASE_URL}assets/car.glb`);
  if (buf) {
    try {
      const scene = await parseGlb(buf);
      if (CarFactory.usable(scene)) {
        car = scene;
        notes.push('car.glb loaded');
      } else {
        notes.push('car.glb ignored: needs a "Paint" material and Wheel_FL/FR/RL/RR nodes');
      }
    } catch (err) {
      notes.push(`car.glb failed to parse (${err instanceof Error ? err.message : String(err)}); using the built-in car`);
    }
  } else {
    notes.push('no car.glb; using the built-in car');
  }

  for (const n of notes) console.info('[assets]', n);
  onProgress('Ready');
  return { car, notes };
}
