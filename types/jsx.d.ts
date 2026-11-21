// The one piece of React's JSX contract this project needs.
//
// `@types/react` is not a dependency of PRAHA-STREAM — `react@19` ships plain
// JavaScript — so `JSX.IntrinsicAttributes` does not exist and TypeScript
// rejects `key` on any component that declares its own props. Components
// without explicit props accept `key` because their element type is `any`;
// the ones in `components/liveTv` are typed, so the attribute is declared here
// once rather than threaded through every prop interface.
//
// This is the same shape React's own types publish: a `key` that is not a
// prop, only a reconciliation hint.

declare namespace JSX {
  interface IntrinsicAttributes {
    key?: string | number;
  }
}
