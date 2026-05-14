"use client";

import { useEffect, useRef } from "react";
import type { AuraState, IntentMode } from "@/lib/agent/manifest";
import { INTENT_PALETTE } from "@/lib/design/intent-palette";

/**
 * Aura — the canvas-rendered liquid orb at the centre of the scene.
 * Ported verbatim from aura.jsx in the design bundle: DPR scaling, layered
 * radial blobs, orbital particles in `thinking`, success flash ring,
 * smoothed pseudo-FFT bins.
 *
 * IMPORTANT: canvas internal dimensions are larger than the visible aura
 * footprint so the halo gradient has room to fade fully to alpha 0 before
 * hitting the canvas edge. This prevents the visible "square" artifact.
 */

interface StateRef {
  state: AuraState;
  intent: IntentMode;
  freq: number;
  time: number;
  success: number;
}

export function Aura({
  state = "idle",
  intent = "cook",
  size = 340,
}: {
  state?: AuraState;
  intent?: IntentMode;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<StateRef>({ state, intent, freq: 0, time: 0, success: 0 });

  useEffect(() => {
    stateRef.current.state = state;
    stateRef.current.intent = intent;
    if (state === "success") {
      stateRef.current.success = 1;
    }
  }, [state, intent]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    const pad = 1.6;
    const canvasSize = size * pad;

    canvas.width = canvasSize * dpr;
    canvas.height = canvasSize * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    const start = performance.now();
    const freqBins = new Array<number>(32).fill(0);

    const tick = (t: number) => {
      const elapsed = (t - start) / 1000;
      stateRef.current.time = elapsed;
      const s = stateRef.current.state;
      const intentNow = stateRef.current.intent;
      const palette = INTENT_PALETTE[intentNow] ?? INTENT_PALETTE.cook;

      for (let i = 0; i < freqBins.length; i++) {
        let target = 0;
        if (s === "listening") {
          target =
            (Math.sin(elapsed * 6 + i * 0.5) * 0.5 + 0.5) *
            (Math.sin(elapsed * 11 + i * 0.2) * 0.4 + 0.6) *
            0.9;
        } else if (s === "speaking") {
          target = (Math.sin(elapsed * 4 + i * 0.3) * 0.5 + 0.5) * 0.7;
        } else if (s === "thinking") {
          target = i < 8 ? (Math.sin(elapsed * 2 + i) * 0.5 + 0.5) * 0.4 : 0.05;
        } else if (s === "idle") {
          target = 0.18 + Math.sin(elapsed * 0.8 + i * 0.1) * 0.05;
        } else if (s === "success") {
          target = 0.5;
        }
        freqBins[i] += (target - freqBins[i]) * 0.18;
      }

      if (stateRef.current.success > 0) {
        stateRef.current.success = Math.max(0, stateRef.current.success - 0.012);
      }

      ctx.clearRect(0, 0, canvasSize, canvasSize);
      const cx = canvasSize / 2;
      const cy = canvasSize / 2;
      const baseRadius = size * 0.28;

      const avgFreq = freqBins.reduce((a, b) => a + b, 0) / freqBins.length;
      const breath = Math.sin(elapsed * 1.2) * 0.04 + 1;

      // Outer halo — arc(), not fillRect, so no square risk
      const haloR =
        baseRadius * (2.6 + avgFreq * 0.8 + stateRef.current.success * 0.6);
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        baseRadius * 0.4,
        cx,
        cy,
        haloR
      );
      const hueShift = s === "thinking" ? 20 : 0;
      halo.addColorStop(
        0,
        `hsla(${palette.h + hueShift}, 95%, 60%, ${
          0.3 + avgFreq * 0.35 + stateRef.current.success * 0.45
        })`
      );
      halo.addColorStop(
        0.35,
        `hsla(${palette.h + hueShift}, 80%, 50%, ${0.1 + avgFreq * 0.15})`
      );
      halo.addColorStop(0.75, `hsla(${palette.h + hueShift}, 70%, 45%, 0.03)`);
      halo.addColorStop(1, `hsla(${palette.h + hueShift}, 70%, 40%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // Layered radial blobs
      const layers = 6;
      for (let i = 0; i < layers; i++) {
        const phase = elapsed * (0.6 + i * 0.15) + i * 1.7;
        const wobbleAmp = 0.08 + avgFreq * 0.18;
        const r =
          baseRadius *
          (0.9 + i * 0.04) *
          breath *
          (1 + Math.sin(phase) * wobbleAmp);

        const band = freqBins[(i * 3) % freqBins.length];
        const dx = Math.cos(phase * 1.3) * baseRadius * 0.18 * band;
        const dy = Math.sin(phase * 0.9) * baseRadius * 0.18 * band;

        const lightness = 50 + i * 4 + (s === "thinking" ? 5 : 0);
        const alpha = (0.18 - i * 0.022) * (1 + avgFreq * 0.5);

        const grad = ctx.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
        grad.addColorStop(
          0,
          `hsla(${palette.h + i * 4}, ${palette.s * 100}%, ${lightness}%, ${
            alpha * 2.2
          })`
        );
        grad.addColorStop(
          0.5,
          `hsla(${palette.h + i * 4}, ${palette.s * 100}%, ${lightness - 10}%, ${alpha})`
        );
        grad.addColorStop(1, `hsla(${palette.h}, ${palette.s * 100}%, 30%, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Inner bright core
      const coreR = baseRadius * (0.35 + avgFreq * 0.15) * breath;
      const core = ctx.createRadialGradient(cx, cy - coreR * 0.2, 0, cx, cy, coreR);
      core.addColorStop(
        0,
        `hsla(${palette.h + 10}, 100%, 92%, ${0.7 + stateRef.current.success * 0.3})`
      );
      core.addColorStop(0.4, `hsla(${palette.h + 5}, 100%, 70%, 0.45)`);
      core.addColorStop(1, `hsla(${palette.h}, 90%, 55%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.4, 0, Math.PI * 2);
      ctx.fill();

      // Rim light (specular) — clipped to circle
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * breath, 0, Math.PI * 2);
      ctx.clip();
      const rim = ctx.createRadialGradient(
        cx - baseRadius * 0.45,
        cy - baseRadius * 0.45,
        0,
        cx - baseRadius * 0.45,
        cy - baseRadius * 0.45,
        baseRadius * 0.9
      );
      rim.addColorStop(0, "rgba(255, 250, 240, 0.55)");
      rim.addColorStop(0.4, "rgba(255, 240, 220, 0.12)");
      rim.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * breath, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Thinking orbital particles
      if (s === "thinking") {
        for (let i = 0; i < 5; i++) {
          const angle = elapsed * 1.4 + (i * Math.PI * 2) / 5;
          const orbitR = baseRadius * 1.25 + Math.sin(elapsed * 2 + i) * 8;
          const px = cx + Math.cos(angle) * orbitR;
          const py = cy + Math.sin(angle) * orbitR;
          const pSize = 2 + Math.sin(elapsed * 3 + i) * 1;
          ctx.beginPath();
          ctx.arc(px, py, pSize, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${palette.h + 10}, 100%, 80%, 0.85)`;
          ctx.shadowBlur = 12;
          ctx.shadowColor = palette.accent;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // Success flash ring
      if (stateRef.current.success > 0) {
        const ringR = baseRadius * (1 + (1 - stateRef.current.success) * 1.4);
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${palette.h}, 100%, 70%, ${stateRef.current.success})`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 20;
        ctx.shadowColor = palette.accent;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const pad = 1.6;
  const canvasVisual = size * pad;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: canvasVisual,
          height: canvasVisual,
          display: "block",
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />
    </div>
  );
}
