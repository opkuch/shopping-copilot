import { useState } from "react";

// Inline, so a failed image costs no second request and works under the CSP.
function Placeholder() {
  return (
    <svg className="product-image-placeholder" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect x="8" y="10" width="32" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="20" r="3" fill="currentColor" />
      <path d="M10 34l10-10 7 7 5-5 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** A fixed 1:1 box, so cards do not jump while images load or when one fails. */
export function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="product-image">
      {failed ? (
        <Placeholder />
      ) : (
        <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      )}
    </div>
  );
}
