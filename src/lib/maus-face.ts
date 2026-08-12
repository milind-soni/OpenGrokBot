import {
  centroid,
  clamp,
  GAZE_X,
  GAZE_Y,
  mouthFrame,
  mouthPath,
  SPHERE_C,
  SPHERE_R,
  toPath,
  type MouthSpec,
  type Ring,
} from "@/lib/maus-engine";

export type FacePart = {
  d: string;
  transform: string;
  /** Past the horizon of the implied sphere — nothing to draw. */
  hidden: boolean;
};

export type ProjectedFace = {
  eyes: FacePart[];
  mouth: FacePart;
};

export type FaceProjection = {
  gazeX: number;
  gazeY: number;
  /** Head turn in degrees. Only the face travels; the silhouette never rotates. */
  turn: number;
  eyeScale: number;
  /** Widens or narrows the eye pair about the centre of the sphere. */
  eyeSpacing: number;
  /** Vertical eyelid scale, 1 open, ~0 shut. */
  blink: number;
  /** Face the viewer at turn 0 — see centreOffset. */
  forward: boolean;
};

/**
 * How far the eye pair sits around the sphere from dead centre, in radians.
 *
 * The 25 expressions were each authored at whatever longitude suited them, from
 * -25.6° to +48.9°, so at turn 0 the maus is never actually looking at you — it
 * looks wherever its current face happened to be drawn. `idle` rests at +27.6°,
 * which reads as permanently glancing right.
 *
 * Subtracting this puts the pair astride the sphere's centre, so turn 0 means
 * facing forward and `turn` measures from there. It is computed from the live
 * morphing rings rather than the target, so the face stays forward *through* an
 * expression change instead of swinging as each new one lands. The eyes keep
 * their individual authored positions — only the pair is re-centred.
 */
function centreOffset(x: number[]) {
  let sum = 0;
  for (const v of x) sum += Math.asin(clamp((v - SPHERE_C) / SPHERE_R, -1, 1));
  return sum / x.length;
}

/**
 * Wraps a point around the implied sphere. This is the whole 3D illusion: the
 * body is a flat silhouette that never moves, and the face slides across a
 * sphere behind it, foreshortening as it goes and vanishing at the horizon.
 */
function wrap(x: number, radians: number) {
  const baseLongitude = Math.asin(clamp((x - SPHERE_C) / SPHERE_R, -1, 1));
  const longitude = baseLongitude + radians;
  const depth = Math.cos(longitude);
  return {
    x: SPHERE_C + SPHERE_R * Math.sin(longitude),
    depth,
    perspective: Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02),
  };
}

export function projectFace(
  rings: Ring[],
  spec: MouthSpec,
  o: FaceProjection,
): ProjectedFace {
  const gx = clamp(o.gazeX, -1, 1) * GAZE_X;
  const gy = clamp(o.gazeY, -1, 1) * GAZE_Y;

  const centres = rings.map((ring) => centroid(ring));
  const spreads = centres.map(([x]) => SPHERE_C + (x - SPHERE_C) * o.eyeSpacing);
  const radians =
    (o.turn * Math.PI) / 180 - (o.forward ? centreOffset(spreads) : 0);

  const eyes = rings.map((ring, index) => {
    const c = centres[index];
    const { x, depth, perspective } = wrap(spreads[index], radians);
    const sx = clamp(perspective * o.eyeScale, 0.02, 2.4);
    const sy = clamp(o.blink * o.eyeScale, 0.02, 2.4);

    return {
      d: toPath(ring),
      transform:
        `translate(${(x + gx).toFixed(2)} ${(c[1] + gy).toFixed(2)})` +
        ` scale(${sx.toFixed(4)} ${sy.toFixed(4)})` +
        ` translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`,
      hidden: depth <= 0.02,
    };
  });

  // The mouth rides the same sphere but at its own longitude, so it crosses the
  // horizon slightly after the eyes. Blinking deliberately does not touch it.
  const frame = mouthFrame(rings, spec);
  const { x, depth, perspective } = wrap(frame.x, radians);

  return {
    eyes,
    mouth: {
      d: mouthPath(frame, spec),
      transform:
        `translate(${(x + gx).toFixed(2)} ${(frame.y + gy).toFixed(2)})` +
        ` scale(${clamp(perspective, 0.02, 2.4).toFixed(4)} 1)` +
        ` translate(${(-frame.x).toFixed(2)} ${(-frame.y).toFixed(2)})`,
      hidden: depth <= 0.02,
    },
  };
}
