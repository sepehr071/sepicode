// Captures README screenshots of the real TUI: runs `bun scripts/demo.tsx` (scripted,
// offline agent) under a pseudo-terminal and renders its output with xterm.js in a
// headless Chromium page, then screenshots the page at key moments.
//
// Needs (outside the project):  npm i playwright @lydell/node-pty @xterm/xterm
// Run:  NODE_PATH=<that folder>/node_modules node scripts/capture-screenshots.cjs
// On Windows set BUN_EXE to the real bun.exe (the npm `bun` shim does not start under a PTY).
// Optional: CAPTURE_VIDEO=1 also records docs/images/demo.webm (convert with ffmpeg).
const path = require("path");
const fs = require("fs");
const pty = require("@lydell/node-pty");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs", "images");
const xtermDir = path.dirname(require.resolve("@xterm/xterm/package.json"));
const bun = process.env.BUN_EXE || "bun";
const COLS = 124;
const ROWS = 36;

const PAGE = `<!doctype html><html><head><style>
  html,body{margin:0;height:100%;background:#11111b;}
  body{display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 700px at 30% 0%,#2a2340 0%,#11111b 60%);}
  .win{border-radius:12px;overflow:hidden;background:#1e1e2e;
    box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px #313244;}
  .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#181825;
    font:13px "Segoe UI",system-ui,sans-serif;color:#7f849c;}
  .dot{width:12px;height:12px;border-radius:50%}
  .t{flex:1;text-align:center;margin-right:52px}
  #term{padding:10px 12px 12px}
</style></head><body><div class="win"><div class="bar">
<span class="dot" style="background:#f38ba8"></span><span class="dot" style="background:#f9e2af"></span>
<span class="dot" style="background:#a6e3a1"></span><span class="t">sepicode — bun run demo</span></div>
<div id="term"></div></div></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    ...(process.env.CAPTURE_VIDEO ? { recordVideo: { dir: out, size: { width: 1440, height: 900 } } } : {}),
  });
  const page = await ctx.newPage();
  await page.setContent(PAGE);
  await page.addStyleTag({ path: path.join(xtermDir, "css", "xterm.css") });
  await page.addScriptTag({ path: path.join(xtermDir, "lib", "xterm.js") });
  await page.evaluate(
    ([cols, rows]) => {
      const term = new window.Terminal({
        cols, rows, fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 16, lineHeight: 1.05,
        allowProposedApi: true, cursorBlink: false,
        theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cba6f7" },
      });
      term.open(document.getElementById("term"));
      window.term = term;
      window.replies = [];
      term.onData((d) => window.replies.push(d)); // answers to terminal capability queries
    },
    [COLS, ROWS],
  );

  const proc = pty.spawn(bun, ["scripts/demo.tsx"], {
    name: "xterm-256color", cols: COLS, rows: ROWS, cwd: root,
    env: { ...process.env, COLORTERM: "truecolor", TERM: "xterm-256color", SEPICODE_MODEL: "anthropic/claude-opus-4.8",
      SEPICODE_DEMO_CWD: "~/projects/demo-app" },
  });
  let buf = "";
  proc.onData((d) => (buf += d));
  const pump = setInterval(async () => {
    const chunk = buf;
    buf = "";
    const replies = await page
      .evaluate((c) => { if (c) window.term.write(c); const r = window.replies; window.replies = []; return r; }, chunk)
      .catch(() => []);
    for (const r of replies) proc.write(r);
  }, 30);

  const shot = async (name) => {
    await sleep(300);
    await page.screenshot({ path: path.join(out, name) });
    console.log("saved", name);
  };
  const type = async (text) => {
    for (const ch of text) { proc.write(ch); await sleep(18); }
  };

  await sleep(3000);
  await shot("welcome.png");
  await type("Sub-cent turns show $0.00 in the status line. Show a third decimal below one cent.");
  await sleep(400);
  proc.write("\r");
  await sleep(3900);
  await shot("tool-calls-running.png");
  await sleep(4500);
  // hero.png: the file_edit diff frame, scaled under a one-line pitch (composed on a second page).
  // Crop from a full-viewport shot: element screenshots re-layout and blank the xterm canvas.
  const box = await page.locator(".win").boundingBox();
  const win = (await page.screenshot({ clip: box })).toString("base64");
  const hero = await ctx.newPage();
  await hero.setContent(`<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:26px;background:radial-gradient(1200px 700px at 30% 0%,#2a2340 0%,#11111b 60%);">
    <div style="font:600 34px 'Segoe UI',system-ui,sans-serif;color:#cdd6f4;letter-spacing:-.5px">sepicode
    <span style="color:#7f849c;font-weight:400">· a terminal coding agent on Bun + OpenTUI</span></div>
    <img src="data:image/png;base64,${win}" style="width:1020px;border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.55)"></body>`);
  await hero.screenshot({ path: path.join(out, "hero.png") });
  await hero.close();
  console.log("saved hero.png");
  await type("/help");
  proc.write("\r");
  await sleep(1200);
  await shot("slash-commands.png");

  clearInterval(pump);
  proc.kill();
  await ctx.close();
  await browser.close();
  process.exit(0);
})();
