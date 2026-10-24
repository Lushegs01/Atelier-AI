import Link from "next/link";
export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link className="logo" href={href} aria-label="Atelier AI home">
      <svg className="logo-mark" viewBox="0 0 32 36" fill="none" aria-hidden="true">
        <path
          d="M3 30L15.8 4L29 30M8 22H24M10.5 30L17 16L23.5 30"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span>atelier</span>
      <span className="logo-ai">AI</span>
    </Link>
  );
}
