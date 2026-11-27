import { use, useEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import { LightningShell } from "./shell";

interface GalaxyParticle {
  angle: number;
  radiusNorm: number;
  speed: number;
  size: number;
  alpha: number;
  trail: number;
  colorIndex: number;
}

const DARK_PALETTE = [
  "255, 255, 255",
  "147, 197, 253",
  "196, 181, 253",
  "253, 224, 150",
  "103, 232, 249",
] as const;

const LIGHT_PALETTE = [
  "30, 41, 59",
  "37, 99, 235",
  "99, 102, 241",
  "217, 119, 6",
  "14, 116, 144",
] as const;

function createGalaxyParticles(): GalaxyParticle[] {
  let seed = 0x51a7f319;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const particles: GalaxyParticle[] = [];
  for (let i = 0; i < 320; i++) {
    const radiusNorm = 0.16 + Math.pow(next(), 0.78) * 0.92;
    const angle = next() * Math.PI * 2;
    // Keplerian-inspired drift: inner vortex rings swirl gently faster around the composer.
    const speed = (0.045 + (1 - radiusNorm) * 0.14) * (0.75 + next() * 0.5);
    const sizeRoll = next();
    const size = sizeRoll > 0.92 ? 2.1 : sizeRoll > 0.65 ? 1.4 : 0.9;
    const alpha = 0.2 + (1 - radiusNorm * 0.65) * 0.65 * (0.55 + next() * 0.45);
    const trail = i % 3 === 0 ? 0.045 + (1 - radiusNorm) * 0.08 : 0.015 + next() * 0.02;
    const colorRoll = next();
    const colorIndex =
      colorRoll > 0.9 ? 3 : colorRoll > 0.78 ? 4 : colorRoll > 0.62 ? 1 : colorRoll > 0.48 ? 2 : 0;
    particles.push({ angle, radiusNorm, speed, size, alpha, trail, colorIndex });
  }
  return particles;
}

export function LightningCosmicBackdrop({ variant = "hero" }: { variant?: "hero" | "draft" }) {
  const shell = use(LightningShell);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the offscreen-pausable galaxy vortex canvas animation loop and event listeners
  useEffect(() => {
    if (shell === "classic") return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const particles = createGalaxyParticles();
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    let width = 0;
    let height = 0;
    let dpr = 1;
    let visible = true;
    let rafId = 0;
    let lastTs = 0;
    let typingEnergy = 0;
    let warpEnergy = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawFrame = (dtSec: number) => {
      if (width <= 1 || height <= 1) return;
      const isDark = document.documentElement.classList.contains("dark");
      const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
      const alphaScale = isDark ? 1 : 0.45;

      typingEnergy = Math.max(0, typingEnergy - dtSec * 1.1);
      warpEnergy = Math.max(0, warpEnergy - dtSec * 2.4);

      const speedFactor = 1 + typingEnergy * 0.9 + warpEnergy * 3.8;
      const cx = width * 0.5;
      const cy = height * (variant === "draft" ? 0.52 : 0.5);
      const maxRx = Math.max(width * 0.58, 520);
      const maxRy = Math.max(height * 0.52, 340);

      ctx.clearRect(0, 0, width, height);

      // Subtle inner event-horizon ring framing the floating composer capsule.
      const horizonGlow = ctx.createRadialGradient(
        cx,
        cy,
        Math.min(maxRx, maxRy) * 0.14,
        cx,
        cy,
        Math.min(maxRx, maxRy) * 0.68,
      );
      if (isDark) {
        const boost = 0.05 + typingEnergy * 0.04 + warpEnergy * 0.1;
        horizonGlow.addColorStop(0, "rgba(99, 102, 241, 0)");
        horizonGlow.addColorStop(0.45, `rgba(99, 102, 241, ${boost.toFixed(3)})`);
        horizonGlow.addColorStop(0.72, `rgba(56, 189, 248, ${(boost * 0.55).toFixed(3)})`);
        horizonGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      } else {
        horizonGlow.addColorStop(0, "rgba(59, 130, 246, 0)");
        horizonGlow.addColorStop(0.5, "rgba(99, 102, 241, 0.045)");
        horizonGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
      }
      ctx.fillStyle = horizonGlow;
      ctx.fillRect(0, 0, width, height);

      for (const p of particles) {
        p.angle += p.speed * speedFactor * dtSec;
        const rx = maxRx * (0.28 + p.radiusNorm * 0.78);
        const ry = maxRy * (0.24 + p.radiusNorm * 0.8);
        const swirlOffset = (1 - p.radiusNorm) * 0.55;
        const a = p.angle + swirlOffset;
        const x = cx + Math.cos(a) * rx;
        const y = cy + Math.sin(a) * ry;

        if (x < -24 || x > width + 24 || y < -24 || y > height + 24) continue;

        // Soft fade inside the immediate composer reading zone so copy stays razor legible.
        const nx = (x - cx) / Math.min(340, width * 0.34);
        const ny = (y - cy) / 145;
        const centerDistSq = nx * nx + ny * ny;
        const centerFade = Math.min(1, Math.max(0.08, (centerDistSq - 0.55) / 0.75));
        const finalAlpha = Math.min(1, p.alpha * centerFade * alphaScale * (1 + warpEnergy * 0.35));
        const rgb = palette[p.colorIndex] ?? palette[0];

        // Curved orbital streak trail matching Krea's gravitational vortex look.
        const trailSpan = p.trail * (1 + typingEnergy * 0.55 + warpEnergy * 2.2);
        const aPrev = a - trailSpan;
        const aMid = a - trailSpan * 0.5;
        const xPrev = cx + Math.cos(aPrev) * rx;
        const yPrev = cy + Math.sin(aPrev) * ry;
        const xMid = cx + Math.cos(aMid) * (rx + 3);
        const yMid = cy + Math.sin(aMid) * (ry + 2);

        ctx.beginPath();
        ctx.moveTo(xPrev, yPrev);
        ctx.quadraticCurveTo(xMid, yMid, x, y);
        ctx.strokeStyle = `rgba(${rgb}, ${(finalAlpha * 0.55).toFixed(3)})`;
        ctx.lineWidth = p.size * 0.72;
        ctx.lineCap = "round";
        ctx.stroke();

        // Crisp star head.
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb}, ${finalAlpha.toFixed(3)})`;
        ctx.fill();
      }
    };

    const tick = (now: number) => {
      if (!visible || document.hidden || reducedMotionQuery.matches) {
        rafId = 0;
        return;
      }
      // Cap updates around ~30fps for fluid cosmic motion with minimal GPU footprint.
      if (lastTs === 0 || now - lastTs >= 30) {
        const dtSec = lastTs === 0 ? 0.016 : Math.min(0.08, (now - lastTs) / 1000);
        lastTs = now;
        drawFrame(dtSec);
      }
      rafId = window.requestAnimationFrame(tick);
    };

    const syncLoop = () => {
      if (!visible || document.hidden || reducedMotionQuery.matches) {
        if (rafId !== 0) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        if (reducedMotionQuery.matches) drawFrame(0);
        return;
      }
      if (rafId === 0) {
        lastTs = 0;
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onTyping = () => {
      typingEnergy = 1;
    };
    const onSend = () => {
      warpEnergy = 1;
    };

    resize();
    drawFrame(0);
    syncLoop();

    const stopObservingResize = observeResize(host, () => {
      resize();
      if (reducedMotionQuery.matches) drawFrame(0);
    });

    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      syncLoop();
    });
    intersectionObserver.observe(host);

    document.addEventListener("visibilitychange", syncLoop);
    reducedMotionQuery.addEventListener("change", syncLoop);
    window.addEventListener("lightning:composer-typing", onTyping);
    window.addEventListener("lightning:composer-send", onSend);

    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      stopObservingResize();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", syncLoop);
      reducedMotionQuery.removeEventListener("change", syncLoop);
      window.removeEventListener("lightning:composer-typing", onTyping);
      window.removeEventListener("lightning:composer-send", onSend);
    };
  }, [shell, variant]);

  if (shell === "classic") return null;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-lightning-cosmic-backdrop={variant}
      className="lightning-cosmic-backdrop pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <div className="lightning-zenith-beam" />
      <div className="lightning-dot-grid" />
      <canvas ref={canvasRef} className="lightning-vortex-canvas" />
      <div className="lightning-horizon-arc" />
    </div>
  );
}
