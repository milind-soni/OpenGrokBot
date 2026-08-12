// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    ogb?: {
      /** Renderer platform hints (darwin | win32 | linux | browser). */
      platform?: string;
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
      /** {mic, screen} TCC status: granted|denied|not-determined|unknown */
      permStatus(): Promise<{ mic: string; screen: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Registers a screen-capture attempt (adds the app to the TCC pane). */
      permRequestScreen(): Promise<string>;
    };
  }
}
