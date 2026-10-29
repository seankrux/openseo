// axe WCAG 2.1 AA + reflow gate. Usage: BASE=http://127.0.0.1:3001 node check.js [routes...]
// Exits 1 on any axe violation or horizontal scroll at 320px.
const puppeteer = require('puppeteer-core');
const axe = require('axe-core');
const base = process.env.BASE || 'http://127.0.0.1:3001';
const routes = process.argv.slice(2).length ? process.argv.slice(2) : require('./routes.json');
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  let fail = 0;
  for (const p of routes) {
    const pg = await b.newPage();
    await pg.setViewport({ width: 1366, height: 900 });
    await pg.goto(base + p, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await pg.addScriptTag({ content: axe.source });
    const r = await pg.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }));
    for (const v of r.violations) { fail++; console.log(`FAIL ${p} ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target.join(' ')}`); }
    await pg.setViewport({ width: 320, height: 800 });
    await new Promise(r => setTimeout(r, 800));
    if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)) { fail++; console.log(`FAIL ${p} reflow: horizontal scroll at 320px`); }
    await pg.close();
  }
  await b.close();
  console.log(fail ? `${fail} failure(s) across ${routes.length} routes` : `PASS ${routes.length} routes`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
