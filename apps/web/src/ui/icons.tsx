/**
 * The icon set: 16px, 1.5px strokes on a 16-unit grid, drawn for SCOPE. Icons inherit
 * currentColor and are decorative (aria-hidden) unless given a label.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number; label?: string };

function Icon({ size = 16, label, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The SCOPE mark: a reticle — the instrument you look through to see what happened. */
export const Reticle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5" />
    <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
export const Cross = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);
export const Alert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5l6 10.5H2L8 2.5z" />
    <path d="M8 7v2.5" />
    <circle cx="8" cy="11.25" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);
export const Bolt = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.75V8.5" />
    <circle cx="8" cy="11" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);
export const Skip = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" strokeDasharray="2.2 2.2" />
  </Icon>
);
export const Dot = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
  </Icon>
);
export const ChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3.5L5.5 8 10 12.5" />
  </Icon>
);
export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Icon>
);
export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 6L8 10.5 12.5 6" />
  </Icon>
);
export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Icon>
);
export const ArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
);
export const ArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Icon>
);
export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </Icon>
);
export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5V3a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h.5" />
  </Icon>
);
export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </Icon>
);
export const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />
  </Icon>
);
export const Monitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="8" rx="1.5" />
    <path d="M6 14h4M8 11v3" />
  </Icon>
);
export const Wrap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h9a2 2 0 010 4H9M2.5 12h3.5M10.5 10.5L9 12l1.5 1.5" />
  </Icon>
);
export const Expand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" />
  </Icon>
);
export const Close = Cross;
export const Menu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);

// Navigation glyphs
export const IconOverview = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 13.5h11" />
    <path d="M4 11V8M7 11V4.5M10 11V6.5M13 11V9" />
  </Icon>
);
export const IconRuns = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 3.5l8 4.5-8 4.5v-9z" />
  </Icon>
);
export const IconTraces = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3.5h7M4.5 6.5h8M6.5 9.5h4M4.5 12.5h6" />
  </Icon>
);
export const IconEvaluations = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M5 8.25l2 2 4-4.5" />
  </Icon>
);
export const IconWorkflows = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="4.5" height="3.5" rx="1" />
    <rect x="9.5" y="10" width="4.5" height="3.5" rx="1" />
    <path d="M4.25 6v2.75a1.5 1.5 0 001.5 1.5h3.75" />
  </Icon>
);
export const IconModels = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <path d="M6.5 1.5V4M9.5 1.5V4M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Icon>
);
export const IconCompare = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 2.5v11M11 2.5v11M2.5 5.5L5 3l2.5 2.5M8.5 10.5L11 13l2.5-2.5" />
  </Icon>
);
