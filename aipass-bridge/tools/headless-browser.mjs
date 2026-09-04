#!/usr/bin/env node
// Hosts the aipass bridge extension + relay tab in a dedicated Chromium, so
// de.aipass.net never opens in the user's main browser.
//
// First run:   node tools/headless-browser.mjs --setup
//              Opens a visible window — log into de.aipass.net, then close it.
// Afterwards:  node tools/headless-browser.mjs
//              Headless relay. Keep alive with nohup or a LaunchAgent.
//
// ponytail: playwright is resolved from the local dev-browser install instead
// of adding a dependency to this repo — promote to package.json if this
// outgrows single-machine use.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { chromium } from '/Users/macos/.dev-browser/node_modules/playwright/index.mjs';

const EXT = new URL('../extension', import.meta.url).pathname;
const PROFILE = `${os.homedir()}/.aipass-headless`;
const BRIDGE = 'http://127.0.0.1:8788'; // container 8787 -> host 8788
const setup = process.argv.includes('--setup');

// Read once; never printed, never written to the repo.
// Retry up to 10× with 3 s delay — container may not be ready yet at boot.
let token = '';
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    token = execFileSync('docker', ['exec', 'aipass-bridge', 'cat', '/home/bridge/.aipass-bridge/token'],
      { encoding: 'utf8' }).trim();
    break; // success
  } catch {
    if (attempt < 10) {
      console.error(`warning: bridge token read attempt ${attempt}/10 failed — retrying in 3 s`);
      execFileSync('sleep', ['3']);
    } else {
      console.error('warning: could not read bridge token via docker exec — set it in the extension popup');
    }
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !setup,
  channel: 'chromium', // bundled chromium: new headless supports extensions
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
if (sw && token) {
  await sw.evaluate(([u, t]) => chrome.storage.local.set({ bridgeUrl: u, token: t }), [BRIDGE, token])
    .then(() => console.log('extension configured (bridge url + token)'))
    .catch((e) => console.error('extension config failed:', e.message));
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'reconnect' })).catch(() => {});
}

const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://de.aipass.net/chat', { waitUntil: 'domcontentloaded' })
  .catch((e) => console.error('chat tab load:', e.message));

if (setup) {
  console.log('SETUP: log into de.aipass.net in the opened window, then close that window.');
  await new Promise((resolve) => ctx.on('close', resolve));
  console.log(`setup done — profile saved at ${PROFILE}`);
} else {
  console.log(`relay running headless (pid ${process.pid}), profile ${PROFILE}`);
  const stop = () => ctx.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // run until killed
}
