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
