import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Mount-gate for heavy WebGL scenes. Children render only once the wrapper nears
 * the viewport. With `keepMounted={false}` they also UNMOUNT when scrolled away —
 * critical for freeing GL contexts so only the on-screen scene holds one.
 */
export default function InView({
  children,
  rootMargin = '250px',
  className,
  fallback = null,
  keepMounted = true,
}: {
  children: ReactNode;
  rootMargin?: string;
  className?: string;
  fallback?: ReactNode;
  keepMounted?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) {
          setShown(true);
          if (keepMounted) io.disconnect();
        } else if (!keepMounted) {
          setShown(false);
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin, keepMounted]);

  return (
    <div ref={ref} className={className}>
      {shown ? children : fallback}
    </div>
  );
}
