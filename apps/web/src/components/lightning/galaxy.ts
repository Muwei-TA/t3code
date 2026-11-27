import { observeResize } from "~/lib/observeResize";

// The two orbital planes are painted on resize or palette changes. Their movement is composited.
const TAU = Math.PI * 2;

function seededNoise(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function paintOrbit(canvas: HTMLCanvasElement, pixels: number, inner: boolean) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = canvas.height = pixels;
  const scale = pixels / 1000;
  ctx.setTransform(scale, 0, 0, scale, pixels / 2, pixels / 2);
  const style = getComputedStyle(canvas);
  const ice = style.getPropertyValue("--orbit-ice").trim();
  const iris = style.getPropertyValue("--orbit-iris").trim();
  const copper = style.getPropertyValue("--orbit-copper").trim();
  const pearl = style.getPropertyValue("--orbit-pearl").trim();
  const next = seededNoise(inner ? 83177 : 95719);
  const count = inner ? 470 : 1800;
  const hazeCount = inner ? 35 : 130;
  const near = inner ? 165 : 113;

  // Broken filaments give the arms a continuous direction even where the stars thin out.
  for (const [arm, tint] of [ice, iris, copper].entries()) {
    const far = 490 - arm * 24;
    const ink = ctx.createRadialGradient(0, 0, near, 0, 0, far);
    ink.addColorStop(0, "transparent");
    ink.addColorStop(0.28, tint);
    ink.addColorStop(0.66, tint);
    ink.addColorStop(1, "transparent");
    ctx.strokeStyle = ink;
    for (let strand = 0; strand < 9; strand++) {
      const offset = (next() - 0.5) * 0.36;
      const start = next() * 0.38;
      const length = 0.28 + next() * 0.34;
      ctx.lineWidth = strand < 3 ? 2.4 : 0.55;
      ctx.globalAlpha = strand < 3 ? 0.062 : 0.24;
      ctx.beginPath();
      for (let j = 0; j <= 64; j++) {
        const t = start + (length * j) / 64;
        const radius = near + (far - near) * t;
        const angle =
          (arm * TAU) / 3 + Math.log(radius / near) * 2.38 + offset + 0.035 * Math.sin(t * 8 + arm);
        ctx.lineTo(radius * Math.cos(angle), radius * Math.sin(angle));
      }
      ctx.stroke();
    }
  }

  if (!inner) {
    ctx.fillStyle = pearl;
    for (let i = 0; i < 430; i++) {
      const x = (next() - 0.5) * 1000;
      const y = (next() - 0.5) * 1000;
      const radius = Math.hypot(x, y);
      ctx.globalAlpha = Math.max(0, Math.min(0.42, radius / 500, (495 - radius) / 140)) * next();
      ctx.fillRect(x, y, 0.85, 1);
    }
  }

  for (let i = 0; i < count; i++) {
    const arm = i % 3;
    const far = 490 - arm * 24;
    const radius = near + next() * (far - near);
    const spread = next() + next() + next() - 1.5;
    const angle = (arm * TAU) / 3 + Math.log(radius / near) * 2.38 + spread * 0.38;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    const tint = arm === 0 ? ice : arm === 1 ? iris : copper;
    const taper = Math.min(1, (radius - near) / 42, (far - radius) / 75);
    if (i < hazeCount) {
      const size = 22 + next() * 44;
      const haze = ctx.createRadialGradient(x, y, 0, x, y, size);
      haze.addColorStop(0, tint);
      haze.addColorStop(1, "transparent");
      ctx.globalAlpha = taper * (inner ? 0.029 : 0.036);
      ctx.fillStyle = haze;
      ctx.fillRect(x - size, y - size, size * 2, size * 2);
    }
    const hot = next() > 0.956;
    ctx.globalAlpha = taper * (0.18 + next() * (hot ? 0.82 : 0.52));
    ctx.fillStyle = hot || i % 5 === 0 ? pearl : tint;
    const size = hot ? 1.12 : 0.32 + next() * 0.52;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, TAU);
    ctx.fill();
    if (hot) {
      ctx.globalAlpha *= 0.42;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(0, 0, radius, angle - 0.012 - next() * 0.02, angle);
      ctx.stroke();
    }
  }
}

export function releaseWarp(host: HTMLElement, anchor: Element | null | undefined) {
  const stage = host.closest<HTMLElement>("[data-chat-workspace-drop-target]") ?? host;
  const burst = document.createElement("canvas");
  burst.className = "lightning-warp-burst";
  burst.setAttribute("aria-hidden", "true");
  const ctx = burst.getContext("2d");
  if (!ctx) return;
  stage.querySelector(".lightning-warp-burst")?.remove();
  stage.appendChild(burst);
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const scale = Math.min(1, 1536 / Math.max(1, width, height));
  burst.width = Math.ceil(width * scale);
  burst.height = Math.ceil(height * scale);
  ctx.scale(scale, scale);
  const style = getComputedStyle(host);
  const ice = style.getPropertyValue("--orbit-ice");
  const pearl = style.getPropertyValue("--orbit-pearl");
  const next = seededNoise(27163);
  const capsule = anchor?.getBoundingClientRect();
  const bounds = stage.getBoundingClientRect();
  const cx = capsule ? capsule.left + capsule.width / 2 - bounds.left : width / 2;
  const cy = capsule ? capsule.top + capsule.height / 2 - bounds.top : height / 2;
  burst.style.transformOrigin = `${cx}px ${cy}px`;
  ctx.translate(cx, cy);
  ctx.rotate(-0.16);
  ctx.scale(1, 0.58);
  const radius = Math.max(width * 0.52, height * 0.64);
  const front = ctx.createRadialGradient(0, 0, radius * 0.48, 0, 0, radius * 0.65);
  front.addColorStop(0, "transparent");
  front.addColorStop(0.78, ice);
  front.addColorStop(1, "transparent");
  ctx.fillStyle = front;
  ctx.globalAlpha = 0.12;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.65, 0, TAU);
  ctx.fill();

  for (let i = 0; i < 145; i++) {
    const angle = next() * TAU;
    const start = radius * (0.29 + next() * 0.54);
    const end = start + 2 + next() ** 3 * 26;
    ctx.strokeStyle = i % 4 === 0 ? pearl : ice;
    ctx.globalAlpha = 0.16 + next() * 0.62;
    ctx.lineWidth = 0.5 + next();
    ctx.beginPath();
    ctx.moveTo(start * Math.cos(angle), start * Math.sin(angle));
    ctx.lineTo(end * Math.cos(angle), end * Math.sin(angle));
    ctx.stroke();
  }
  // The draft backdrop unmounts on first send. Let its sibling finish the remaining flight.
  const flight = burst.animate(
    [
      { transform: "scale(.76)", opacity: 0 },
      { opacity: 0.94, offset: 0.13 },
      { transform: "scale(1.48)", opacity: 0 },
    ],
    { duration: 800, easing: "cubic-bezier(.16,.64,.35,1)" },
  );
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cancel = () => flight.cancel();
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) cancel();
  });
  observer.observe(stage);
  motion.addEventListener("change", cancel);
  document.addEventListener("visibilitychange", cancel);
  const finish = () => {
    observer.disconnect();
    motion.removeEventListener("change", cancel);
    document.removeEventListener("visibilitychange", cancel);
    burst.remove();
  };
  void flight.finished.then(finish, finish);
}

interface SwarmStar {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  baseAlpha: number;
  orbitAngle: number;
  orbitRadius: number;
  orbitSpeed: number;
  tintIndex: number;
  sparklePhase: number;
}

export function attachStarSwarm(host: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const hoverMedia = window.matchMedia("(any-hover: hover)");
  const reducedMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stage =
    host.closest<HTMLElement>("[data-lightning-hero], [data-chat-workspace-drop-target]") ?? host;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let palette: readonly [string, string, string, string] = [
    "#73bed5",
    "#aa9de7",
    "#d8a781",
    "#e9f3ff",
  ];
  let stars: SwarmStar[] = [];

  let pointerActive = false;
  let px = 0;
  let py = 0;
  let prevPx = 0;
  let prevPy = 0;
  let pointerSpeed = 0;
  let scatterBurst = 0;
  let scatterX = 0;
  let scatterY = 0;
  let rafId = 0;
  let lastTime = 0;
  let elapsed = 0;

  const readPalette = () => {
    const style = getComputedStyle(host);
    palette = [
      style.getPropertyValue("--orbit-ice").trim() || "#73bed5",
      style.getPropertyValue("--orbit-iris").trim() || "#aa9de7",
      style.getPropertyValue("--orbit-copper").trim() || "#d8a781",
      style.getPropertyValue("--orbit-pearl").trim() || "#e9f3ff",
    ];
  };

  const seedStars = () => {
    const next = seededNoise(61907);
    const count = Math.min(200, Math.max(120, Math.round((width * height) / 7200)));
    const cx = width * 0.5;
    const cy = height * 0.51;
    const maxRx = Math.max(width * 0.52, 440);
    const maxRy = Math.max(height * 0.48, 300);
    const list: SwarmStar[] = [];
    for (let i = 0; i < count; i++) {
      // Blend spiral-arm stars with ambient background stars so hovering anywhere gathers stardust.
      let hx: number;
      let hy: number;
      if (i % 3 !== 0) {
        const arm = i % 3;
        const radius = 0.2 + next() * 0.85;
        const spread = (next() + next() - 1) * 0.42;
        const angle = (arm * TAU) / 3 + Math.log(1 + radius * 3.8) * 2.15 + spread - 0.22;
        hx = cx + Math.cos(angle) * maxRx * radius;
        hy = cy + Math.sin(angle) * maxRy * radius * 0.78;
      } else {
        hx = width * (0.04 + next() * 0.92);
        hy = height * (0.05 + next() * 0.9);
      }
      if (hx < 8 || hx > width - 8 || hy < 8 || hy > height - 8) {
        hx = width * (0.06 + next() * 0.88);
        hy = height * (0.08 + next() * 0.84);
      }
      const sizeRoll = next();
      const size = sizeRoll > 0.88 ? 2.15 : sizeRoll > 0.55 ? 1.45 : 0.95;
      list.push({
        homeX: hx,
        homeY: hy,
        x: hx,
        y: hy,
        vx: 0,
        vy: 0,
        size,
        baseAlpha: 0.24 + next() * 0.44,
        orbitAngle: next() * TAU,
        orbitRadius: 20 + next() * 58,
        orbitSpeed: (next() > 0.5 ? 1 : -1) * (0.9 + next() * 1.3),
        tintIndex: i % 5 === 0 ? 3 : i % 3,
        sparklePhase: next() * TAU,
      });
    }
    stars = list;
  };

  const renderIdle = () => {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    for (const s of stars) {
      ctx.globalAlpha = s.baseAlpha * 0.72;
      ctx.fillStyle = palette[s.tintIndex] ?? palette[3];
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, TAU);
      ctx.fill();
    }
  };

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const nextW = Math.max(1, Math.round(rect.width));
    const nextH = Math.max(1, Math.round(rect.height));
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (nextW === width && nextH === height && nextDpr === dpr) return;
    width = nextW;
    height = nextH;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    readPalette();
    seedStars();
    renderIdle();
  };

  const stopLoop = () => {
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const isRunnable = () =>
    hoverMedia.matches &&
    !reducedMedia.matches &&
    !document.hidden &&
    host.style.getPropertyValue("--visible-animation-state") !== "paused";

  const step = (now: number) => {
    if (!isRunnable()) {
      rafId = 0;
      return;
    }
    const dt = lastTime === 0 ? 0.016 : Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    elapsed += dt;
    pointerSpeed *= Math.pow(0.08, dt);
    scatterBurst = Math.max(0, scatterBurst - dt * 2.4);

    ctx.clearRect(0, 0, width, height);
    const gatherRadius = 225;
    const gatherRadiusSq = gatherRadius * gatherRadius;
    const fastSweep = pointerSpeed > 720;
    const gathered: SwarmStar[] = [];
    let energy = 0;

    for (const s of stars) {
      let fx = (s.homeX - s.x) * 3.1;
      let fy = (s.homeY - s.y) * 3.1;
      let proximity = 0;

      if (pointerActive) {
        const dx = px - s.x;
        const dy = py - s.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < gatherRadiusSq && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          proximity = 1 - dist / gatherRadius;
          s.orbitAngle += s.orbitSpeed * dt;

          if (fastSweep) {
            // Fast cursor sweep fans stars outward like a luminous stardust wake before reconverging.
            const push = (1 - dist / gatherRadius) * Math.min(480, pointerSpeed * 0.42);
            fx -= (dx / dist) * push;
            fy -= (dy / dist) * push;
          } else {
            // Hovering draws stars into a graceful swirling halo ring around the cursor ("聚").
            const targetX = px + Math.cos(s.orbitAngle) * s.orbitRadius;
            const targetY = py + Math.sin(s.orbitAngle) * s.orbitRadius;
            const pull = 10.5 * proximity * (0.45 + proximity * 0.85);
            fx += (targetX - s.x) * pull;
            fy += (targetY - s.y) * pull;
            // Subtle tangential swirl around the pointer.
            fx += (-dy / dist) * 24 * proximity;
            fy += (dx / dist) * 24 * proximity;
          }
          if (proximity > 0.32) gathered.push(s);
        }
      }

      if (scatterBurst > 0.01) {
        // Click or release triggers a sparkling radial dispersion pulse ("散").
        const sdx = s.x - scatterX;
        const sdy = s.y - scatterY;
        const sDist = Math.hypot(sdx, sdy) || 1;
        if (sDist < 280) {
          const blast = (1 - sDist / 280) * 620 * scatterBurst;
          fx += (sdx / sDist) * blast;
          fy += (sdy / sDist) * blast;
        }
      }

      const damping = Math.pow(0.06, dt);
      s.vx = (s.vx + fx * dt) * damping;
      s.vy = (s.vy + fy * dt) * damping;
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      const disp = Math.abs(s.x - s.homeX) + Math.abs(s.y - s.homeY);
      const vel = Math.abs(s.vx) + Math.abs(s.vy);
      if (disp > energy) energy = disp;
      if (vel > energy) energy = vel;

      const twinkle = 0.82 + 0.18 * Math.sin(elapsed * 3.4 + s.sparklePhase);
      const alpha = Math.min(1, (s.baseAlpha * 0.72 + proximity * 0.62) * twinkle);
      const drawSize = s.size * (1 + proximity * 0.55);
      const color = palette[s.tintIndex] ?? palette[3];

      if (proximity > 0.38 && drawSize > 1.35) {
        ctx.globalAlpha = alpha * 0.24;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, drawSize * 2.9, 0, TAU);
        ctx.fill();
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = proximity > 0.62 ? palette[3] : color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, drawSize, 0, TAU);
      ctx.fill();
    }

    // Delicate constellation filaments connecting the tightest gathered stars around the cursor.
    if (pointerActive && gathered.length > 1) {
      const limit = Math.min(gathered.length, 26);
      ctx.lineWidth = 0.65;
      ctx.strokeStyle = palette[0];
      for (let i = 0; i < limit; i++) {
        const a = gathered[i]!;
        for (let j = i + 1; j < limit; j++) {
          const b = gathered[j]!;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 64) {
            ctx.globalAlpha = (1 - d / 64) * 0.26;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    if (!pointerActive && scatterBurst <= 0.01 && energy < 0.35) {
      // Snap cleanly back to rest and sleep RAF until the next pointer interaction.
      for (const s of stars) {
        s.x = s.homeX;
        s.y = s.homeY;
        s.vx = 0;
        s.vy = 0;
      }
      renderIdle();
      rafId = 0;
      return;
    }

    rafId = window.requestAnimationFrame(step);
  };

  const ensureLoop = () => {
    if (!isRunnable() || rafId !== 0) return;
    lastTime = 0;
    rafId = window.requestAnimationFrame(step);
  };

  const controller = new AbortController();
  const signal = controller.signal;

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !isRunnable()) return;
    const rect = host.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) {
      if (pointerActive) {
        pointerActive = false;
        // Soft outward dispersion pulse as the cursor leaves the galaxy stage.
        scatterX = px;
        scatterY = py;
        scatterBurst = 0.42;
        ensureLoop();
      }
      return;
    }
    const nx = event.clientX - rect.left;
    const ny = event.clientY - rect.top;
    if (pointerActive) {
      const dist = Math.hypot(nx - prevPx, ny - prevPy);
      pointerSpeed = Math.min(1800, pointerSpeed * 0.55 + dist * 24);
    } else {
      pointerSpeed = 0;
    }
    prevPx = nx;
    prevPy = ny;
    px = nx;
    py = ny;
    pointerActive = true;
    ensureLoop();
  };

  const onPointerLeave = () => {
    if (!pointerActive) return;
    pointerActive = false;
    scatterX = px;
    scatterY = py;
    scatterBurst = 0.48;
    ensureLoop();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !isRunnable()) return;
    const rect = host.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return;
    }
    scatterX = event.clientX - rect.left;
    scatterY = event.clientY - rect.top;
    scatterBurst = 1;
    ensureLoop();
  };

  const onSendScatter = () => {
    if (!isRunnable() || !width || !height) return;
    scatterX = width * 0.5;
    scatterY = height * 0.52;
    scatterBurst = 1.15;
    ensureLoop();
  };

  const onThemeOrModeChange = () => {
    readPalette();
    if (!isRunnable()) {
      stopLoop();
      pointerActive = false;
      for (const s of stars) {
        s.x = s.homeX;
        s.y = s.homeY;
        s.vx = 0;
        s.vy = 0;
      }
    }
    renderIdle();
  };

  const themeObserver = new MutationObserver(onThemeOrModeChange);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme-id"],
  });

  const stopResize = observeResize(host, resize);

  document.addEventListener("pointermove", onPointerMove, { passive: true, signal });
  document.addEventListener("pointerdown", onPointerDown, { passive: true, signal });
  document.documentElement.addEventListener("pointerleave", onPointerLeave, { signal });
  stage.addEventListener("pointerleave", onPointerLeave, { signal });
  document.addEventListener("visibilitychange", onThemeOrModeChange, { signal });
  window.addEventListener("lightning:composer-send", onSendScatter, { signal });
  hoverMedia.addEventListener("change", onThemeOrModeChange, { signal });
  reducedMedia.addEventListener("change", onThemeOrModeChange, { signal });

  resize();

  return () => {
    stopLoop();
    controller.abort();
    themeObserver.disconnect();
    stopResize();
  };
}
