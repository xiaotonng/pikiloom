import { Component, type ReactNode } from 'react';

/**
 * Error boundary for WebGL effects. If a canvas fails to get a GL context (too
 * many live contexts, blocklisted GPU, headless env, …) the throw is caught here
 * and a static fallback is shown — it never takes down the rest of the page.
 */
export default class SafeWebGL extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) console.warn('[SafeWebGL] effect disabled:', error);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
