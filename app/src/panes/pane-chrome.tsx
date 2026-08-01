/**
 * Pane chrome per docs/DESIGN.md: a control row (status + elapsed left, Remove/Pause
 * right) and an OUTPUT row of toggle chips with a dim hint in parentheses.
 *
 * Closes items 1 and 4 of the 2026-07-31 design-review fix-list.
 */

import type { ReactNode } from "react";

export interface OutputChoice {
  id: string;
  label: string;
}

export function PaneControls({
  status,
  elapsedMs,
  paused,
  onPause,
  onRemove,
  extra,
}: {
  status: string;
  elapsedMs: number;
  paused: boolean;
  onPause: () => void;
  onRemove?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="pane-controls">
      <span className={paused ? "paused" : "running"}>{paused ? "Paused" : status}</span>
      <span className="ms">{elapsedMs.toFixed(1)} ms</span>
      {extra}
      <span className="spacer" />
      {onRemove && (
        <button className="pane-btn" onClick={onRemove}>
          Remove
        </button>
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
