"use client";

import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";

/**
 * Base glass card primitive. Renders the design bundle's `.glass.card-enter`
 * surface with the standard label + trailing-meta header. Interactive cards
 * (those with onClick) get hover lift + selected-state shadow.
 */
export function Card({
  children,
  width = 280,
  style,
  className,
  onClick,
  selected = false,
  label,
  trailing,
}: {
  children: ReactNode;
  width?: number | string;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
  label?: ReactNode;
  trailing?: ReactNode;
}) {
  const interactive = !!onClick;
  return (
    <div
      onClick={onClick}
      className={clsx(
        "glass card-enter",
        interactive && "card-interactive",
        selected && "card-selected",
        className
      )}
      style={{
        width,
        padding: 18,
        cursor: interactive ? "pointer" : "default",
        ...style,
      }}
    >
      {(label || trailing) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
            position: "relative",
            zIndex: 1,
          }}
        >
          {label ? (
            <div
              className="font-mono no-select"
              style={{
                fontSize: 10,
                letterSpacing: "0.14em",
                color: "var(--fg-mute)",
              }}
            >
              {label}
            </div>
          ) : (
            <span />
          )}
          {trailing}
        </div>
      )}
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  );
}
