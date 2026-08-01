import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "./theme.css";
import { App } from "./app";
import { installDevHandle } from "./lib/dev-handle";

// Dev-only: exposes window.__verge so the browser-pane feedback loop can drive the
// graph without a human at the mouse. No-ops in a production build.
installDevHandle();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
