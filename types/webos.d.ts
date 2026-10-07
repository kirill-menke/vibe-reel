/* webOS (LG TV) globals the TV app touches. None of them exist off-TV, so every
 * member is optional and code must feature-test before use. */

interface PalmSystemObject {
  /** Bring the app to the foreground (lifecycle.js; needed with handlesRelaunch). */
  activate?(): void;
  deactivate?(): void;
  launchParams?: string;
  identifier?: string;
  [key: string]: unknown;
}

/** One luna-bus call channel (trailer.js → applicationManager/launch). */
declare class PalmServiceBridge {
  constructor();
  /** Receives the raw JSON reply as a string. */
  onservicecallback: ((msg: string) => void) | null;
  call(uri: string, payload: string): void;
  cancel(): void;
}

interface Window {
  PalmSystem?: PalmSystemObject;
  PalmServiceBridge?: typeof PalmServiceBridge;
}

interface DocumentEventMap {
  webOSRelaunch: CustomEvent<unknown>;
  webOSLaunch: CustomEvent<unknown>;
}
