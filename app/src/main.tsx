import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "./theme.css";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
