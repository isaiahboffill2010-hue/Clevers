"use client";

import { useState } from "react";

export function InputFixture() {
  const [status, setStatus] = useState("idle");
  const [keys, setKeys] = useState("");
  return (
    <main
      style={{ fontFamily: "sans-serif", padding: 24 }}
      onKeyDown={(event) => setKeys(`down:${event.key}:${event.shiftKey}:${event.ctrlKey}`)}
      onKeyUp={(event) => setKeys(`up:${event.key}:${event.shiftKey}:${event.ctrlKey}`)}
    >
      <h1>Phase 5 Input Fixture</h1>
      <p id="status">{status}</p>
      <p id="keys">{keys}</p>
      <button
        id="click-target"
        type="button"
        style={{ width: 180, height: 60 }}
        onClick={(event) =>
          setStatus(`click:${Math.round(event.clientX)},${Math.round(event.clientY)}`)
        }
        onDoubleClick={() => setStatus("double-click")}
        onContextMenu={(event) => {
          event.preventDefault();
          setStatus("context-menu");
        }}
      >
        Click target
      </button>
      <div style={{ marginTop: 20 }}>
        <label htmlFor="text-input">Text input</label>
        <input id="text-input" style={{ display: "block", width: 300, height: 36 }} />
      </div>
      <textarea
        id="textarea"
        aria-label="Textarea"
        style={{ width: 300, height: 80, marginTop: 12 }}
      />
      <div
        id="editable"
        contentEditable
        suppressContentEditableWarning
        style={{ border: "1px solid", minHeight: 40, width: 300, marginTop: 12 }}
      >
        editable
      </div>
      <div
        id="scroller"
        style={{ width: 320, height: 120, overflow: "auto", border: "1px solid", marginTop: 16 }}
      >
        <div style={{ height: 600, paddingTop: 500 }}>nested scroll bottom</div>
      </div>
      <div
        id="drag-target"
        style={{ width: 100, height: 60, background: "royalblue", marginTop: 16 }}
        onPointerDown={() => setStatus("drag-start")}
        onPointerMove={(event) => event.buttons && setStatus("dragging")}
        onPointerUp={() => setStatus("drag-end")}
      >
        Drag me
      </div>
    </main>
  );
}
