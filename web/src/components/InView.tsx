import { useEffect, useRef, useState, type ReactNode } from 'react';

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
