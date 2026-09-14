import { MantineProvider, localStorageColorSchemeManager } from "@mantine/core";
import "@mantine/core/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      defaultColorScheme="auto"
      colorSchemeManager={localStorageColorSchemeManager({
        key: "ido.color-scheme",
      })}
      theme={{
        primaryColor: "gray",
        black: "#292c33",
        fontSizes: {
          xs: "0.8125rem",
          sm: "0.875rem",
          md: "1rem",
          lg: "1.125rem",
          xl: "1.25rem",
        },
        defaultRadius: "md",
        fontFamily: '"Segoe UI", "Noto Sans JP", system-ui, sans-serif',
      }}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
