declare global {
  interface Window {
    idoDesktop?: { pickDirectory(): Promise<string | undefined> };
  }
}
export const desktopBridge = () => window.idoDesktop;
