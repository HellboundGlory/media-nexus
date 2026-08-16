// SPDX-License-Identifier: MIT
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, useAppStore } from "./store/useAppStore";
// Self-hosted display face — latin subset, weights 500 & 700 (no external CDN; LAN-only app).
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-700.css";
import "./index.css";

applyTheme(useAppStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
