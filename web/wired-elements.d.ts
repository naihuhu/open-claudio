// JSX typings for the wired-elements custom elements used in the light "sketch" theme.
// React 19 exposes the JSX namespace from the "react" module (jsx: react-jsx), so we augment it there.
import type * as React from 'react';

type WiredAttrs<T = {}> = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> &
  T & { class?: string };

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'wired-button': WiredAttrs<{ elevation?: number; disabled?: boolean }>;
      'wired-icon-button': WiredAttrs<{ disabled?: boolean }>;
      'wired-input': WiredAttrs<{ placeholder?: string; disabled?: boolean; type?: string }>;
      'wired-textarea': WiredAttrs<{ placeholder?: string; rows?: number; disabled?: boolean }>;
      'wired-slider': WiredAttrs<{ min?: number; max?: number; step?: number; disabled?: boolean }>;
      'wired-divider': WiredAttrs;
      'wired-card': WiredAttrs<{ elevation?: number }>;
    }
  }
}
