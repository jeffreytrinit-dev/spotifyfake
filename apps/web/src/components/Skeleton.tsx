export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`tp-skeleton rounded-lg ${className}`} />;
}
