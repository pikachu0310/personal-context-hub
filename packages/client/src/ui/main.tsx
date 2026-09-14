import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      forceColorScheme="dark"
      theme={{
        primaryColor: "gray",
        defaultRadius: "md",
        fontFamily: '"Segoe UI", "Noto Sans JP", system-ui, sans-serif',
      }}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
