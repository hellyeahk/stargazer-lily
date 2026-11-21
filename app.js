(() => {
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let clusterScale = 1;
  const fixedFrameTime = 1 / 60;

  // Spring-damped breeze physics driven by pointer movement + gentle night air currents
  const breeze = {
    targetX: 0,
    targetY: 0,
    posX: 0,
    posY: 0,
    velX: 0,
    velY: 0,
    lastPointerX: null,
    lastPointerY: null
  };

  const startTime = performance.now();
  let stems = [];
  let fireflies = [];
  let bokehCircles = [];
  let pollenParticles = [];

  // ============================================================================
  // MATH, EASING & C1-CONTINUOUS QUADRATIC MIDPOINT SPLINE HELPER
  // ============================================================================
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (edge0, edge1, x) => {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInOutSine = (t) => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;

  function quadBezier(p0, p1, p2, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
    };
  }

  function quadBezierTangent(p0, p1, p2, t) {
    const dx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
    const dy = 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  /**
   * Traces a C1-continuous quadratic midpoint spline through `points`.
   * Eliminates polygonal edges and segment joints across petals, leaves, buds, and stems.
   */
  function traceSmoothSpline(ctx, points, moveFirst = true) {
    const len = points.length;
    if (len === 0) return;

    if (moveFirst) {
      ctx.moveTo(points[0].x, points[0].y);
    } else {
      ctx.lineTo(points[0].x, points[0].y);
    }

    if (len === 1) return;
    if (len === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      return;
    }

    for (let i = 1; i < len - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) * 0.5;
      const midY = (points[i].y + points[i + 1].y) * 0.5;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }

    const last = points[len - 1];
    ctx.lineTo(last.x, last.y);
  }

  function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  // ============================================================================
  // 3D ROTATION & PERSPECTIVE PROJECTION
  // ============================================================================
  function rotate3D(x, y, z, yaw, pitch, roll) {
    // Roll (Z axis)
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const x1 = x * cr - y * sr;
    const y1 = x * sr + y * cr;
    const z1 = z;

    // Pitch (X axis)
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x2 = x1;
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;

    // Yaw (Y axis)
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x3 = x2 * cy + z2 * sy;
    const y3 = y2;
    const z3 = -x2 * sy + z2 * cy;

    return { x: x3, y: y3, z: z3 };
  }

  function project3D(p, originX, originY, fov = 820) {
    const zOffset = fov + p.z;
    const scale = fov / Math.max(150, zOffset);
    return {
      x: originX + p.x * scale,
      y: originY + p.y * scale,
      z: p.z,
      scale
    };
  }

  // ============================================================================
  // SCENE INITIALIZATION (HERO STARGAZER CLUSTER, BOKEH & FIREFLIES)
  // ============================================================================
  function createFreckles(seed) {
    const rand = seededRandom(seed);
    const freckles = [];
    for (let i = 0; i < 42; i++) {
      const u = 0.14 + rand() * 0.56;
      const side = rand() < 0.5 ? -1 : 1;
      const v = side * (0.14 + rand() * 0.54 * (1 - u * 0.42));
      const radius = 0.9 + rand() * 1.3;
      const shade = rand() < 0.55 ? '#54041d' : '#800a2f';
      freckles.push({ u, v, radius, shade });
    }
    return freckles;
  }

  function buildLeafSet(stemSeed, count, minT, maxT, baseLength, baseWidth) {
    const rand = seededRandom(stemSeed);
    const leaves = [];
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : i / (count - 1);
      const t = lerp(minT, maxT, frac);
      const side = i % 2 === 0 ? -1 : 1;
      const depthLayer = i % 3 === 1 ? 1 : -1;
      const sizeFalloff = lerp(1.08, 0.68, frac) * (0.92 + rand() * 0.18);
      leaves.push({
        t,
        side,
        depthLayer,
        length: baseLength * sizeFalloff,
        width: baseWidth * sizeFalloff,
        angleOffset: (0.48 + rand() * 0.34) * side,
        droop: 0.28 + rand() * 0.34,
        unfurlDelay: 0.35 + t * 1.15
      });
    }
    return leaves;
  }

  function initCluster() {
    stems = [
      // 1. Upper-Center Tall Background Stem (carries 3/4 upper-left bloom + upper-right unfurling lime bud)
      {
        id: 'upper-center',
        zOrder: 1,
        baseOffset: { x: 8, y: 26 },
        ctrlOffset: { x: -12, y: -230 },
        tipOffset: { x: -34, y: -445 },
        thickness: 8.6,
        growDelay: 0.0,
        growDuration: 2.1,
        swayPhase: 0.4,
        swayAmp: 11,
        leaves: buildLeafSet(101, 10, 0.14, 0.88, 120, 25),
        bloom: {
          scale: 0.88,
          yaw: -0.36,
          pitch: -0.44,
          roll: -0.24,
          bloomDelay: 1.4,
          bloomDuration: 2.6,
          freckles: createFreckles(201)
        },
        budBranch: {
          attachT: 0.77,
          ctrlOffset: { x: 54, y: -55 },
          tipOffset: { x: 108, y: -128 },
          budLength: 90,
          budRadius: 17.5,
          tilt: 0.24,
          delay: 1.2
        }
      },
      // 2. Supporting Lower Lush Leafy Stem
      {
        id: 'lower-foliage',
        zOrder: 2,
        baseOffset: { x: -14, y: 28 },
        ctrlOffset: { x: -28, y: -115 },
        tipOffset: { x: -18, y: -225 },
        thickness: 7.6,
        growDelay: 0.1,
        growDuration: 1.8,
        swayPhase: 1.7,
        swayAmp: 7.5,
        leaves: buildLeafSet(102, 9, 0.12, 0.94, 128, 27),
        bloom: null,
        budBranch: null
      },
      // 3. Left-Center Foreground Hero Stem
      {
        id: 'left-hero',
        zOrder: 3,
        baseOffset: { x: -16, y: 28 },
        ctrlOffset: { x: -64, y: -185 },
        tipOffset: { x: -104, y: -332 },
        thickness: 9.6,
        growDelay: 0.18,
        growDuration: 2.0,
        swayPhase: 2.5,
        swayAmp: 10.5,
        leaves: buildLeafSet(103, 9, 0.14, 0.86, 124, 26),
        bloom: {
          scale: 1.04,
          yaw: -0.18,
          pitch: 0.08,
          roll: -0.18,
          bloomDelay: 1.2,
          bloomDuration: 2.5,
          freckles: createFreckles(303)
        },
        budBranch: null
      },
      // 4. Right-Center Foreground Hero Stem
      {
        id: 'right-hero',
        zOrder: 4,
        baseOffset: { x: 20, y: 28 },
        ctrlOffset: { x: 68, y: -155 },
        tipOffset: { x: 102, y: -272 },
        thickness: 9.6,
        growDelay: 0.28,
        growDuration: 1.95,
        swayPhase: 4.1,
        swayAmp: 9.5,
        leaves: buildLeafSet(104, 8, 0.14, 0.85, 120, 25),
        bloom: {
          scale: 1.06,
          yaw: 0.20,
          pitch: 0.14,
          roll: 0.20,
          bloomDelay: 1.35,
          bloomDuration: 2.5,
          freckles: createFreckles(404)
        },
        budBranch: null
      }
    ];
  }

  function initAtmosphere() {
    // Out-of-focus twilight bokeh circles in plum, violet, and rose
    const palette = [
      'rgba(192, 132, 252, 0.08)', // soft violet
      'rgba(244, 114, 182, 0.09)', // luminous rose
      'rgba(147, 51, 234, 0.07)',  // deep plum
      'rgba(232, 121, 249, 0.07)'  // orchid pink
    ];
    bokehCircles = [];
    for (let i = 0; i < 18; i++) {
      bokehCircles.push({
        x: Math.random(),
        y: 0.08 + Math.random() * 0.82,
        r: 36 + Math.random() * 88,
        color: palette[i % palette.length],
        driftSpeed: 0.18 + Math.random() * 0.25,
        driftAmp: 12 + Math.random() * 24,
        phase: Math.random() * Math.PI * 2
      });
    }

    // Rising golden firefly / pollen sparks (#ffe9a8 with #ffd36b glow)
    fireflies = [];
    for (let i = 0; i < 34; i++) {
      fireflies.push({
        x: Math.random(),
        y: Math.random(),
        radius: 1.6 + Math.random() * 2.3,
        speedY: 0.025 + Math.random() * 0.04,
        driftAmp: 16 + Math.random() * 34,
        driftFreq: 0.55 + Math.random() * 1.05,
        phase: Math.random() * Math.PI * 2,
        twinkleFreq: 1.5 + Math.random() * 2.5,
        alpha: 0.5 + Math.random() * 0.5
      });
    }
  }

  // ============================================================================
  // HIGH-DPI RETINA CANVAS RESIZING
  // ============================================================================
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scaleX = width / 560;
    const scaleY = height / 660;
    clusterScale = clamp(Math.min(scaleX, scaleY), 0.56, 1.24);
  }

  window.addEventListener('resize', resize);

  // ============================================================================
  // INTERACTIVE SPRING-DAMPED BREEZE & TAP/CLICK TO PLANT
  // ============================================================================
  function handlePointerMove(clientX, clientY) {
    const nx = clamp(clientX / Math.max(1, width), 0, 1) - 0.5;
    const ny = clamp(clientY / Math.max(1, height), 0, 1) - 0.5;

    // Velocity impulse from cursor sweep + gentle directional lean
    if (breeze.lastPointerX !== null) {
      const dx = (clientX - breeze.lastPointerX) / Math.max(1, width);
      const dy = (clientY - breeze.lastPointerY) / Math.max(1, height);
      breeze.velX += clamp(dx * 140, -28, 28);
      breeze.velY += clamp(dy * 90, -18, 18);
    }
    breeze.lastPointerX = clientX;
    breeze.lastPointerY = clientY;
    breeze.targetX = nx * 26;
    breeze.targetY = ny * 12;
  }

  window.addEventListener('pointermove', (e) => {
    handlePointerMove(e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 0) {
      handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('pointerdown', (e) => {
    handlePointerMove(e.clientX, e.clientY);
    plantStargazerAt(e.clientX, e.clientY);
  });

  function plantStargazerAt(clientX, clientY) {
    const nowSec = (performance.now() - startTime) / 1000;
    const anchorX = width * 0.5;
    const anchorY = height * 0.94;

    const relX = (clientX - anchorX) / clusterScale;
    const relY = clamp((clientY - anchorY) / clusterScale, -520, -140);
    const baseSpread = clamp(relX * 0.24, -145, 145);
    const seed = Math.floor(nowSec * 1000) + Math.floor(clientX);

    const newStem = {
      id: 'planted-' + seed,
      zOrder: 3 + (stems.length % 3),
      baseOffset: { x: baseSpread, y: 28 },
      ctrlOffset: { x: lerp(baseSpread, relX, 0.45), y: relY * 0.52 },
      tipOffset: { x: relX, y: relY },
      thickness: 8.6,
      growDelay: nowSec,
      growDuration: 1.75,
      swayPhase: Math.random() * Math.PI * 2,
      swayAmp: 8.5 + Math.random() * 4.5,
      leaves: buildLeafSet(seed, 7, 0.16, 0.85, 112, 23),
      bloom: {
        scale: 0.86 + Math.random() * 0.2,
        yaw: clamp(relX / 420, -0.45, 0.45),
        pitch: -0.04 + (Math.random() - 0.5) * 0.22,
        roll: clamp(relX / 520, -0.35, 0.35),
        bloomDelay: nowSec + 1.05,
        bloomDuration: 2.2,
        freckles: createFreckles(seed + 77)
      },
      budBranch: null
    };

    stems.push(newStem);
    if (stems.length > 10) {
      stems.splice(4, 1);
    }
  }

  // ============================================================================
  // ATMOSPHERE: NIGHT SKY, BOKEH, PULSING HERO AURA & GOLDEN SPARKS
  // ============================================================================
  function drawAtmosphere(timeSec, avgBloom) {
    // 1. Deep twilight/night radial gradient (#2a1a4a at 50% 78%, #160d2b at 45%, #080512 at 100%)
    const cx = width * 0.5;
    const cy = height * 0.78;
    const maxR = Math.max(width, height) * 0.94;

    const bgGrad = ctx.createRadialGradient(cx, cy, 8, cx, cy, maxR);
    bgGrad.addColorStop(0.0, '#2a1a4a');
    bgGrad.addColorStop(0.45, '#160d2b');
    bgGrad.addColorStop(1.0, '#080512');

    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Soft out-of-focus bokeh circles in plum, violet, and rose
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < bokehCircles.length; i++) {
      const b = bokehCircles[i];
      const bx = b.x * width + Math.sin(timeSec * b.driftSpeed + b.phase) * b.driftAmp;
      const by = b.y * height + Math.cos(timeSec * b.driftSpeed * 0.8 + b.phase) * (b.driftAmp * 0.6);
      const rad = b.r * clusterScale;

      const bGrad = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
      bGrad.addColorStop(0.0, b.color);
      bGrad.addColorStop(0.65, b.color);
      bGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.arc(bx, by, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Pulsing magenta-pink ambient aura behind the hero lily cluster
    const pulse = 0.85 + 0.15 * Math.sin(timeSec * 1.4);
    const auraStrength = (0.32 + 0.68 * avgBloom) * pulse;
    const auraX = width * 0.5;
    const auraY = height * 0.44;
    const auraR = Math.min(width, height) * (0.48 + 0.08 * avgBloom);

    const auraGrad = ctx.createRadialGradient(auraX, auraY, 6, auraX, auraY, auraR);
    auraGrad.addColorStop(0.0, `rgba(255, 79, 168, ${(0.42 * auraStrength).toFixed(3)})`);
    auraGrad.addColorStop(0.42, `rgba(225, 29, 98, ${(0.18 * auraStrength).toFixed(3)})`);
    auraGrad.addColorStop(1.0, 'rgba(255, 79, 168, 0)');

    ctx.fillStyle = auraGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function drawFirefliesAndPollen(timeSec, dt) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // Rising golden fireflies (#ffe9a8 with #ffd36b glow)
    for (let i = 0; i < fireflies.length; i++) {
      const f = fireflies[i];
      f.y -= f.speedY * dt;
      if (f.y < -0.06) {
        f.y = 1.06;
        f.x = Math.random();
      }

      const px = f.x * width + Math.sin(timeSec * f.driftFreq + f.phase) * f.driftAmp;
      const py = f.y * height;
      const twinkle = 0.55 + 0.45 * Math.sin(timeSec * f.twinkleFreq + f.phase * 1.7);
      const edgeFade = smoothstep(-0.04, 0.1, f.y) * smoothstep(1.04, 0.88, f.y);
      const alpha = f.alpha * twinkle * edgeFade;
      if (alpha <= 0.01) continue;

      const haloR = f.radius * 5.6;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, haloR);
      grad.addColorStop(0.0, `rgba(255, 233, 168, ${alpha.toFixed(3)})`);
      grad.addColorStop(0.35, `rgba(255, 211, 107, ${(alpha * 0.58).toFixed(3)})`);
      grad.addColorStop(1.0, 'rgba(255, 211, 107, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, haloR, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255, 250, 226, ${(alpha * 0.96).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, f.radius * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }

    // Emitted glowing golden pollen specks drifting from open anthers
    for (let i = pollenParticles.length - 1; i >= 0; i--) {
      const p = pollenParticles[i];
      p.age += dt;
      if (p.age >= p.life) {
        pollenParticles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 4.5 * dt; // buoyant upward drift

      const lifeFrac = p.age / p.life;
      const alpha = Math.sin(lifeFrac * Math.PI) * 0.9;
      const rad = p.radius * clusterScale;

      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 4.2);
      g.addColorStop(0.0, `rgba(254, 240, 138, ${alpha.toFixed(3)})`);
      g.addColorStop(0.45, `rgba(251, 146, 60, ${(alpha * 0.55).toFixed(3)})`);
      g.addColorStop(1.0, 'rgba(251, 146, 60, 0)');

      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad * 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // ============================================================================
  // ULTRA-SMOOTH TAPERED SPLINE RIBBON STEM (steps = 48)
  // ============================================================================
  function drawSmoothRibbonStem(p0, p1, p2, maxT, baseThick, tipThick) {
    if (maxT <= 0.005) return;
    const steps = 48;
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxT;
      const pt = quadBezier(p0, p1, p2, t);
      const tan = quadBezierTangent(p0, p1, p2, t);
      const nx = -tan.y;
      const ny = tan.x;
      const halfW = lerp(baseThick, tipThick, t) * 0.5 * clusterScale;

      leftPts.push({ x: pt.x + nx * halfW, y: pt.y + ny * halfW });
      rightPts.push({ x: pt.x - nx * halfW, y: pt.y - ny * halfW });
    }

    const rightReversed = rightPts.slice().reverse();

    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, leftPts, true);
    traceSmoothSpline(ctx, rightReversed, false);
    ctx.closePath();

    const midPt = quadBezier(p0, p1, p2, maxT * 0.5);
    const span = 12 * clusterScale;
    const grad = ctx.createLinearGradient(midPt.x - span, midPt.y, midPt.x + span, midPt.y);
    grad.addColorStop(0.0, '#0d2612');
    grad.addColorStop(0.38, '#1e4d25');
    grad.addColorStop(0.72, '#4ade80');
    grad.addColorStop(1.0, '#163b1c');

    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle bioluminescent emerald sunlit rim along right edge
    ctx.beginPath();
    traceSmoothSpline(ctx, rightPts, true);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.28)';
    ctx.lineWidth = Math.max(0.9, 1.1 * clusterScale);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================================
  // ULTRA-SMOOTH GLOSSY LANCEOLATE LEAF (segments = 30)
  // ============================================================================
  function drawSmoothLanceolateLeaf(attachPt, stemTan, leaf, unfurl, windSway) {
    if (unfurl <= 0.01) return;

    const segments = 30;
    const len = leaf.length * clusterScale * unfurl;
    const maxHalfW = leaf.width * 0.5 * clusterScale * unfurl;

    const stemAngle = Math.atan2(stemTan.y, stemTan.x);
    const branchAngle = stemAngle + leaf.angleOffset * (0.45 + 0.55 * unfurl) + windSway * 0.012;

    const cosA = Math.cos(branchAngle);
    const sinA = Math.sin(branchAngle);
    const perpX = -sinA;
    const perpY = cosA;

    const droopPx = len * leaf.droop * unfurl;
    const spineCtrl = {
      x: attachPt.x + cosA * (len * 0.52) + perpX * (droopPx * 0.2 * leaf.side),
      y: attachPt.y + sinA * (len * 0.52) + Math.abs(droopPx) * 0.16
    };
    const spineTip = {
      x: attachPt.x + cosA * len + perpX * (droopPx * 0.62 * leaf.side),
      y: attachPt.y + sinA * len + Math.abs(droopPx) * 0.68
    };

    const spinePts = [];
    const upperPts = [];
    const lowerPts = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const pt = quadBezier(attachPt, spineCtrl, spineTip, t);
      const tan = quadBezierTangent(attachPt, spineCtrl, spineTip, t);
      const nx = -tan.y;
      const ny = tan.x;

      // Smooth C1-continuous lanceolate width envelope tapering cleanly to 0 at base and tip
      const widthEnv = Math.sin(Math.PI * Math.pow(t, 0.72)) * (1 - 0.14 * t);
      const hw = maxHalfW * widthEnv;

      spinePts.push(pt);
      upperPts.push({ x: pt.x - nx * hw, y: pt.y - ny * hw });
      lowerPts.push({ x: pt.x + nx * hw, y: pt.y + ny * hw });
    }

    const lowerReversed = lowerPts.slice().reverse();

    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, upperPts, true);
    traceSmoothSpline(ctx, lowerReversed, false);
    ctx.closePath();

    const grad = ctx.createLinearGradient(attachPt.x, attachPt.y, spineTip.x, spineTip.y);
    grad.addColorStop(0.0, '#0d2612');
    grad.addColorStop(0.38, '#1e4d25');
    grad.addColorStop(0.75, '#3b823c');
    grad.addColorStop(1.0, '#225927');

    ctx.shadowColor = 'rgba(74, 222, 128, 0.24)';
    ctx.shadowBlur = 10 * clusterScale;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Glossy waxy specular highlight along upper half of leaf blade
    ctx.save();
    ctx.clip();
    const spineReversed = spinePts.slice().reverse();
    ctx.beginPath();
    traceSmoothSpline(ctx, upperPts, true);
    traceSmoothSpline(ctx, spineReversed, false);
    ctx.closePath();
    ctx.fillStyle = 'rgba(167, 243, 208, 0.14)';
    ctx.fill();
    ctx.restore();

    // Bioluminescent emerald rim highlight along upper leaf margin
    ctx.beginPath();
    traceSmoothSpline(ctx, upperPts, true);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.42)';
    ctx.lineWidth = Math.max(1.0, 1.35 * clusterScale * unfurl);
    ctx.stroke();

    // Crisp smooth central midrib vein
    ctx.beginPath();
    traceSmoothSpline(ctx, spinePts, true);
    ctx.strokeStyle = 'rgba(134, 239, 172, 0.52)';
    ctx.lineWidth = Math.max(0.9, 1.3 * clusterScale * unfurl);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================================
  // ULTRA-SMOOTH 3-RIBBED LIME-GREEN LILY BUD (steps = 30)
  // ============================================================================
  function drawSmoothRibbedBud(attachPt, branchTan, budBranch, growth, timeSec) {
    if (growth <= 0.02) return;

    const steps = 30;
    const len = budBranch.budLength * clusterScale * growth;
    const rad = budBranch.budRadius * clusterScale * growth;
    // Gentle gradual unfurl breathing at the bud tip
    const tipParting = (0.04 + 0.05 * (0.5 + 0.5 * Math.sin(timeSec * 0.85))) * growth;
    const angle = Math.atan2(branchTan.y, branchTan.x) + budBranch.tilt + Math.sin(timeSec * 1.35) * 0.028;

    const leftOuter = [];
    const leftSeam = [];
    const rightSeam = [];
    const rightOuter = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = -t * len;
      // Smooth elongated teardrop profile for the 3-ribbed lily bud
      const profile = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.68)), 0.82);
      const tipSpread = Math.pow(t, 2.6) * rad * tipParting;

      leftOuter.push({ x: -rad * profile - tipSpread, y });
      leftSeam.push({ x: -rad * 0.44 * profile - tipSpread * 0.35, y });
      rightSeam.push({ x: rad * 0.44 * profile + tipSpread * 0.35, y });
      rightOuter.push({ x: rad * profile + tipSpread, y });
    }

    ctx.save();
    ctx.translate(attachPt.x, attachPt.y);
    ctx.rotate(angle + Math.PI * 0.5);

    ctx.shadowColor = 'rgba(163, 230, 53, 0.38)';
    ctx.shadowBlur = 16 * clusterScale;

    // 1. Left outer carpel rib
    ctx.beginPath();
    traceSmoothSpline(ctx, leftOuter, true);
    traceSmoothSpline(ctx, leftSeam.slice().reverse(), false);
    ctx.closePath();
    const leftGrad = ctx.createLinearGradient(0, 0, 0, -len);
    leftGrad.addColorStop(0.0, '#4d7c0f');
    leftGrad.addColorStop(0.55, '#84cc16');
    leftGrad.addColorStop(1.0, '#d9f99d');
    ctx.fillStyle = leftGrad;
    ctx.fill();

    // 2. Right outer carpel rib
    ctx.beginPath();
    traceSmoothSpline(ctx, rightSeam, true);
    traceSmoothSpline(ctx, rightOuter.slice().reverse(), false);
    ctx.closePath();
    const rightGrad = ctx.createLinearGradient(0, 0, 0, -len);
    rightGrad.addColorStop(0.0, '#65a30d');
    rightGrad.addColorStop(0.55, '#a3e635');
    rightGrad.addColorStop(1.0, '#ecfccb');
    ctx.fillStyle = rightGrad;
    ctx.fill();

    // 3. Central raised creamy lime-green rib (#65a30d -> #bef264 -> #ecfccb)
    ctx.beginPath();
    traceSmoothSpline(ctx, leftSeam, true);
    traceSmoothSpline(ctx, rightSeam.slice().reverse(), false);
    ctx.closePath();
    const centerGrad = ctx.createLinearGradient(0, 0, 0, -len);
    centerGrad.addColorStop(0.0, '#65a30d');
    centerGrad.addColorStop(0.52, '#bef264');
    centerGrad.addColorStop(1.0, '#ecfccb');
    ctx.fillStyle = centerGrad;
    ctx.fill();

    ctx.shadowBlur = 0;

    // Crisp smooth seam grooves between the 3 ribs
    ctx.strokeStyle = 'rgba(63, 98, 18, 0.52)';
    ctx.lineWidth = Math.max(0.9, 1.15 * clusterScale);
    ctx.beginPath();
    traceSmoothSpline(ctx, leftSeam, true);
    traceSmoothSpline(ctx, rightSeam, true);
    ctx.stroke();

    // Bioluminescent emerald-lime rim highlight around the bud silhouette
    ctx.beginPath();
    traceSmoothSpline(ctx, leftOuter, true);
    traceSmoothSpline(ctx, rightOuter.slice().reverse(), false);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(217, 249, 157, 0.68)';
    ctx.lineWidth = Math.max(1.0, 1.3 * clusterScale);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================================
  // LUMINOUS 3D STARGAZER LILY BLOSSOM (uSteps = 36 C1-Continuous Splines)
  // ============================================================================
  function evaluateTepalSurface(u, v, tepalIndex, length, maxWidth, openAngle, recurveAmount, waveAmp) {
    // Smooth ovate-lanceolate Stargazer tepal width silhouette
    const profile = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.74)), 0.78);
    const halfW = maxWidth * 0.5 * profile;
    const x = v * halfW;

    // Graceful backward recurve at the petal tips
    const recurve = recurveAmount * Math.pow(u, 2.35) * length * 0.46;
    const baseAngle = openAngle - recurveAmount * Math.pow(u, 1.55) * 0.78;
    const r = u * length;

    // Low-frequency fluid edge undulation: Math.sin(u * 8.5 + tepalIndex * 1.9)
    const edgeEnvelope = (v * v) * Math.sin(Math.PI * Math.pow(u, 0.85));
    const wave = Math.sin(u * 8.5 + tepalIndex * 1.9) * waveAmp * edgeEnvelope;
    // Gentle V-cupping along the central midrib
    const midribCup = -Math.abs(v) * 3.4 * Math.sin(u * Math.PI);

    const y = -Math.cos(baseAngle) * r;
    const z = Math.sin(baseAngle) * r - recurve + wave + midribCup;

    return { x, y, z };
  }

  function projectTepalCurve(uSteps, vFunc, tepalIndex, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY) {
    const pts = [];
    const cosAz = Math.cos(azimuth);
    const sinAz = Math.sin(azimuth);

    for (let iu = 0; iu <= uSteps; iu++) {
      const u = iu / uSteps;
      const v = vFunc(u);
      const local = evaluateTepalSurface(u, v, tepalIndex, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp);

      const fx = local.x * cosAz - local.y * sinAz;
      const fy = local.x * sinAz + local.y * cosAz;
      const fz = local.z;

      const world = rotate3D(fx, fy, fz, yaw, pitch, roll);
      const proj = project3D(world, originX, originY);
      pts.push({ x: proj.x, y: proj.y, z: proj.z, scale: proj.scale, u, v });
    }
    return pts;
  }

  function drawStargazerBlossom(originX, originY, bloomCfg, bloomProgress, timeSec) {
    if (bloomProgress <= 0.02) return;

    const bScale = bloomCfg.scale * clusterScale * (0.28 + 0.72 * bloomProgress);
    const breath = Math.sin(timeSec * 1.5 + bloomCfg.yaw * 3) * 0.035 * bloomProgress;
    const yaw = bloomCfg.yaw + Math.sin(timeSec * 0.9) * 0.038;
    const pitch = bloomCfg.pitch + breath;
    const roll = bloomCfg.roll;

    // --------------------------------------------------------------------------
    // 1. MULTI-LAYERED SCREEN BLOSSOM AURA BEHIND EACH OPEN STARGAZER LILY
    // --------------------------------------------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const auraPulse = 0.88 + 0.12 * Math.sin(timeSec * 1.5 + bloomCfg.yaw * 2.5);
    const auraRadius = 175 * bScale * auraPulse;
    const auraAlpha = smoothstep(0.08, 0.85, bloomProgress) * auraPulse;

    const blossomAura = ctx.createRadialGradient(originX, originY, 4 * bScale, originX, originY, auraRadius);
    blossomAura.addColorStop(0.0, `rgba(255, 79, 168, ${(0.38 * auraAlpha).toFixed(3)})`);
    blossomAura.addColorStop(0.52, `rgba(255, 145, 205, ${(0.14 * auraAlpha).toFixed(3)})`);
    blossomAura.addColorStop(1.0, 'rgba(255, 145, 205, 0)');

    ctx.fillStyle = blossomAura;
    ctx.beginPath();
    ctx.arc(originX, originY, auraRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const renderList = [];
    const uSteps = 36; // High-density 36-step sampling for silky C1-continuous curves

    // --------------------------------------------------------------------------
    // 2. SAMPLE 6 SMOOTH 3D TEPALS (3 Outer Sepals + 3 Wider Inner Petals)
    // --------------------------------------------------------------------------
    for (let tIdx = 0; tIdx < 6; tIdx++) {
      const isInner = tIdx % 2 === 1;
      const azimuth = (tIdx * Math.PI) / 3;

      const tepalLen = (isInner ? 126 : 134) * bScale;
      const tepalWidth = (isInner ? 66 : 54) * bScale;

      const openAngle = lerp(0.16, isInner ? 1.18 : 1.28, bloomProgress) + breath;
      const recurveAmt = smoothstep(0.32, 1.0, bloomProgress) * (isInner ? 0.96 : 1.08);
      const waveAmp = (isInner ? 5.6 : 4.4) * bScale * smoothstep(0.25, 1.0, bloomProgress);

      const leftOuter = projectTepalCurve(
        uSteps, () => -1.0, tIdx, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY
      );
      const rightOuter = projectTepalCurve(
        uSteps, () => 1.0, tIdx, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY
      );
      const midrib = projectTepalCurve(
        uSteps, () => 0.0, tIdx, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY
      );

      // Crimson-magenta central flame silhouette curves (tapers smoothly toward tip u = 0.86)
      const flameHalfWidth = (u) => {
        const taper = smoothstep(0.88, 0.04, u);
        return lerp(0.56, 0.12, Math.pow(u, 0.85)) * taper * (isInner ? 1.05 : 0.96);
      };
      const leftFlame = projectTepalCurve(
        uSteps, (u) => -flameHalfWidth(u), tIdx, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY
      );
      const rightFlame = projectTepalCurve(
        uSteps, (u) => flameHalfWidth(u), tIdx, azimuth, tepalLen, tepalWidth, openAngle, recurveAmt, waveAmp, yaw, pitch, roll, originX, originY
      );

      // Pale lime-green throat star curves (u = 0..0.38)
      const starHalfWidth = (u) => smoothstep(0.38, 0.0, u) * 0.56;
      const leftStar = projectTepalCurve(
        18, (u) => -starHalfWidth(u * 0.38), tIdx, azimuth, tepalLen * 0.38, tepalWidth, openAngle, recurveAmt * 0.25, waveAmp * 0.2, yaw, pitch, roll, originX, originY
      );
      const rightStar = projectTepalCurve(
        18, (u) => starHalfWidth(u * 0.38), tIdx, azimuth, tepalLen * 0.38, tepalWidth, openAngle, recurveAmt * 0.25, waveAmp * 0.2, yaw, pitch, roll, originX, originY
      );

      // Average Z depth for accurate back-to-front sorting
      const avgZ = (midrib[6].z + midrib[18].z + midrib[28].z + leftOuter[18].z + rightOuter[18].z) / 5;

      renderList.push({
        type: 'tepal',
        z: avgZ,
        leftOuter,
        rightOuter,
        midrib,
        leftFlame,
        rightFlame,
        leftStar,
        rightStar,
        freckles: bloomCfg.freckles,
        bloomProgress,
        bScale
      });
    }

    // --------------------------------------------------------------------------
    // 3. SAMPLE 6 CURVED STAMENS + RUST-ORANGE/GOLD ANTHERS + 3-LOBED PISTIL
    // --------------------------------------------------------------------------
    const stamenReach = smoothstep(0.2, 0.95, bloomProgress);
    if (stamenReach > 0.02) {
      const stamenSteps = 20;
      for (let sIdx = 0; sIdx < 6; sIdx++) {
        const az = (sIdx * Math.PI) / 3 + 0.28;
        const sLen = 80 * bScale * stamenReach;
        const spread = (0.34 + 0.1 * Math.sin(sIdx * 1.7)) * stamenReach;
        const pts = [];

        for (let k = 0; k <= stamenSteps; k++) {
          const t = k / stamenSteps;
          const radial = Math.sin(spread) * sLen * t + Math.pow(t, 2.4) * 14 * bScale;
          const forwardZ = Math.cos(spread) * sLen * t;
          const fx = Math.cos(az) * radial;
          const fy = Math.sin(az) * radial - Math.pow(t, 2.2) * 12 * bScale;
          const fz = forwardZ;

          const world = rotate3D(fx, fy, fz, yaw, pitch, roll);
          pts.push(project3D(world, originX, originY));
        }

        const tipPt = pts[pts.length - 1];

        // Emit tiny glowing golden pollen particles when open
        if (bloomProgress > 0.72 && Math.random() < 0.032 && pollenParticles.length < 48) {
          pollenParticles.push({
            x: tipPt.x + (Math.random() - 0.5) * 6,
            y: tipPt.y + (Math.random() - 0.5) * 6,
            vx: (Math.random() - 0.5) * 14,
            vy: -6 - Math.random() * 14,
            radius: 1.1 + Math.random() * 1.1,
            age: 0,
            life: 1.6 + Math.random() * 1.4
          });
        }

        renderList.push({
          type: 'stamen',
          z: tipPt.z + 2,
          pts,
          antherAngle: az + 0.5,
          bScale
        });
      }

      // Central Pistil (20-step smooth spline + 3-lobed stigma)
      const pLen = 90 * bScale * stamenReach;
      const pSteps = 20;
      const pPts = [];
      for (let k = 0; k <= pSteps; k++) {
        const t = k / pSteps;
        const fx = Math.pow(t, 2.1) * 8 * bScale;
        const fy = -Math.pow(t, 2.1) * 14 * bScale;
        const fz = pLen * t;
        const world = rotate3D(fx, fy, fz, yaw, pitch, roll);
        pPts.push(project3D(world, originX, originY));
      }
      const stigmaPt = pPts[pPts.length - 1];
      renderList.push({
        type: 'pistil',
        z: stigmaPt.z + 3,
        pts: pPts,
        bScale
      });
    }

    // Sort all parts back-to-front by Z depth
    renderList.sort((a, b) => a.z - b.z);

    // --------------------------------------------------------------------------
    // 4. RENDER DEPTH-SORTED SMOOTH PARTS
    // --------------------------------------------------------------------------
    for (let i = 0; i < renderList.length; i++) {
      const item = renderList[i];
      if (item.type === 'tepal') {
        renderSmoothTepal(item);
      } else if (item.type === 'stamen') {
        renderSmoothStamen(item);
      } else if (item.type === 'pistil') {
        renderSmoothPistil(item);
      }
    }
  }

  function renderSmoothTepal(item) {
    const {
      leftOuter,
      rightOuter,
      midrib,
      leftFlame,
      rightFlame,
      leftStar,
      rightStar,
      freckles,
      bloomProgress,
      bScale
    } = item;

    const rightOuterReversed = rightOuter.slice().reverse();
    const basePt = midrib[0];
    const tipPt = midrib[midrib.length - 1];

    ctx.save();

    // 1. Construct C1-continuous outer tepal silhouette
    ctx.beginPath();
    traceSmoothSpline(ctx, leftOuter, true);
    traceSmoothSpline(ctx, rightOuterReversed, false);
    ctx.closePath();

    // Soft luminous pink-magenta petal glow + snowy-white silky body gradient
    ctx.shadowColor = 'rgba(255, 95, 175, 0.58)';
    ctx.shadowBlur = 22 * bScale;

    const bodyGrad = ctx.createLinearGradient(basePt.x, basePt.y, tipPt.x, tipPt.y);
    bodyGrad.addColorStop(0.0, '#fce7f3');
    bodyGrad.addColorStop(0.28, '#fff7fb');
    bodyGrad.addColorStop(0.72, '#ffffff');
    bodyGrad.addColorStop(1.0, '#fdf2f8');

    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 2. Clip inside smooth tepal silhouette for vivid crimson flame, lime throat & freckles
    ctx.save();
    ctx.clip();

    // Vivid crimson-magenta central flame (#880e37 -> #be123c -> #e11d62)
    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, leftFlame, true);
    traceSmoothSpline(ctx, rightFlame.slice().reverse(), false);
    ctx.closePath();

    ctx.shadowColor = 'rgba(225, 29, 98, 0.65)';
    ctx.shadowBlur = 11 * bScale;

    const flameTip = midrib[Math.floor(midrib.length * 0.84)];
    const flameGrad = ctx.createLinearGradient(basePt.x, basePt.y, flameTip.x, flameTip.y);
    flameGrad.addColorStop(0.0, '#880e37');
    flameGrad.addColorStop(0.45, '#be123c');
    flameGrad.addColorStop(0.82, '#e11d62');
    flameGrad.addColorStop(1.0, 'rgba(244, 63, 133, 0)');

    ctx.fillStyle = flameGrad;
    ctx.fill();
    ctx.restore();

    // Pale lime-green throat star (#65a30d -> #a3e635 -> #d9f99d)
    ctx.save();
    ctx.beginPath();
    traceSmoothSpline(ctx, leftStar, true);
    traceSmoothSpline(ctx, rightStar.slice().reverse(), false);
    ctx.closePath();

    ctx.shadowColor = 'rgba(163, 230, 53, 0.55)';
    ctx.shadowBlur = 8 * bScale;

    const starTip = midrib[Math.floor(midrib.length * 0.36)];
    const starGrad = ctx.createLinearGradient(basePt.x, basePt.y, starTip.x, starTip.y);
    starGrad.addColorStop(0.0, '#65a30d');
    starGrad.addColorStop(0.55, '#a3e635');
    starGrad.addColorStop(1.0, 'rgba(217, 249, 157, 0)');

    ctx.fillStyle = starGrad;
    ctx.fill();
    ctx.restore();

    // Dark burgundy-crimson speckles/freckles interpolated smoothly on the 3D surface
    if (bloomProgress > 0.25) {
      const freckleAlpha = smoothstep(0.25, 0.65, bloomProgress) * 0.88;
      const uMax = midrib.length - 1;
      for (let f = 0; f < freckles.length; f++) {
        const fr = freckles[f];
        const uFloat = fr.u * uMax;
        const i0 = clamp(Math.floor(uFloat), 0, uMax - 1);
        const du = uFloat - i0;

        const c0 = midrib[i0];
        const c1 = midrib[i0 + 1];
        const edgeArr = fr.v < 0 ? leftOuter : rightOuter;
        const e0 = edgeArr[i0];
        const e1 = edgeArr[i0 + 1];

        const cx = lerp(c0.x, c1.x, du);
        const cy = lerp(c0.y, c1.y, du);
        const ex = lerp(e0.x, e1.x, du);
        const ey = lerp(e0.y, e1.y, du);

        const absV = Math.abs(fr.v);
        const fx = lerp(cx, ex, absV);
        const fy = lerp(cy, ey, absV);
        const fScale = lerp(c0.scale, c1.scale, du);

        ctx.save();
        ctx.globalAlpha = freckleAlpha;
        ctx.fillStyle = fr.shade;
        ctx.beginPath();
        ctx.ellipse(
          fx,
          fy,
          fr.radius * clusterScale * fScale,
          fr.radius * 0.7 * clusterScale * fScale,
          0.3,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.restore();
      }
    }

    // Silky luminous midrib groove highlight
    ctx.beginPath();
    traceSmoothSpline(ctx, midrib.slice(1, -1), true);
    ctx.strokeStyle = 'rgba(255, 232, 244, 0.42)';
    ctx.lineWidth = Math.max(0.9, 1.2 * bScale);
    ctx.stroke();

    ctx.restore(); // End tepal clip

    // 3. Luminous rose-white rim highlight along the smooth outer petal contour
    ctx.beginPath();
    traceSmoothSpline(ctx, leftOuter, true);
    traceSmoothSpline(ctx, rightOuterReversed, false);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 220, 240, 0.8)';
    ctx.lineWidth = Math.max(1.0, 1.45 * bScale);
    ctx.stroke();

    ctx.restore();
  }

  function renderSmoothStamen(item) {
    const { pts, antherAngle, bScale } = item;
    if (pts.length < 2) return;

    const pStart = pts[0];
    const pEnd = pts[pts.length - 1];

    ctx.save();
    ctx.shadowColor = 'rgba(255, 195, 65, 0.85)';
    ctx.shadowBlur = 14 * bScale;

    const filGrad = ctx.createLinearGradient(pStart.x, pStart.y, pEnd.x, pEnd.y);
    filGrad.addColorStop(0.0, '#84cc16');
    filGrad.addColorStop(0.65, '#bef264');
    filGrad.addColorStop(1.0, '#fef9c3');

    ctx.beginPath();
    traceSmoothSpline(ctx, pts, true);
    ctx.strokeStyle = filGrad;
    ctx.lineWidth = Math.max(1.2, 2.2 * bScale);
    ctx.lineCap = 'round';
    ctx.stroke();

    // Plump rust-orange / gold pollen anther (#ea580c -> #fb923c -> #fde047)
    const antherW = 8.6 * bScale * pEnd.scale;
    const antherH = 4.3 * bScale * pEnd.scale;

    ctx.translate(pEnd.x, pEnd.y);
    ctx.rotate(antherAngle);

    const aGrad = ctx.createLinearGradient(-antherW, -antherH, antherW, antherH);
    aGrad.addColorStop(0.0, '#ea580c');
    aGrad.addColorStop(0.55, '#fb923c');
    aGrad.addColorStop(1.0, '#fde047');

    ctx.fillStyle = aGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, antherW, antherH, 0, 0, Math.PI * 2);
    ctx.fill();

    // Central anther groove
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(124, 45, 18, 0.55)';
    ctx.lineWidth = 0.9 * bScale;
    ctx.beginPath();
    ctx.moveTo(-antherW * 0.72, 0);
    ctx.lineTo(antherW * 0.72, 0);
    ctx.stroke();

    ctx.restore();
  }

  function renderSmoothPistil(item) {
    const { pts, bScale } = item;
    if (pts.length < 2) return;

    const pStart = pts[0];
    const pEnd = pts[pts.length - 1];

    ctx.save();
    ctx.shadowColor = 'rgba(255, 195, 65, 0.85)';
    ctx.shadowBlur = 14 * bScale;

    const styleGrad = ctx.createLinearGradient(pStart.x, pStart.y, pEnd.x, pEnd.y);
    styleGrad.addColorStop(0.0, '#65a30d');
    styleGrad.addColorStop(0.68, '#bef264');
    styleGrad.addColorStop(1.0, '#fef08a');

    ctx.beginPath();
    traceSmoothSpline(ctx, pts, true);
    ctx.strokeStyle = styleGrad;
    ctx.lineWidth = Math.max(1.6, 2.9 * bScale);
    ctx.lineCap = 'round';
    ctx.stroke();

    // 3-lobed glowing golden-lime stigma crown
    const lobeR = 3.6 * bScale * pEnd.scale;
    ctx.translate(pEnd.x, pEnd.y);

    for (let l = 0; l < 3; l++) {
      const ang = (l * Math.PI * 2) / 3 - Math.PI / 6;
      const lx = Math.cos(ang) * lobeR * 0.85;
      const ly = Math.sin(ang) * lobeR * 0.85;

      const sGrad = ctx.createRadialGradient(lx - 1, ly - 1, 0.4, lx, ly, lobeR * 1.25);
      sGrad.addColorStop(0.0, '#fef9c3');
      sGrad.addColorStop(0.6, '#fde047');
      sGrad.addColorStop(1.0, '#84cc16');

      ctx.fillStyle = sGrad;
      ctx.beginPath();
      ctx.arc(lx, ly, lobeR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // ============================================================================
  // MAIN ANIMATION LOOP
  // ============================================================================
  let prevTimestamp = performance.now();
  let physicsAccumulator = 0;

  function render(now) {
    if (now - prevTimestamp < 1000 / 30) {
      requestAnimationFrame(render);
      return;
    }
    const elapsed = Math.min(Math.max((now - prevTimestamp) / 1000, 0.001), 0.05);
    prevTimestamp = now;
    const timeSec = (now - startTime) / 1000;

    // Fixed 60 Hz physics prevents jitter and frame-rate-dependent spring motion.
    physicsAccumulator = Math.min(physicsAccumulator + elapsed, 0.25);
    while (physicsAccumulator >= fixedFrameTime) {
      const stiffness = 18.0;
      const damping = 5.4;
      const ax = (breeze.targetX - breeze.posX) * stiffness - breeze.velX * damping;
      const ay = (breeze.targetY - breeze.posY) * stiffness - breeze.velY * damping;
      breeze.velX += ax * fixedFrameTime;
      breeze.velY += ay * fixedFrameTime;
      breeze.posX += breeze.velX * fixedFrameTime;
      breeze.posY += breeze.velY * fixedFrameTime;

      breeze.targetX = lerp(breeze.targetX, 0, 1.4 * fixedFrameTime);
      breeze.targetY = lerp(breeze.targetY, 0, 1.4 * fixedFrameTime);
      physicsAccumulator -= fixedFrameTime;
    }
    const dt = elapsed;

    // Average bloom progress for synchronized hero aura pulsing
    let bloomSum = 0;
    let bloomCount = 0;
    for (let i = 0; i < stems.length; i++) {
      if (stems[i].bloom) {
        bloomSum += easeInOutSine((timeSec - stems[i].bloom.bloomDelay) / stems[i].bloom.bloomDuration);
        bloomCount++;
      }
    }
    const avgBloom = bloomCount > 0 ? bloomSum / bloomCount : 0;

    // 1. Deep Twilight Sky, Bokeh & Pulsing Magenta-Pink Ambient Aura
    drawAtmosphere(timeSec, avgBloom);

    // 2. Rising Golden Fireflies & Glowing Pollen Sparks
    drawFirefliesAndPollen(timeSec, dt);

    // 3. Render Stargazer Lily Cluster sorted back-to-front
    const anchorX = width * 0.5;
    const anchorY = height * 0.94;
    const orderedStems = [...stems].sort((a, b) => a.zOrder - b.zOrder);

    for (let i = 0; i < orderedStems.length; i++) {
      const s = orderedStems[i];
      const stemGrowth = easeOutCubic((timeSec - s.growDelay) / s.growDuration);
      if (stemGrowth <= 0.005) continue;

      const harmonicSway = Math.sin(timeSec * 1.15 + s.swayPhase) * s.swayAmp +
                           Math.sin(timeSec * 0.55 + s.swayPhase * 1.7) * (s.swayAmp * 0.45);
      const totalSwayX = (harmonicSway + breeze.posX) * clusterScale;
      const totalSwayY = breeze.posY * 0.45 * clusterScale;

      const p0 = {
        x: anchorX + s.baseOffset.x * clusterScale,
        y: anchorY + s.baseOffset.y * clusterScale
      };
      const p1 = {
        x: anchorX + s.ctrlOffset.x * clusterScale + totalSwayX * 0.45,
        y: anchorY + s.ctrlOffset.y * clusterScale + totalSwayY * 0.4
      };
      const p2 = {
        x: anchorX + s.tipOffset.x * clusterScale + totalSwayX,
        y: anchorY + s.tipOffset.y * clusterScale + totalSwayY
      };

      // Back leaves
      for (let l = 0; l < s.leaves.length; l++) {
        const lf = s.leaves[l];
        if (lf.depthLayer < 0 && stemGrowth >= lf.t) {
          const unfurl = easeOutCubic((timeSec - (s.growDelay + lf.unfurlDelay)) / 0.85);
          const pt = quadBezier(p0, p1, p2, lf.t);
          const tan = quadBezierTangent(p0, p1, p2, lf.t);
          drawSmoothLanceolateLeaf(pt, tan, lf, unfurl, (harmonicSway + breeze.posX) * 0.08);
        }
      }

      // Continuous tapered spline ribbon stem
      drawSmoothRibbonStem(p0, p1, p2, stemGrowth, s.thickness, s.thickness * 0.62);

      // Upper-right 3-ribbed lime-green bud branch
      if (s.budBranch && stemGrowth >= s.budBranch.attachT) {
        const bb = s.budBranch;
        const branchGrow = easeOutCubic((timeSec - (s.growDelay + bb.delay)) / 1.1);
        const attachPt = quadBezier(p0, p1, p2, bb.attachT);
        const bp0 = attachPt;
        const bp1 = {
          x: attachPt.x + bb.ctrlOffset.x * clusterScale + totalSwayX * 0.25,
          y: attachPt.y + bb.ctrlOffset.y * clusterScale
        };
        const bp2 = {
          x: attachPt.x + bb.tipOffset.x * clusterScale + totalSwayX * 0.45,
          y: attachPt.y + bb.tipOffset.y * clusterScale
        };

        drawSmoothRibbonStem(bp0, bp1, bp2, branchGrow, 5.2, 4.0);
        if (branchGrow > 0.65) {
          const budPt = quadBezier(bp0, bp1, bp2, branchGrow);
          const budTan = quadBezierTangent(bp0, bp1, bp2, branchGrow);
          const budScale = easeOutCubic((branchGrow - 0.65) / 0.35);
          drawSmoothRibbedBud(budPt, budTan, bb, budScale, timeSec);
        }
      }

      // Foreground leaves
      for (let l = 0; l < s.leaves.length; l++) {
        const lf = s.leaves[l];
        if (lf.depthLayer >= 0 && stemGrowth >= lf.t) {
          const unfurl = easeOutCubic((timeSec - (s.growDelay + lf.unfurlDelay)) / 0.85);
          const pt = quadBezier(p0, p1, p2, lf.t);
          const tan = quadBezierTangent(p0, p1, p2, lf.t);
          drawSmoothLanceolateLeaf(pt, tan, lf, unfurl, (harmonicSway + breeze.posX) * 0.08);
        }
      }

      // Luminous 3D Stargazer Oriental Lily Blossom
      if (s.bloom && stemGrowth > 0.72) {
        const tipPt = quadBezier(p0, p1, p2, stemGrowth);
        const bloomProg = easeInOutSine((timeSec - s.bloom.bloomDelay) / s.bloom.bloomDuration);
        drawStargazerBlossom(tipPt.x, tipPt.y, s.bloom, bloomProg, timeSec);
      }
    }

    requestAnimationFrame(render);
  }

  window.onload = () => {
    resize();
    initCluster();
    initAtmosphere();
    prevTimestamp = performance.now();
    requestAnimationFrame(render);
  };
})();
