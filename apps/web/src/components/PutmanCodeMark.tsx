import type { SVGProps } from "react";

export function PutmanCodeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect width="24" height="24" rx="6" fill="var(--primary)" />
      <path
        d="m5.5 7.5 5 4.5-5 4.5M13 16.5h5.5"
        stroke="var(--primary-foreground)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
