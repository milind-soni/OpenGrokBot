import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import {
  BLINK,
  blinkScale,
  clone,
  displayed,
  displayedMouth,
  EXPR_CADENCE,
  EXPRESSION_COUNT,
  EXPRESSIONS,
  MAUS_FIT_OFFSET,
  MAUS_FIT_SCALE,
  MAUS_PATH,
  MOUTHS,
  POOLS,
  type MouthSpec,
} from "@/lib/maus-engine";
import { subscribeToFrames } from "@/lib/maus-driver";
import { projectFace, type FaceProjection } from "@/lib/maus-face";

// Exact SupaMaus mascot silhouette from the website's
// components/v2/MascotSlot.js. The face engine was authored against the same
// path, so MAUS_PATH is this geometry — the two frames differ only by MAUS_FIT.
const BODY = MAUS_PATH;

const INK = "#10201b";

/**
 * Face space -> the body's own untransformed space.
 *
 * The engine's fit is `translate(offset) scale(fit) rotate(-20 100 100)`, and
 * this component already draws the body under that same rotation, so the bridge
 * is the fit undone and the rotation put back: the face lands on the silhouette
 * without either side knowing the other's numbers.
 *
 * It has to be expressed in *pre-rotation* space, which is why the face group
 * lives inside `.maus-solid` rather than beside it. `.maus-solid` is styled with
 * `transform-box: view-box; transform-origin: 100px 100px`, and since a browser
 * treats the SVG transform attribute as the CSS transform property, that origin
 * is applied on top of the attribute's own rotate-about-point — the body is
 * really drawn at translate(-28.17 40.23) of where the attribute alone puts it,
 * which is what this component's viewBox is framed around. Nesting the face
 * under the same group means it inherits that quirk instead of fighting it.
 */
const FACE_TO_BODY = `rotate(20 100 100) scale(${(1 / MAUS_FIT_SCALE).toFixed(6)}) translate(${-MAUS_FIT_OFFSET[0]} ${-MAUS_FIT_OFFSET[1]})`;

/**
 * Face placement, tunable per instance via the preview harness.
 *
 * The ceilings below were measured by hit-testing every one of the 25
 * expressions against the silhouette, not chosen by eye:
 *
 *   faceScale   > 0.4937 clips — 0.47 is the engine's own value, near the max
 *   eyeScale    > 1.336  clips at rest
 *   mouthStroke > 22.7   clips at eyeScale 1.15
 *
 * So the face cannot get bigger, but it can get bolder: the app's earlier
 * hand-drawn face was much heavier than the engine's default, and a thicker
 * mouth costs nothing. Those eyeScale/gaze ceilings are the pessimistic ones,
 * measured with the expressions' authored off-centre gaze; facing forward the
 * eyes sit mid-silhouette and the ceilings rise to 1.812 and full gaze. 1.12 is
 * chosen to stay clear in both modes.
 */
export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

/**
 * How far the pointer may pull the eyes, measured per mode.
 *
 * Facing forward the eyes sit in the middle of the silhouette and the full
 * range is safe. With the expressions' authored off-centre gaze they already
 * start near an edge, and anything past 0.258 pushes one under it — which is
 * why raising eyeScale costs headroom there but not here.
 */
const POINTER_GAZE = { forward: 1, authored: 0.25 };

const faceAnchor = (x: number, y: number, scale: number) =>
  `translate(${x} ${y}) scale(${scale}) translate(-120 -122.5)`;

/**
 * What a one-shot motion does to the face while its body animation plays. The
 * CSS library moves the character; this keeps the expression agreeing with it,
 * so an alert reads as alarm rather than a calm face on a shaking body.
 */
const MOTION_FACE: Partial<
  Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
> = {
  arrive: { state: "spawning", spin: 900 },
  switch: { state: "waking", spin: 620 },
  customize: { state: "proud", blink: true },
  alert: { state: "alerting" },
  thinking: { state: "thinking" },
  working: { state: "working" },
  launch: { state: "loading" },
  success: { state: "happy", blink: true },
  celebrate: { state: "celebrate", spin: 700 },
  blink: { blink: true },
  surprise: { state: "surprised", blink: true },
  failure: { state: "sad" },
};

/** How long a one-shot motion holds its face before the bot's own returns. */
const MOTION_FACE_MS = 1400;

function shade(hex: string, amount: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, ((value >> shift) & 0xff) + amount));
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export type MausAvatarHandle = {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
};

export type MausAvatarProps = {
  color: MausColor;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: MausState;
  /** Pin one of the 25 faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. The silhouette never rotates; only the face travels. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  eyeSpacing?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off restores the engine's own drawn-in directions.
   */
  forward?: boolean;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the frame loop. Off draws the state's resting face once. */
  animated?: boolean;
};

function MausAvatarComponent(
  {
    color,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn = 0,
    gaze,
    spring = 7,
    eyeScale = EYE_SCALE,
    eyeSpacing = 1,
    showMouth = true,
    mouthStroke = MOUTH_WEIGHT,
    faceX = FACE_X,
    faceY = FACE_Y,
    faceScale = FACE_SCALE,
    forward = true,
    trackPointer = true,
    animated = true,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  const uid = useId().replace(/:/g, "");
  const surfaceId = `maus-surface-${uid}`;
  const bevelId = `maus-bevel-${uid}`;
  const glossId = `maus-gloss-${uid}`;
  const clipId = `maus-clip-${uid}`;
  const surfaceShade = shade(fill, -30);

  const reducedMotion = usePrefersReducedMotion();
  const live = animated && !reducedMotion;

  const eye0 = useRef<SVGPathElement | null>(null);
  const eye1 = useRef<SVGPathElement | null>(null);
  const mouth = useRef<SVGPathElement | null>(null);

  // A one-shot motion borrows the face for a moment, then hands it back.
  const [motionState, setMotionState] = useState<MausState | null>(null);
  const activeState = motionState ?? state;

  // Everything the frame loop reads lives in a ref, so a prop change never
  // restarts the animation mid-morph.
  const engine = useRef({
    current: clone(EXPRESSIONS[0]),
    target: EXPRESSIONS[0],
    currentMouth: MOUTHS[0].slice() as MouthSpec,
    targetMouth: MOUTHS[0] as MouthSpec,
    expression: 0,
    morph: 1,
    velocity: 0,
    blinkStart: null as number | null,
    spinStart: null as number | null,
    spinDuration: 900,
    last: 0,
    pointer: { x: 0, y: 0 },
    drawKey: "",
    projection: { spring, eyeScale, eyeSpacing, turn, forward, gaze } as {
      spring: number;
      eyeScale: number;
      eyeSpacing: number;
      turn: number;
      forward: boolean;
      gaze?: { x?: number; y?: number };
    },
  });
  engine.current.projection = { spring, eyeScale, eyeSpacing, turn, forward, gaze };

  const selectExpression = (index: number) => {
    const e = engine.current;
    const i = ((index % EXPRESSION_COUNT) + EXPRESSION_COUNT) % EXPRESSION_COUNT;
    if (i === e.expression && e.morph >= 1) return;
    e.current = displayed(e);
    e.currentMouth = displayedMouth(e);
    e.target = EXPRESSIONS[i];
    e.targetMouth = MOUTHS[i];
    e.expression = i;
    e.morph = 0;
    e.velocity = 0;
  };

  useImperativeHandle(
    ref,
    () => ({
      blink: () => {
        engine.current.blinkStart = performance.now();
      },
      spin: (durationMs = 900) => {
        engine.current.spinDuration = durationMs;
        engine.current.spinStart = performance.now();
      },
      setExpression: selectExpression,
    }),
    [],
  );

  // Settle on the state's resting face, or the pinned one.
  useEffect(() => {
    selectExpression(expression ?? POOLS[activeState][0]);
  }, [activeState, expression]);

  // Drift through the state's own expression pool.
  useEffect(() => {
    if (!live || !autoDrift(expression)) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const [lo, hi] = EXPR_CADENCE[activeState];
      timer = setTimeout(
        () => {
          const pool = POOLS[activeState];
          const alternatives = pool.filter((x) => x !== engine.current.expression);
          selectExpression(
            alternatives.length
              ? alternatives[Math.floor(Math.random() * alternatives.length)]
              : pool[0],
          );
          tick();
        },
        lo + Math.random() * (hi - lo),
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [activeState, expression, live]);

  // Blink on the state's own rhythm.
  useEffect(() => {
    const cadence = BLINK[activeState];
    if (!live || !cadence) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(
        () => {
          engine.current.blinkStart = performance.now();
          tick();
        },
        cadence[0] + Math.random() * (cadence[1] - cadence[0]),
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [activeState, live]);

  // A replayed motion pulls the face along with the body animation.
  useEffect(() => {
    if (motion === "none" || !live) return;
    const beat = MOTION_FACE[motion];
    if (!beat) return;

    if (beat.blink) engine.current.blinkStart = performance.now();
    if (beat.spin) {
      engine.current.spinDuration = beat.spin;
      engine.current.spinStart = performance.now();
    }
    if (!beat.state) return;

    setMotionState(beat.state);
    const timer = setTimeout(() => setMotionState(null), MOTION_FACE_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, live]);

  // The frame loop, shared across every mounted avatar.
  useEffect(() => {
    if (!live) return;
    engine.current.last = performance.now();

    return subscribeToFrames((now) => {
      const e = engine.current;
      const p = e.projection;
      const dt = Math.min((now - e.last) / 1000, 0.1);
      e.last = now;

      // Critically-damped spring toward the target expression.
      const f = p.spring;
      e.velocity += (-2 * f * e.velocity - f * f * (e.morph - 1)) * dt;
      e.morph += e.velocity * dt;
      if (!Number.isFinite(e.morph)) {
        e.morph = 1;
        e.velocity = 0;
      }

      let spinTurn = 0;
      if (e.spinStart !== null) {
        const t = (now - e.spinStart) / e.spinDuration;
        if (t >= 1) e.spinStart = null;
        else spinTurn = 360 * t;
      }

      const blink = blinkScale(e, now);
      const gazeX = (p.gaze?.x ?? 0) + e.pointer.x;
      const gazeY = (p.gaze?.y ?? 0) + e.pointer.y;

      // A settled face is not redrawn. Most avatars on screen are resting most
      // of the time, so this is what keeps a long bot list free.
      const key = `${e.expression}|${e.morph >= 1 ? 1 : e.morph.toFixed(4)}|${blink.toFixed(3)}|${gazeX.toFixed(3)}|${gazeY.toFixed(3)}|${(p.turn + spinTurn).toFixed(2)}|${p.eyeScale}|${p.eyeSpacing}|${p.forward}`;
      if (key === e.drawKey) return;
      e.drawKey = key;

      const face = projectFace(displayed(e), displayedMouth(e), {
        gazeX,
        gazeY,
        turn: p.turn + spinTurn,
        eyeScale: p.eyeScale,
        eyeSpacing: p.eyeSpacing,
        blink,
        forward: p.forward,
      });

      apply(eye0.current, face.eyes[0]);
      apply(eye1.current, face.eyes[1]);
      apply(mouth.current, face.mouth);
    });
  }, [live]);

  // First paint, and the whole of the static render. Uses the resting face so a
  // reduced-motion or non-animated avatar still looks deliberate.
  const rest = useMemo(() => {
    const index = expression ?? POOLS[activeState][0];
    const projection: FaceProjection = {
      gazeX: gaze?.x ?? 0,
      gazeY: gaze?.y ?? 0,
      turn,
      eyeScale,
      eyeSpacing,
      blink: 1,
      forward,
    };
    return projectFace(EXPRESSIONS[index], MOUTHS[index], projection);
  }, [activeState, expression, gaze?.x, gaze?.y, turn, eyeScale, eyeSpacing, forward]);

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!trackPointer || !live) return;
    const rect = event.currentTarget.getBoundingClientRect();
    engine.current.pointer = {
      x: clampGaze(((event.clientX - rect.left) / rect.width - 0.5) * 2, forward),
      y: clampGaze(((event.clientY - rect.top) / rect.height - 0.5) * 2, forward),
    };
  };

  const onPointerLeave = () => {
    engine.current.pointer = { x: 0, y: 0 };
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="-22 51 164 164"
      className="shrink-0 overflow-visible"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      style={{ "--maus-color": fill } as CSSProperties}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
        <linearGradient id={surfaceId} x1="66" y1="45" x2="132" y2="156" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={shade(fill, 54)} />
          <stop offset="0.3" stopColor={shade(fill, 22)} />
          <stop offset="0.72" stopColor={fill} />
          <stop offset="1" stopColor={surfaceShade} />
        </linearGradient>
        <linearGradient id={bevelId} x1="57" y1="44" x2="146" y2="151" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.68" />
          <stop offset="0.38" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="0.68" stopColor={surfaceShade} stopOpacity="0.1" />
          <stop offset="1" stopColor={INK} stopOpacity="0.28" />
        </linearGradient>
        <radialGradient id={glossId} cx="0.5" cy="0.45" r="0.58">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.62" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g key={motionKey} className={`maus-motion maus-motion--${motion}`}>
        {(motion === "alert" || motion === "failure") && (
          <g className="maus-fx maus-fx--alert" aria-hidden="true">
            <path d="M97 45 Q100 40 103 45 L106 92 Q106 99 100 99 Q94 99 94 92 Z" fill={fill} />
            <circle cx="100" cy="116" r="8" fill={fill} />
          </g>
        )}

        {motion === "thinking" && (
          <g className="maus-fx maus-fx--ellipsis" aria-hidden="true">
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--one" cx="72" cy="101" r="8" fill={fill} />
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--two" cx="100" cy="101" r="10" fill={fill} />
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--three" cx="130" cy="101" r="8" fill={fill} />
          </g>
        )}

        {motion === "launch" && (
          <g className="maus-fx maus-fx--ribbons" aria-hidden="true">
            <path className="maus-ribbon maus-ribbon--one" pathLength="1" d="M55 119 C79 137 119 140 150 116" stroke={fill} />
            <path className="maus-ribbon maus-ribbon--two" pathLength="1" d="M54 112 C85 126 119 125 145 103" stroke="#fcfcfc" />
            <path className="maus-ribbon maus-ribbon--three" pathLength="1" d="M62 126 C87 145 126 145 156 121" stroke={shade(fill, 44)} />
          </g>
        )}

        {motion === "celebrate" && (
          <g className="maus-fx maus-fx--burst" aria-hidden="true">
            <circle className="maus-burst-dot maus-burst-dot--one" cx="100" cy="100" r="5" fill={fill} />
            <circle className="maus-burst-dot maus-burst-dot--two" cx="100" cy="100" r="4" fill="#fcfcfc" />
            <circle className="maus-burst-dot maus-burst-dot--three" cx="100" cy="100" r="6" fill={shade(fill, 42)} />
            <circle className="maus-burst-dot maus-burst-dot--four" cx="100" cy="100" r="3.5" fill={fill} />
            <path className="maus-burst-ray maus-burst-ray--one" d="M100 100 L100 73" stroke={fill} />
            <path className="maus-burst-ray maus-burst-ray--two" d="M100 100 L125 88" stroke="#fcfcfc" />
            <path className="maus-burst-ray maus-burst-ray--three" d="M100 100 L82 121" stroke={shade(fill, 42)} />
          </g>
        )}

        {(motion === "arrive" || motion === "switch" || motion === "customize" || motion === "working") && (
          <g className="maus-orbit" aria-hidden="true">
            <path className="maus-speed-line maus-speed-line--one" pathLength="1" d="M38 119 C23 81 45 42 78 29" />
            <path className="maus-speed-line maus-speed-line--two" pathLength="1" d="M55 151 C32 126 29 94 39 70" />
            <circle className="maus-orbit-dot maus-orbit-dot--one" cx="47" cy="54" r="4.6" fill={fill} />
            <circle className="maus-orbit-dot maus-orbit-dot--two" cx="151" cy="65" r="3.4" fill="#fcfcfc" />
            <circle className="maus-orbit-dot maus-orbit-dot--three" cx="155" cy="132" r="5.2" fill={fill} />
          </g>
        )}

        <g className="maus-character">
          <g className="maus-solid" transform="rotate(-20 100 100)">
            <path className="maus-body" d={BODY} fill={`url(#${surfaceId})`} />
            <path
              className="maus-bevel"
              d={BODY}
              fill="none"
              stroke={`url(#${bevelId})`}
              strokeWidth="4.5"
              clipPath={`url(#${clipId})`}
            />
            <ellipse
              className="maus-specular"
              cx="73"
              cy="60"
              rx="42"
              ry="24"
              fill={`url(#${glossId})`}
              clipPath={`url(#${clipId})`}
              transform="rotate(-26 73 60)"
            />
            <path
              className="maus-rim-light"
              d="M94 43 L48 144"
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.35"
              strokeWidth="2.2"
              strokeLinecap="round"
              clipPath={`url(#${clipId})`}
            />

            <g className="maus-face" clipPath={`url(#${clipId})`}>
              <g transform={FACE_TO_BODY}>
                <g transform={faceAnchor(faceX, faceY, faceScale)}>
                  <path
                    ref={eye0}
                    fill={INK}
                    d={rest.eyes[0].d}
                    transform={rest.eyes[0].transform}
                    opacity={rest.eyes[0].hidden ? 0 : 1}
                  />
                  <path
                    ref={eye1}
                    fill={INK}
                    d={rest.eyes[1].d}
                    transform={rest.eyes[1].transform}
                    opacity={rest.eyes[1].hidden ? 0 : 1}
                  />
                  {showMouth && (
                    <path
                      ref={mouth}
                      fill="none"
                      stroke={INK}
                      strokeWidth={mouthStroke}
                      strokeLinecap="round"
                      d={rest.mouth.d}
                      transform={rest.mouth.transform}
                      opacity={rest.mouth.hidden ? 0 : 1}
                    />
                  )}
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

const clampGaze = (v: number, forward: boolean) => {
  const limit = forward ? POINTER_GAZE.forward : POINTER_GAZE.authored;
  return Math.max(-limit, Math.min(limit, v));
};

function autoDrift(expression: number | undefined) {
  return expression === undefined;
}

function apply(el: SVGPathElement | null, part: { d: string; transform: string; hidden: boolean }) {
  if (!el) return;
  el.setAttribute("d", part.d);
  el.setAttribute("transform", part.transform);
  el.style.opacity = part.hidden ? "0" : "1";
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
