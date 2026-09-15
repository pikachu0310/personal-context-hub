declare global {
  interface Window {
    idoDesktop?: {
      pickDirectory(): Promise<string | undefined>;
      checkUpdate?(): Promise<{
        current: string;
        latest?: string;
        status: string;
      }>;
      openReleases?(): Promise<void>;
    };
  }
}
export const desktopBridge = () => window.idoDesktop;
