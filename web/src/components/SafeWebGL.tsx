import { Component, Fragment, type ReactNode } from 'react';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

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
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
