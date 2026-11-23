import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort crash screen.
 *
 * Without one, a render-time throw anywhere in the tree unmounts the whole app
 * and leaves a blank white page — on Android that looks like the app failed to
 * launch, with no way to tell what happened and no way back. This keeps the
 * failure inside the React root: the user gets a readable message, a reload, and
 * (in a release build) nothing else.
 *
 * It deliberately does not catch errors thrown in event handlers or async code;
 * React does not route those here. Those are handled where they happen.
 */
class ErrorBoundaryImpl extends React.Component<Props, State> {
  // `react` ships no type definitions here, so the base class has no `props`
  // field to inherit. Declaring it keeps `this.props` and `this.state` typed.
  declare props: Props;

  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Console is the only sink available in the shipped app. Keeping the
    // component stack is what makes a user-reported crash diagnosable from a
    // logcat capture.
    console.error('PRAHA crashed while rendering:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          padding: '24px',
          textAlign: 'center',
          background: '#0d1117',
          color: '#c9d1d9',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '18px', color: '#f0f6fc' }}>Something went wrong</h1>
        <p style={{ margin: 0, fontSize: '13.5px', maxWidth: '44ch', color: '#8b949e' }}>
          PRAHA hit an unexpected error while drawing this screen. Reloading usually clears it.
        </p>
        {/* The message helps a bug report and is not sensitive: it is a render
            error from our own code, not user data. */}
        <code style={{ fontSize: '12px', color: '#f87171', wordBreak: 'break-word', maxWidth: '60ch' }}>
          {error.message || String(error)}
        </code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: '4px',
            padding: '10px 22px',
            borderRadius: '10px',
            border: 'none',
            background: '#ef4444',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

export default ErrorBoundaryImpl;

/**
 * JSX needs a component type whose props are declared. Without `@types/react`
 * the `React.Component` base is untyped, so `IntrinsicAttributes` is the only
 * thing the checker sees; widening the export to a plain function component type
 * keeps `<ErrorBoundary>…</ErrorBoundary>` type-safe at the call site.
 */
export const ErrorBoundary = ErrorBoundaryImpl as unknown as (
  props: Props
) => React.ReactNode;
