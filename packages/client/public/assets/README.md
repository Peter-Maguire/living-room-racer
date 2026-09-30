# Optional art assets

Drop files here to replace the game's built-in (procedurally generated) art. Nothing
here is required: a missing or broken file is logged to the console and the built-in
version is used instead.

## `car.glb` — the toy car

glTF binary (`.glb`). Draco-compressed files work. Contract:

- **Forward is +Z, up is +Y.** Any scale and origin; it is normalised to a 2 m long
  car sitting on the ground.
- **Bodywork that takes the player's colour** uses a material named **`Paint`**
  (case-insensitive). Everything else keeps its own look, so tyres, glass and
  decals are never tinted. Base-colour and normal maps on the Paint material are kept.
- **Wheels** are four nodes named **`Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR`**
  with their origin at the wheel centre, so they can spin (and the front pair steer).

`node scripts/make-car-glb.mjs out.glb` writes a minimal valid example to start from.
See `src/gfx/cars.ts` for the loader.
