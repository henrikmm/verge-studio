/**
 * Pane chrome per docs/DESIGN.md: a control row (status + elapsed left, Focus/Hide/Pause
 * right) and an OUTPUT row of toggle chips with a dim hint in parentheses.
 *
 * Focus and Hide are deliberately different verbs — see `lib/dock-store.ts`. Focus is the
 * cheap one (nothing unmounts) and is offered first; Hide destroys the pane and is offered
 * second, because a hidden Viewport 3D pays to rebuild its point cloud when it returns.
 */

import type { ReactNode } from "react";
import { hidePane, toggleFocus, useDock } from "../lib/dock-store";

export interface OutputChoice {
  id: string;
  label: string;
}

export function PaneControls({
  status,
  elapsedMs,
  paused,
  onPause,
  paneId,
  extra,
}: {
  status: string;
  elapsedMs: number;
  paused: boolean;
  onPause: () => void;
  /** Dock panel id; omit for a pane that is not dockable. */
  paneId?: string;
  extra?: ReactNode;
}) {
  const dock = useDock();
  const focused = paneId !== undefined && dock.focusedId === paneId;

  return (
    <div className="pane-controls">
      <span className={paused ? "paused" : "running"}>{paused ? "Paused" : status}</span>
      <span className="ms">{elapsedMs.toFixed(1)} ms</span>
      {extra}
      <span className="spacer" />
      {paneId !== undefined && (
        <>
          <button
            className={`pane-btn${focused ? " on" : ""}`}
            title={
              focused
                ? "Restore the other panes (Esc)"
                : "Fill the window with this pane. The others keep their state and come straight back."
            }
            onClick={() => toggleFocus(paneId)}
          >
            {focused ? "Restore" : "Focus"}
          </button>
          <button
            className="pane-btn"
            title="Hide this pane; the rest take its space. Reopen it from the view bar."
            onClick={() => hidePane(paneId)}
          >
            Hide
          </button>
        </>
      )}
      <button className="pane-btn" onClick={onPause}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

export function OutputRow({
  choices,
  active,
  onSelect,
  hint,
}: {
  choices: OutputChoice[];
  active: string;
  onSelect: (id: string) => void;
  hint: string;
}) {
  return (
    <div className="output-row">
      <span className="output-label">OUTPUT</span>
      {choices.map((choice) => (
        <button
          key={choice.id}
          className={`chip-toggle${choice.id === active ? " on" : ""}`}
          onClick={() => onSelect(choice.id)}
        >
          {choice.label}
        </button>
      ))}
      <span className="output-hint">({hint})</span>
    </div>
  );
}
