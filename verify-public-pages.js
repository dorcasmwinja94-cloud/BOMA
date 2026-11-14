const SHOTS = "C:\\ORMS\\screenshots";
const ORIGIN = "http://localhost:3000";

function getJson(url) { return fetch(url).then(r => r.json()); }
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let nextId = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++nextId;
          pending.set(msgId, { res, rej, method });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      events,
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(method + ": " + JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) events.push(msg);
    };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const page = (await getJson("http://127.0.0.1:9222/json")).find(p => p.type === "page");
  if (!page) throw new Error("No Chrome page target");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const consoleErrors = [];
  function drain() {
    while (cdp.events.length) {
      const msg = cdp.events.shift();
      if (msg.method === "Runtime.exceptionThrown") consoleErrors.push("EXCEPTION: " + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push("CONSOLE: " + msg.params.args.map(a => a.value || a.description || "").join(" "));
    }
  }
  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    drain();
    if (result.exceptionDetails) throw new Error("Browser error: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    return result.result.value;
  }
  async function navigate(url) {
    await cdp.send("Page.navigate", { url });
    await sleep(1800);
  }
  async function bodyText() { return String(await evaluate("document.body.innerText")).replace(/\n+/g, " | "); }
  async function screenshot(file) {
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    require("fs").writeFileSync(SHOTS + "\\" + file, Buffer.from(r.data, "base64"));
    console.log("SHOT:", file);
  }

  // /catalog
  await navigate(ORIGIN + "/catalog");
  const catalogText = await bodyText();
  console.log("CATALOG TEXT (first 400):", catalogText.slice(0, 400));
  await screenshot("public-catalog.png");

  // /book
  await navigate(ORIGIN + "/book");
  const bookText = await bodyText();
  console.log("BOOK TEXT (first 400):", bookText.slice(0, 400));
  await screenshot("public-book.png");

  // /register
  await navigate(ORIGIN + "/register");
  const registerText = await bodyText();
  console.log("REGISTER TEXT (first 400):", registerText.slice(0, 400));
  await screenshot("public-register.png");

  // /reset-password
  await navigate(ORIGIN + "/reset-password");
  const resetText = await bodyText();
  console.log("RESET TEXT (first 400):", resetText.slice(0, 400));
  await screenshot("public-reset-password.png");

  console.log("\nConsole errors:", consoleErrors.length ? consoleErrors.join("\n") : "none");
  cdp.close();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
