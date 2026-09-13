import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
if (["/studio", "/stage"].includes(location.pathname)) {
  void import("./Studio").then(({ Studio }) => root.render(<Studio />));
} else {
  void import("./Hud").then(({ Hud }) => root.render(<Hud />));
}
