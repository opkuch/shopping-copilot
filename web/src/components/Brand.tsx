/** A hang tag with its string: the same object that carries every price in the chat. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M14.5 5.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-.59 1.41l-9.5 9.5a2 2 0 0 1-2.82 0l-8.5-8.5a2 2 0 0 1 0-2.82l9.5-9.5A2 2 0 0 1 14.5 5.5z"
        fill="currentColor"
      />
      <circle cx="21.5" cy="11.5" r="2.25" fill="#fff" />
      <path d="M21.5 11.5C19 7 15 3.5 9.5 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ name }: { name: string }) {
  return (
    <div className="brand">
      <BrandMark />
      <span>{name}</span>
    </div>
  );
}
