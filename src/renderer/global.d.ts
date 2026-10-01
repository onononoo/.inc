import type { IncBridge } from '@shared/bridge';

declare global {
  interface Window {
    /** Injected by the preload script. */
    readonly inc: IncBridge;
  }
}

declare module '*.css';
declare module '*.ttf' {
  const url: string;
  export default url;
}

export {};
