import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root mount point in index.html");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
