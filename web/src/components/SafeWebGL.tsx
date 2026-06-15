import { Component, Fragment, type ReactNode } from 'react';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/**
 * Error boundary for WebGL effects. If a canvas fails to get a GL context the
 * throw is caught here and a static fallback is shown — it never takes down the
 * rest of the page.
 *
 * Context exhaustion is usually TRANSIENT, not fatal: a neighbouring scene is
 * still mid-unmount, or React StrictMode double-invoked the effect in dev, so
 * the browser briefly runs out of GL context slots. Rather than give up for
 * good, we remount the subtree a few times with backoff — the `key` bump forces
 * a fresh mount (new effect → new WebGLRenderer) once a slot frees up. After
 * MAX_RETRIES we settle on the fallback (genuinely blocklisted GPU / headless).
 */
export default class SafeWebGL extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) console.warn('[SafeWebGL] effect failed:', error);
    if (this.state.attempt >= MAX_RETRIES) return;
    // Back off a little more on each attempt to give the GPU process time to
    // reclaim the freed contexts before we ask for a new one.
    const delay = RETRY_BASE_MS * (this.state.attempt + 1);
    this.timer = setTimeout(() => {
      this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
    }, delay);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    // Fragment key bump = full remount of the scene on each retry; no DOM
    // wrapper, so absolute/fixed canvas layout is untouched.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
