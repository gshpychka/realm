// First, so the feature sheets that components import can build on its rules.
import "./common/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root mount point in index.html");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
