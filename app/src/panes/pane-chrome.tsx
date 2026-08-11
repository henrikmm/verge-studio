/**
 * Pane chrome per docs/DESIGN.md: a control row (status + elapsed left, Focus/Hide/Pause
 * right) and an OUTPUT row of toggle chips with a dim hint in parentheses.
 *
 * Focus and Hide are deliberately different verbs — see `lib/dock-store.ts`. Focus is the
 * cheap one (nothing unmounts) and is offered first; Hide destroys the pane and is offered
 * second, because a hidden Viewport 3D pays to rebuild its point cloud when it returns.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { hidePane, toggleFocus, useDock, useSashDragging } from "../lib/dock-store";

/**
 * How much of the window this pane is taking — shown only while a sash is being dragged.
 *
 * The layout is meant to be 40/40/20 and Dockview persists whatever you drag it to, so without
 * this there is no way to tell what the split actually is short of measuring it in a console.
 *
 * It is not permanent, though. The question it answers — "what did I just do to the layout?" — is
 * only asked while the answer is changing, and four more figures sitting in the status rows
 * forever would compete with the readouts the panes exist for. So all three appear together the
 * moment a sash is grabbed, and go away about a second after it is released. That tail is
 * deliberate: the number you landed on is the interesting one, and it would otherwise vanish at
 * the instant it became readable.
 *
 * It measures its own `.pane` ancestor against the Dockview root rather than `window.innerWidth`,
 * because the dock is not the whole window — the status bar has 25 px of it — and a height share
 * computed against the window would never reach 100%.
 *
 * The second figure only appears when the pane is not full height. In the default arrangement all
 * three columns are, so a lone `40%` is the honest reading; open the Graph below and the panes
 * above it start reporting `40 × 62%`.
 */
export function PaneShare() {
  const ref = useRef<HTMLSpanElement>(null);
  const dragging = useSashDragging();
  const [share, setShare] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    // Nothing observed while nothing is being dragged: no listener, no measurement, no cost.
    if (!dragging) return;
    const pane = ref.current?.closest(".pane") as HTMLElement | null;
    const dock = document.querySelector(".dv-dockview") as HTMLElement | null;
    if (!pane || !dock) return;

    const measure = () => {
      const p = pane.getBoundingClientRect();
      const d = dock.getBoundingClientRect();
      if (d.width === 0 || d.height === 0) return;
      setShare({ w: (p.width / d.width) * 100, h: (p.height / d.height) * 100 });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, [dragging]);

  const visible = dragging && share !== null;
  const text =
    share === null
      ? ""
      : share.h > 95
        ? `${share.w.toFixed(0)}%`
        : `${share.w.toFixed(0)} × ${share.h.toFixed(0)}%`;

  /**
   * Always rendered, `hidden` when idle, rather than returning null.
   *
   * The effect above finds its pane with `ref.current.closest(".pane")`, so the span has to be in
   * the document before the first measurement. Returning null while idle meant the ref was still
   * empty on the render that turned dragging on, the effect bailed out, and the figure never
   * appeared at all. `hidden` keeps it out of the layout and out of the accessibility tree while
   * leaving it findable.
   */
  return (
    <span ref={ref} className="pane-share" hidden={!visible}>
      {text}
    </span>
  );
}

export interface OutputChoice {
  id: string;
  label: string;
  /** Hover text. A mode that changes what the whole pane means needs saying what it means. */
  title?: string;
}

export interface LayerChoice {
  id: string;
  label: string;
  /** Hover text. Layers draw evidence, and evidence needs saying what it means. */
  title?: string;
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
      <PaneShare />
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

/**
 * Independent on/off chips, as opposed to `OutputRow`'s one-of-N.
 *
 * A separate component rather than a mode on OutputRow because the two answer different
 * questions: OUTPUT is "which view of the wire am I looking at", LAYERS is "what else is drawn
 * on top of it". Collapsing them would make an overlay mutually exclusive with the thing it
 * overlays.
 *
 * Shares `.output-row`'s styling. It used to add a `layer-row` class whose only job was to turn
 * wrapping back on; since 2026-08-08 every control row wraps, so the class styled nothing and
 * went with the prop that used it.
 */
export function LayerRow({
  choices,
  active,
  onToggle,
  hint,
}: {
  choices: LayerChoice[];
  active: ReadonlySet<string>;
  onToggle: (id: string) => void;
  hint?: string;
}) {
  return (
    <div className="output-row">
      <span className="output-label">LAYERS</span>
      {choices.map((choice) => (
        <button
          key={choice.id}
          className={`chip-toggle${active.has(choice.id) ? " on" : ""}`}
          // The chips are toggles, not navigation: without this a screen reader reads an "on"
          // chip and an "off" chip identically, since the state is carried by styling alone.
          aria-pressed={active.has(choice.id)}
          title={choice.title}
          onClick={() => onToggle(choice.id)}
        >
          {choice.label}
        </button>
      ))}
      {hint !== undefined && <span className="output-hint">({hint})</span>}
    </div>
  );
}

/**
 * One-of-N chips under a label.
 *
 * `label` exists so a pane can carry a SECOND such row without a second component: Viewport 3D
 * asks both "which view of the wire" (OUTPUT) and "where am I standing" (VIEW), and those are
 * different questions in the sense LayerRow's note describes.
 *
 * There was also a `wrap` prop, removed on 2026-08-08. Wrapping is now what every control row
 * does, so opting in was a way to forget — and the two rows that lost controls at 180 px were
 * exactly the ones that had not opted in.
 */
export function OutputRow({
  choices,
  active,
  onSelect,
  hint,
  label = "OUTPUT",
  extra,
}: {
  choices: OutputChoice[];
  active: string;
  onSelect: (id: string) => void;
  hint?: string;
  label?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="output-row">
      <span className="output-label">{label}</span>
      {choices.map((choice) => (
        <button
          key={choice.id}
          className={`chip-toggle${choice.id === active ? " on" : ""}`}
          aria-pressed={choice.id === active}
          title={choice.title}
          onClick={() => onSelect(choice.id)}
        >
          {choice.label}
        </button>
      ))}
      {extra}
      {hint !== undefined && <span className="output-hint">({hint})</span>}
    </div>
  );
}
