import { useEffect, useState } from 'react';

/**
 * True only on a desktop-class device with a fine pointer and no reduced-motion
 * preference. Used to gate the heaviest effects (fluid cursor, 3D ball pit) so
 * phones and accessibility settings don't pay for them.
 */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const big = window.matchMedia('(min-width: 1024px) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setIsDesktop(big.matches && !reduced.matches);
    update();
    big.addEventListener('change', update);
    reduced.addEventListener('change', update);
    return () => {
      big.removeEventListener('change', update);
      reduced.removeEventListener('change', update);
    };
  }, []);

  return isDesktop;
}
