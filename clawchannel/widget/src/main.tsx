import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat";

const container = document.getElementById("root");
if (!container) throw new Error("clawchannel widget: #root not found");

createRoot(container).render(
  <React.StrictMode>
    <Chat />
  </React.StrictMode>,
);
