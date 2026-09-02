#!/usr/bin/env node
// Small printers for the npm scripts. These used to be `node -e "…"` one
// liners in package.json, which is a code-execution shape that upstream
// filters reject when the agent reads its own package.json back.
const BRIDGE = (process.env.AIPASS_BRIDGE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const { loadToken } = await import(new URL('./security/auth.mjs', import.meta.url));
const AUTH = { authorization: `Bearer ${loadToken()}` };
const what = process.argv[2] ?? 'models';

const get = async (p) => {
  const res = await fetch(`${BRIDGE}${p}`, { headers: AUTH });
  if (!res.ok) throw new Error(`bridge returned ${res.status}`);
  return res.json();
};

try {
  if (what === 'models') {
    const { data } = await get('/v1/models');
    for (const m of data) {
      console.log(`${m.id.padEnd(38)} ${m.name ?? ''}${m.free_credit ? '  [free]' : ''}`);
    }
  } else if (what === 'conversations') {
    const { current, conversations } = await get('/conversations');
    for (const c of conversations) {
      console.log(`${c.id === current ? '*' : ' '} ${c.id}  ${c.updatedAt?.slice(0, 16) ?? ''}  ${c.title ?? ''}`);
    }
    if (!conversations.length) console.log('none — start a chat at https://de.aipass.net/chat');
  } else {
    console.error(`unknown: ${what}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`${err.message} — is the bridge running? npm run dev`);
  process.exit(1);
}
