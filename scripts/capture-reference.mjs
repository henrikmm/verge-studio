#!/usr/bin/env node
/**
 * Redraw the reference captures in docs/reference/.
 *
 * These images are the baseline the design review grades against (DESIGN.md item 10a), so how
 * they were made matters as much as what is in them. A baseline assembled by hand drifts: each
 * pass approves a screenshot slightly unlike the last, nobody can tell which differences were
 * chosen, and after a few rounds the standard is whatever the most recent session happened to
 * capture. A script fixes the states by name, so a re-capture changes the pixels and nothing
 * else, and a diff is a diff of the app rather than of the photographer.
 *
 * Drives headless Chrome over the DevTools protocol with no dependencies — Node 22 has both
 * `fetch` and `WebSocket` built in, and this is the only place in the repository that needs a
 * browser outside an agent's own tooling.
 *
 * Requires the dev server already running on 5173 and the door fixture present on disk. It
 * starts neither: a capture script that silently launches a build would let a stale bundle
 * become the baseline, and the fixture payloads are local-only (see .gitignore).
 *
 *   node scripts/capture-reference.mjs            # all five states
 *   node scripts/capture-reference.mjs graph      # one of them
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "docs", "reference");
const APP = "http://127.0.0.1:5173";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

/** Every measurement in the acceptance checklist assumes this window. */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * The fixture with a tape truth behind it, so the readings on screen are gradeable rather than
 * merely present. Matched as a substring of the run row — see `click`.
 */
const FIXTURE = "Door · 504 px · 112f";

// --------------------------------------------------------------- CDP plumbing

let nextId = 1;
const pending = new Map();

function send(socket, method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, no) => {
    pending.set(id, { ok, no });
    setTimeout(() => pending.has(id) && (pending.delete(id), no(new Error(`${method} timed out`))), 30_000);
  });
}

function attach(socket) {
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.no(new Error(`${message.error.message}`));
    else waiter.ok(message.result);
  });
}

/**
 * Run an expression in the page and return its value.
 *
 * Errors are re-thrown on this side rather than resolving to `undefined`, because a selector
 * that stopped matching is exactly the failure this script exists to catch: it would otherwise
 * capture the previous state twice and call the set complete.
 */
async function evaluate(socket, expression) {
  const result = await send(socket, "Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return result.result.value;
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Retry an action that can legitimately be early, and re-throw its own error if it never works. */
async function until(action, attempts = 24, gap = 400) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      last = error;
      await wait(gap);
    }
  }
  throw last;
}

// ------------------------------------------------------------ page vocabulary

/**
 * Click the visible element whose text matches, by dispatching real mouse events at its centre.
 *
 * Two decisions worth stating. Text and a scoping selector rather than coordinates, because the
 * pane layout is the thing under test and a capture that silently clicked 40 px of empty canvas
 * after a row moved is worse than one that fails. And real mouse events rather than `.click()`,
 * because the first attempt at this script matched a label span inside a button, called
 * `.click()` on the span, and captured five images of an app that had never loaded the fixture —
 * with no error anywhere. A dispatched click lands on whatever is actually on top, which is what
 * a person's click does.
 */
async function click(socket, text, within = "body") {
  // Poll rather than assume: the runs list, the graph canvas and the layer row all arrive after
  // their pane does, and a click fired at the gap between the two hits nothing and says nothing.
  const box = await until(() =>
    evaluate(
      socket,
    // Every matching container, not the first: the pane tab strips all share a class, and
     // scoping to `querySelector` alone searched Depth 2D's strip for the Runs tab.
     `const scopes = [...document.querySelectorAll(${JSON.stringify(within)})];
     if (scopes.length === 0) throw new Error("no container matching ${within}");
     const visible = scopes.flatMap((scope) => [...scope.querySelectorAll("*")])
       .filter((el) => el.getClientRects().length > 0);
     const smallest = (list) => list.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
     // Exact match first. Falling back to a substring lets a run row be found by its stem
     // ("Door") without this script owning the exact separators a regenerated fixture writes.
     const hit = smallest(visible.filter((el) => el.textContent.trim() === ${JSON.stringify(text)}))
       ?? smallest(visible.filter((el) => el.textContent.includes(${JSON.stringify(text)})));
     if (!hit) throw new Error("nothing reading " + ${JSON.stringify(text)} + " inside ${within}");
     const r = hit.getBoundingClientRect();
     return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`,
    ),
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(socket, "Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  await wait(150);
}

/** Drag a Dockview sash. Real mouse events — the splitter does not respond to anything else. */
async function dragSash(socket, index, toX) {
  const sash = await evaluate(
    socket,
    `const s = [...document.querySelectorAll(".dv-sash.dv-enabled")]
       .filter((e) => e.getBoundingClientRect().width < 20)[${index}];
     if (!s) throw new Error("no vertical sash at index ${index}");
     const r = s.getBoundingClientRect();
     return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`,
  );
  const move = (type, x, buttons) =>
    send(socket, "Input.dispatchMouseEvent", { type, x, y: sash.y, button: "left", buttons, clickCount: 1 });
  await move("mousePressed", sash.x, 1);
  // Two intermediate moves: Dockview begins its drag on the first move after the press, and a
  // single jump to the target was landing before the handler was listening.
  await move("mouseMoved", Math.round((sash.x + toX) / 2), 1);
  await move("mouseMoved", toX, 1);
  await move("mouseReleased", toX, 0);
  await wait(300);
}

// -------------------------------------------------------------------- the set

/**
 * Each state names what it pins. Order matters: they build on one another so the whole set
 * costs one page load of the fixture rather than five.
 */
const STATES = [
  {
    name: "empty-state",
    what: "first run — five panes, nothing loaded, no work started",
    async setup(socket) {
      await evaluate(socket, "localStorage.clear(); return true;");
      await reload(socket);
    },
  },
  {
    name: "default-standard",
    what: "the app doing its job — recorded run, depth map, point cloud, Setup",
    async setup(socket) {
      await click(socket, "Runs", ".dv-tabs-container");
      await click(socket, FIXTURE, ".runs-pane");
      // The fixture is a real reconstruction: a million points have to be read off disk and
      // uploaded to the GPU before anything is on screen.
      await settled(socket, ".viewport-3d canvas, canvas");
      await click(socket, "Depth", ".output-row");
      await click(socket, "Setup", ".dv-tabs-container");
      await wait(600);
    },
  },
  {
    name: "advanced-measured",
    what: "Advanced — Objects with graded targets, floor layers on, the result strip populated",
    async setup(socket) {
      await click(socket, "Advanced", ".mode-switch");
      await click(socket, "Objects", ".dv-tabs-container");
      for (const layer of ["Floor grid", "Floor points", "Up axes"]) {
        await click(socket, layer, ".layer-row").catch(() => {});
      }
      // Selecting a target is what fills Viewport 3D's result strip. Without it the strip reads
      // "free measurement" and this capture pins the chrome but not the headline in it, which is
      // the one thing checklist item 22 is about.
      await click(socket, "Door leaf", ".objects-pane, .pane-body");
      await wait(1500);
    },
  },
  {
    name: "graph",
    what: "the pipeline — node cards, type-coloured ports and wires, the banner",
    async setup(socket) {
      await click(socket, "Graph", ".view-bar");
      await wait(700);
      await click(socket, "Focus", ".graph-actions");
      await wait(1200);
    },
  },
  {
    name: "narrow-pane",
    what: "a pane at 180 px — what checklist item 19 grades, invisible at 1280 px",
    async setup(socket) {
      await send(socket, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send(socket, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await wait(700);
      await dragSash(socket, 0, 180);
    },
  },
];

/**
 * Wait until the app has drawn something and stopped changing.
 *
 * Loading a recorded run is not one event: the manifest resolves, a 76 MB result is read, the
 * cloud is built, then the floor is fitted. A fixed sleep long enough for the slowest of those
 * is dead time on every other state, and one tuned to a fast machine captures a half-drawn pane.
 */
async function settled(socket, selector) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(500);
    const ready = await evaluate(
      socket,
      `const el = document.querySelector(${JSON.stringify(selector)});
       const busy = document.body.textContent.includes("Nothing on the wire yet");
       return Boolean(el) && !busy;`,
    );
    if (ready) {
      await wait(1500);
      return;
    }
  }
  throw new Error(`nothing settled for ${selector} — the fixture may not be on disk`);
}

async function reload(socket) {
  await send(socket, "Page.navigate", { url: APP });
  await wait(2500);
}

// ------------------------------------------------------------------ the drive

async function main() {
  const only = process.argv[2];
  const states = only ? STATES.filter((s) => s.name === only) : STATES;
  if (states.length === 0) {
    console.error(`unknown state "${only}". Known: ${STATES.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  try {
    await fetch(APP, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error(`No dev server on ${APP}. Start it first, then re-run this.`);
    process.exit(1);
  }

  const profile = await mkdtemp(join(tmpdir(), "verge-capture-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let socket;
  try {
    let page;
    for (let attempt = 0; attempt < 40 && !page; attempt++) {
      await wait(250);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = targets.find((t) => t.type === "page");
      } catch {
        /* Chrome is still opening its port. */
      }
    }
    if (!page) throw new Error("Chrome never exposed a page target");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    attach(socket);
    await new Promise((ok, no) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", () => no(new Error("could not attach to Chrome")), { once: true });
    });

    await send(socket, "Page.enable");
    await send(socket, "Runtime.enable");
    // The window flag sizes the OS window; this sizes the page, which is what the checklist
    // measures. Without it a headless capture comes back a few pixels short of 800.
    await send(socket, "Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await reload(socket);

    for (const state of states) {
      await state.setup(socket);
      const shot = await send(socket, "Page.captureScreenshot", { format: "png" });
      const path = join(OUT, `${state.name}.png`);
      await writeFile(path, Buffer.from(shot.data, "base64"));
      const kib = (Buffer.from(shot.data, "base64").byteLength / 1024).toFixed(0);
      console.log(`${state.name}.png  ${kib} KiB  — ${state.what}`);
    }
  } finally {
    socket?.close();
    chrome.kill();
    // Chrome writes to its profile as it shuts down, so removing the directory the instant
    // after kill() races it and throws ENOTEMPTY on a run that otherwise succeeded.
    await new Promise((ok) => chrome.once("exit", ok));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nWrote to docs/reference/. Look at them before committing.`);
}

await main();
