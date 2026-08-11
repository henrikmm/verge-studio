/**
 * The `?`, and the one way this app explains itself.
 *
 * Every pane used to explain its features in place, permanently: paragraphs under the readings in
 * Objects, a closing note in Runs, four blocks of billing prose in the Inspector. Each was correct
 * and each was read once. Their combined cost was paid on every glance, and it pushed the numbers
 * — the thing the panes exist to show — below the fold.
 *
 * So an explanation now costs one glyph. The rule, written into DESIGN.md so it survives the next
 * feature: **text that explains what a control or a reading IS goes behind a `?`. Text describing
 * the state the app is in RIGHT NOW stays on the page.** A capped frame plan, an extrapolated VRAM
 * figure, a mock-backed readout, an instance that is still billing — those are warnings, not
 * explanations, and hiding one behind a hover would be a lie of omission.
 *
 * ## Two handles, and how to choose
 *
 * `HelpDot` is the `?`. It belongs to a **section** — the thing with no label of its own to hang
 * an explanation on. **At most one or two per section**, because a dot per row is the clutter the
 * dot was introduced to remove.
 *
 * `HelpTerm` wraps a **control's own label**, so hovering the name explains the control. Same
 * panel, no extra glyph, just a dotted underline. This is the default for a parameter row; reach
 * for a `?` only when there is nothing to underline.
 *
 * ## Why not `title`
 *
 * The native tooltip is used all over this app for short chip labels and it stays there. It is the
 * wrong tool for a paragraph: about a second of delay, an OS-styled light box that fights a dark
 * interface, no control over wrapping width, and — the one that matters — it never appears for a
 * keyboard user. Both handles above open instantly, on hover *and* on focus, in the app's palette.
 *
 * ## Why a portal
 *
 * Pane bodies are `overflow: hidden`, which is what makes a narrow pane clip its own controls
 * (DESIGN.md's ⚠️). A popover inside that box would be clipped by it. Rendering into `document.body`
 * at fixed coordinates takes it out of every ancestor's overflow, and the flip below keeps it
 * inside the window instead — measured against the viewport, not guessed from the side it is on.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

/** Gap between the trigger and its panel, and the margin it keeps from the window edge. */
const OFFSET_PX = 6;
const MARGIN_PX = 8;
/** Grace period so the pointer can travel from the trigger to the panel without it closing. */
const CLOSE_DELAY_MS = 120;

interface Placement {
  left: number;
  top: number;
}

/**
 * The popover itself, without opinions about what opens it.
 *
 * Two things open one: a `?` for a whole section, and a control's own label for that control. The
 * placement, the flip, the portal, the Escape handling and the travel grace period are identical
 * either way, so they live here once and the two triggers below are thin.
 */
function useHelpPopover(): {
  open: boolean;
  id: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  show: () => void;
  hide: () => void;
  toggle: () => void;
  panel: (children: ReactNode) => ReactElement | null;
} {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const toggle = () => {
    window.clearTimeout(closeTimer.current);
    setOpen((value) => !value);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;

    let left = anchor.left;
    if (left + panel.width > window.innerWidth - MARGIN_PX) left = anchor.right - panel.width;
    left = Math.max(MARGIN_PX, Math.min(left, window.innerWidth - panel.width - MARGIN_PX));

    let top = anchor.bottom + OFFSET_PX;
    if (top + panel.height > window.innerHeight - MARGIN_PX) {
      top = anchor.top - panel.height - OFFSET_PX;
    }
    top = Math.max(MARGIN_PX, Math.min(top, window.innerHeight - panel.height - MARGIN_PX));

    setPlacement({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      window.clearTimeout(closeTimer.current);
      setOpen(false);
      anchorRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const panel = (children: ReactNode) =>
    open
      ? createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            className="help-panel"
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? "visible" : "hidden",
            }}
            onPointerEnter={show}
            onPointerLeave={hide}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return { open, id, anchorRef, show, hide, toggle, panel };
}

/**
 * A control's own label, explaining itself on hover.
 *
 * The `?` was applied to every row and the result was a column of them — one per parameter, plus
 * one per section, which is the visual noise the dot was introduced to remove. So a control's
 * explanation now hangs off the thing it explains: hover or focus the label and the same panel
 * opens. A dotted underline is the only mark it leaves, which is enough to say "there is more
 * here" without competing with the value beside it.
 *
 * Deliberately NOT a native `title`. That would be about a second of delay, an OS-styled light box
 * against a dark interface, and nothing at all for a keyboard — the reasons DESIGN.md gives for
 * banning `title` on a paragraph. This is the same popover the `?` opens, with a different handle.
 */
export function HelpTerm({ children, help }: { children: ReactNode; help: ReactNode }) {
  const pop = useHelpPopover();
  return (
    <>
      <span
        ref={pop.anchorRef as React.RefObject<HTMLSpanElement>}
        className="help-term nodrag"
        // Focusable so the explanation is reachable without a pointer. `role="button"` because it
        // does something on activation rather than merely describing the row.
        tabIndex={0}
        role="button"
        aria-expanded={pop.open}
        aria-describedby={pop.open ? pop.id : undefined}
        onPointerEnter={pop.show}
        onPointerLeave={pop.hide}
        onFocus={pop.show}
        onBlur={pop.hide}
        onClick={(event) => {
          event.stopPropagation();
          pop.toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          pop.toggle();
        }}
      >
        {children}
      </span>
      {pop.panel(help)}
    </>
  );
}

export function HelpDot({
  children,
  label = "What is this?",
}: {
  children: ReactNode;
  /** Accessible name. Worth setting when several sit in one row, so a screen reader can tell
   *  them apart — "What is this?" six times over is not a description of anything. */
  label?: string;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /**
   * Place it after it has a size, never before.
   *
   * Layout effect rather than effect: the panel is rendered at its natural position for one
   * frame while we measure it, and a paint in between would show it jumping. It starts hidden
   * (`placement === null` renders it with `visibility: hidden`) so that frame is invisible.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const anchor = buttonRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;

    // Prefer below-right of the dot, then flip on whichever axis has run out of room. Clamping
    // afterwards catches the case where neither side fits — a panel jammed against the edge is
    // readable, a panel half outside the window is not.
    let left = anchor.left;
    if (left + panel.width > window.innerWidth - MARGIN_PX) {
      left = anchor.right - panel.width;
    }
    left = Math.max(MARGIN_PX, Math.min(left, window.innerWidth - panel.width - MARGIN_PX));

    let top = anchor.bottom + OFFSET_PX;
    if (top + panel.height > window.innerHeight - MARGIN_PX) {
      top = anchor.top - panel.height - OFFSET_PX;
    }
    top = Math.max(MARGIN_PX, Math.min(top, window.innerHeight - panel.height - MARGIN_PX));

    setPlacement({ left, top });
  }, [open]);

  // Escape closes it, matching every other transient surface in the app (Focus, the key help).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped here so Escape on an open popover does not also exit a focused pane — one key,
      // one effect, innermost thing first.
      event.stopPropagation();
      window.clearTimeout(closeTimer.current);
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // `nodrag` so a `?` sitting inside a node card cannot start a React Flow node drag.
        className="help-dot nodrag"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        // Click toggles, for touch and for anyone who wants it to stay put while they read.
        onClick={(event) => {
          event.stopPropagation();
          window.clearTimeout(closeTimer.current);
          setOpen((value) => !value);
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            className="help-panel"
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? "visible" : "hidden",
            }}
            onPointerEnter={show}
            onPointerLeave={hide}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
