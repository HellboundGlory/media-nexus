// SPDX-License-Identifier: MIT
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, useAppStore } from "./store/useAppStore";
import "./index.css";

applyTheme(useAppStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
