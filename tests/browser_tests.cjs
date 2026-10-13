/* Local browser regressions. No physician data is sent to an external service.
   Install Playwright only for development, not for running the dashboard. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.SME_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'verification');
const KEY = 'smeConnections.alternative.myNetwork';
const results = [];
fs.mkdirSync(OUT, { recursive: true });
let browser;

const snapshot = (page) => page.evaluate(() => window.SME_DIAGNOSTICS.snapshot());
async function settled(page) {
  await page.waitForFunction(() => document.getElementById('loading').hidden, null, { timeout: 10000 });
  await page.waitForTimeout(450);
}
async function search(page, text) {
  await page.locator('#q').fill(text);
  await page.locator('#results [data-i]').first().waitFor({ state: 'visible' });
  await page.locator('#q').press('Enter');
  await settled(page);
}
async function examplePhysician(page) {
  return page.evaluate(() => SME_DATA.smes.find((s) => s.first && s.last && s.last.length >= 2 &&
    SME_DATA.smes.filter((other) => other.name.toLowerCase() === s.name.toLowerCase()).length === 1));
}
async function searchExample(page) {
  const example = await examplePhysician(page);
  assert(example, 'A uniquely named source-derived test record exists');
  await search(page, example.name);
  assert.equal(await page.locator('#panel h2').innerText(), example.name);
  return example;
}
async function test(name, fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [];
  await context.route(/https?:\/\//, (route) => { external.push(route.request().url()); return route.abort(); });
  if (options.init) await context.addInitScript(options.init);
  await context.setOffline(true);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  const start = Date.now();
  try {
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.waitForFunction(() => Boolean(window.SME_DIAGNOSTICS));
    await settled(page);
    await fn(page, context);
    assert.deepEqual(errors, [], 'Browser errors');
    assert.deepEqual(external, [], 'External requests');
    results.push({ name, passed: true, durationMs: Date.now() - start,
      browserErrorCount: errors.length, externalRequestCount: external.length });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, passed: false, durationMs: Date.now() - start, error: String(error) });
    console.error('FAIL', name, String(error));
    await page.screenshot({ path: path.join(OUT, `failure-${results.length}.png`), fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}

// Independent adjacency oracle built from the delivered source data, not application functions.
function connections(data, realOnly) {
  const groups = new Map(), adj = new Map(data.smes.map((s) => [s.id, new Set()]));
  for (const s of data.smes) {
    const ids = [...s.institutions.map((a) => a.id), ...s.studies.map((a) => a.id), ...(realOnly ? [] : s.competitorTrials)];
    for (const id of ids) { if (!groups.has(id)) groups.set(id, new Set()); groups.get(id).add(s.id); }
  }
  for (const ids of groups.values()) for (const a of ids) for (const b of ids) if (a !== b) adj.get(a).add(b);
  return adj;
}
function distances(adj, src) {
  const d = new Map([[src, 0]]), queue = [src];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (d.get(u) === 3) continue;
    for (const v of adj.get(u)) if (!d.has(v)) { d.set(v, d.get(u) + 1); queue.push(v); }
  }
  return d;
}
function pathPair(data, kind) {
  const real = connections(data, true), all = connections(data, false);
  for (const s of data.smes) {
    const rd = distances(real, s.id), ad = distances(all, s.id);
    for (const [target, distance] of ad) {
      if (target === s.id) continue;
      if ((kind === 'synthetic' && !rd.has(target)) || (kind === 'preferred' && rd.has(target) && rd.get(target) > distance)) {
        return { src: s, target: data.smes.find((x) => x.id === target), realHops: rd.get(target), demoHops: distance };
      }
    }
  }
  throw new Error(`No source-derived ${kind} path example found`);
}

(async () => {
  browser = await chromium.launch({ executablePath: process.env.SME_BROWSER || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });

  await test('Offline initial view, source counts, bounded graph, synthetic default', async (page) => {
    const d = await page.evaluate(() => window.SME_DATA), s = await snapshot(page);
    assert.equal(await page.locator('#statPhysicians').innerText(), String(d.smes.length));
    assert.equal(await page.locator('#statInstitutions').innerText(), String(d.institutions.length));
    assert.equal(await page.locator('#statStudies').innerText(), String(d.studies.length));
    assert.equal(await page.locator('#statTrials').innerText(), String(d.competitorTrials.length));
    assert.equal(await page.locator('#showSynth').isChecked(), true);
    assert.equal(s.nodes.filter((n) => n.group === 'sme').length, 40);
    assert(s.nodes.some((n) => n.group === 'ct'));
    assert(s.nodes.filter((n) => n.group === 'ct').every((n) => n.label.includes('SYNTHETIC')));
    const ids = new Set(s.nodes.map((n) => n.id));
    assert(s.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
    assert.match(await page.locator('.banner').innerText(), /Internal.*Do not distribute/);
    assert(await page.locator('#net canvas').count() > 0);
    await page.screenshot({ path: path.join(OUT, 'network-overview-1440.png') });
  });

  await test('Every overview relationship layer renders only its intended types', async (page) => {
    for (const [layer, kind] of [['studies', 'study'], ['institutions', 'inst'], ['competitor', 'ct']]) {
      await page.locator('#layer').selectOption(layer); await settled(page);
      const s = await snapshot(page);
      assert(s.nodes.length > 0);
      assert(s.nodes.every((n) => n.group === 'sme' || n.group === kind));
      assert(s.nodes.filter((n) => n.group === 'sme').length <= 40);
    }
    await page.locator('#showSynth').uncheck(); await settled(page);
    assert.equal((await snapshot(page)).nodes.length, 0);
    assert.equal(await page.locator('#graphEmpty').isVisible(), true);
  });

  await test('Case-insensitive keyboard search, briefing, aliases, stale-search guard', async (page) => {
    const example = await examplePhysician(page);
    await search(page, example.name.toUpperCase());
    assert.equal(await page.locator('#panel h2').innerText(), example.name);
    assert.equal((await snapshot(page)).view.kind, 'sme');
    const before = (await snapshot(page)).view.id;
    await page.locator('#q').fill(''); await page.locator('#q').press('Enter');
    assert.equal((await snapshot(page)).view.id, before);
    await search(page, 'Emoblization');
    assert.equal(await page.locator('#panel h2').innerText(), 'Embolization');
    assert.match(await page.locator('#panel').innerText(), /Also recorded as/);
    const elapsed = await page.evaluate((query) => {
      const q = document.getElementById('q'), start = performance.now();
      q.value = query; q.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - start;
    }, example.name.toLowerCase());
    assert(elapsed < 100, `Search took ${elapsed} ms`);
  });

  await test('Star persistence uses separate storage and leaves v1.1 key untouched', async (page) => {
    await page.evaluate(() => localStorage.setItem('smeConnections.myNetwork', JSON.stringify(['S1'])));
    await searchExample(page); await page.locator('#starBtn').click();
    assert.match(await page.locator('#myCount').innerText(), /1/);
    assert.equal(await page.locator('#starBtn').getAttribute('aria-pressed'), 'true');
    await page.reload(); await settled(page);
    const example = await examplePhysician(page);
    assert((await page.locator('#myNet').innerText()).includes(example.name));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('smeConnections.myNetwork'))), ['S1']);
    await page.locator('#myNet [data-unstar]').click();
    assert.equal(await page.locator('#myCount').innerText(), '');
  });

  await test('Storage denied, stars remain usable in memory', async (page) => {
    assert.equal(await page.locator('#storageNote').isVisible(), true);
    await searchExample(page); await page.locator('#starBtn').click();
    assert.match(await page.locator('#myCount').innerText(), /1/);
    await page.locator('#starBtn').click();
    assert.equal(await page.locator('#myCount').innerText(), '');
  }, { init: () => {
    Storage.prototype.getItem = function () { throw new Error('Storage denied for regression'); };
    Storage.prototype.setItem = function () { throw new Error('Storage denied for regression'); };
  } });

  await test('Corrupted persisted network cannot crash the app', async (page) => {
    assert.equal(await page.locator('#storageNote').isVisible(), true);
    await searchExample(page); await page.locator('#starBtn').click();
    assert.match(await page.locator('#myCount').innerText(), /1/);
  }, { init: () => localStorage.setItem('smeConnections.alternative.myNetwork', '{invalid json') });

  await test('Filters are explicit, reversible, and preserved by Back and Forward', async (page) => {
    await page.locator('#fTa').selectOption('TA1'); await settled(page);
    assert.match(await page.locator('#filterStatus').innerText(), /Aortic/);
    await page.locator('[data-scn="B"]').click(); await settled(page);
    await page.locator('[data-scn="A"]').click(); await settled(page);
    assert.equal(await page.locator('#fTa').inputValue(), '');
    await page.locator('#navBack').click(); await settled(page);
    assert.equal(await page.locator('#fTa').inputValue(), 'TA1');
    assert.equal((await snapshot(page)).view.id, 'B');
    await page.locator('#navFwd').click(); await settled(page);
    assert.equal(await page.locator('#fTa').inputValue(), '');
    await page.locator('[data-scn="D"]').click(); await settled(page);
    assert.equal(await page.locator('#fTa').inputValue(), '', 'No silent Aortic default');
    await page.locator('#fRegion').selectOption('AMER'); await settled(page);
    await page.locator('#clearFilters').click(); await settled(page);
    assert.equal(await page.locator('#fRegion').inputValue(), '');
  });

  await test('Unknown advocate status is not treated as recorded non-advocate', async (page) => {
    const counts = await page.evaluate(() => ({ no: SME_DATA.smes.filter((s) => s.isCookAdvocate === 'No').length,
      unknown: SME_DATA.smes.filter((s) => !s.isCookAdvocate).length }));
    for (const [value, expected] of [['No', counts.no], ['Unknown', counts.unknown]]) {
      await page.locator('#fAdvocate').selectOption(value); await settled(page);
      assert.match(await page.locator('#filterStatus').innerText(), new RegExp(`^${expected} of`));
    }
  });

  await test('Scenario lists, source criteria, individual synthetic badges, and real-only mode', async (page) => {
    await page.locator('#fTa').selectOption('TA1'); await settled(page);
    const d = await page.evaluate(() => SME_DATA), byId = new Map(d.smes.map((s) => [s.id, s]));
    for (const key of ['B', 'C', 'D']) {
      await page.locator(`[data-scn="${key}"]`).click(); await settled(page);
      const rows = await page.locator('.cand').evaluateAll((els) => els.map((e) => ({ id: e.dataset.sid,
        synthetic: e.dataset.synthetic === 'true', hasBadge: Boolean(e.querySelector('.syn')) })));
      assert(rows.length > 0 && rows.length <= 15);
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
      assert(rows.every((r) => byId.get(r.id).tas.includes('TA1')));
      if (key === 'C') assert(rows.every((r) => { const s = byId.get(r.id); return s.isCookAdvocate !== 'Yes' && !s.studies.length && !s.engagements.length && !s.programs.length; }));
      if (key === 'B') assert(rows.some((r) => r.synthetic) && rows.filter((r) => r.synthetic).every((r) => r.hasBadge));
      await page.locator('#showSynth').uncheck(); await settled(page);
      assert.equal((await snapshot(page)).nodes.filter((n) => n.group === 'ct').length, 0);
      assert.equal(await page.locator('.cand[data-synthetic="true"]').count(), 0);
      assert.equal(await page.locator('#panel .syn').count(), 0);
      await page.locator('#showSynth').check(); await settled(page);
    }
  });

  await test('Candidate briefing, star update, and Back restore the candidate list', async (page) => {
    await page.locator('[data-scn="B"]').click(); await settled(page);
    const id = await page.locator('.cand').first().getAttribute('data-sid');
    await page.locator('.cand').first().click(); await settled(page);
    assert.equal((await snapshot(page)).view.id, id);
    assert.equal((await snapshot(page)).view.kind, 'sme');
    await page.locator('#starBtn').click();
    assert.equal(await page.locator('#starBtn').getAttribute('aria-pressed'), 'true');
    await page.locator('#navBack').click(); await settled(page);
    assert.equal((await snapshot(page)).view.id, 'B');
    assert(await page.locator('.cand').count() > 0);
    await page.locator('#navFwd').click(); await settled(page);
    assert.equal((await snapshot(page)).view.id, id);
  });

  await test('Attribute inspection and focal graph participate in history', async (page) => {
    const example = await page.evaluate(() => SME_DATA.smes.find((s) => s.studies.length && s.engagements.some((e) => e.notes)));
    assert(example, 'A source record with study and engagement evidence exists');
    await search(page, example.name);
    assert((await page.locator('#panel').innerText()).includes(example.engagements.find((e) => e.notes).notes));
    const id = await page.locator('#panel [data-go^="CS"]').first().getAttribute('data-go');
    await page.locator(`#panel [data-go="${id}"]`).click(); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'inspect');
    await page.locator('#mkFocal').click(); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'attr');
    await page.locator('#navBack').click(); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'inspect');
    await page.locator('#navBack').click(); await settled(page);
    assert.equal(await page.locator('#panel h2').innerText(), example.name);
  });

  await test('Synthetic hiding clears an open fictional trial and blocks hidden-history leakage', async (page) => {
    await search(page, 'Competitor Trial A (');
    assert.match(await page.locator('#panel').innerText(), /fictional/);
    await page.locator('#showSynth').uncheck(); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'overview');
    assert.equal(await page.locator('#panel .syn').count(), 0);
    await page.locator('#navBack').click(); await settled(page);
    await page.locator('#navFwd').click(); await settled(page);
    assert.equal((await snapshot(page)).nodes.filter((n) => n.group === 'ct').length, 0);
    assert.equal(await page.locator('#panel .syn').count(), 0);
    await page.locator('#q').fill('Competitor Trial');
    assert.equal(await page.locator('#results [data-i]').count(), 0);
  });

  await test('Recorded paths are preferred even when a synthetic route is shorter', async (page) => {
    const d = await page.evaluate(() => SME_DATA), pair = pathPair(d, 'preferred');
    await search(page, pair.target.name); await page.locator('#starBtn').click();
    await search(page, pair.src.name);
    const route = page.locator(`.path[data-target="${pair.target.id}"]`);
    assert.equal(await route.getAttribute('data-synthetic'), 'false');
    assert.match(await route.innerText(), new RegExp(`\\(${pair.realHops} hops?\\)`));
    await route.click(); await page.waitForTimeout(600);
    const s = await snapshot(page);
    assert(s.edges.some((e) => e.id.startsWith('path:')));
    assert(Object.values(s.positions).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    await page.screenshot({ path: path.join(OUT, 'physician-briefing-path-1440.png') });
  });

  await test('Synthetic-only routes are labelled hypothetical and vanish in real-only mode', async (page) => {
    const d = await page.evaluate(() => SME_DATA), pair = pathPair(d, 'synthetic');
    await search(page, pair.target.name); await page.locator('#starBtn').click();
    await search(page, pair.src.name);
    const route = page.locator(`.path[data-target="${pair.target.id}"]`);
    assert.equal(await route.getAttribute('data-synthetic'), 'true');
    assert.match(await route.innerText(), /SYNTHETIC.*Hypothetical/s);
    await route.click();
    await page.locator('#showSynth').uncheck(); await settled(page);
    assert.equal(await page.locator('.path[data-synthetic="true"]').count(), 0);
    assert.match(await page.locator('#paths').innerText(), /No connection within 3 hops/);
    assert.equal((await snapshot(page)).nodes.filter((n) => n.group === 'ct').length, 0);
  });

  await test('Actual graph click opens a physician briefing, zoom and fit work', async (page) => {
    const s = await snapshot(page), rect = await page.locator('#net').boundingBox();
    const id = s.nodes.filter((n) => n.group === 'sme').map((n) => n.id).find((id) => {
      const p = s.canvasPositions[id];
      return p.x > 15 && p.y > 15 && p.x < rect.width - 15 && p.y < rect.height - 15 &&
        Object.entries(s.canvasPositions).every(([other, q]) => other === id || Math.hypot(p.x - q.x, p.y - q.y) > 12);
    });
    assert(id, 'A visible isolated click target exists');
    const p = s.canvasPositions[id];
    await page.mouse.click(rect.x + p.x, rect.y + p.y); await settled(page);
    assert.equal((await snapshot(page)).view.id, id);
    const scale = (await snapshot(page)).scale;
    await page.locator('#zoomIn').click(); await page.waitForTimeout(300);
    assert((await snapshot(page)).scale > scale);
    await page.locator('#zoomOut').click(); await page.waitForTimeout(300);
    await page.locator('#fit').click(); await page.waitForTimeout(450);
    assert((await snapshot(page)).scale > 0);
  });

  await test('Responsive layouts avoid horizontal overflow at laptop and mobile widths', async (page) => {
    for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(500);
      const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth, net: document.getElementById('net').getBoundingClientRect().width }));
      assert(dimensions.scroll <= dimensions.client + 1, `Overflow at ${width}px`);
      assert(dimensions.net > 200, `Graph too narrow at ${width}px`);
      assert.equal(await page.locator('.banner').isVisible(), true);
      await page.screenshot({ path: path.join(OUT, `layout-${width}.png`), fullPage: true });
    }
  });

  await test('Keyboard-accessible area links, reset view, and stars preserved on reset', async (page) => {
    await page.locator('.area-row [data-go]').first().focus();
    await page.locator('.area-row [data-go]').first().press('Enter'); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'attr');
    await searchExample(page); await page.locator('#starBtn').click();
    await page.locator('#fTa').selectOption('TA1'); await settled(page);
    await page.locator('#resetDemo').click(); await settled(page);
    assert.equal((await snapshot(page)).view.kind, 'overview');
    assert.equal(await page.locator('#fTa').inputValue(), '');
    assert.equal(await page.locator('#layer').inputValue(), 'combined');
    assert.match(await page.locator('#myCount').innerText(), /1/);
  });

  await test('Copied standalone folder opens offline with no original code dependency', async (page) => {
    const scratch = process.env.TMPDIR;
    assert(scratch, 'TMPDIR must name the managed scratch directory');
    const copy = fs.mkdtempSync(path.join(scratch, 'sme-copy-'));
    try {
      for (const item of ['index.html', 'app.css', 'app.js', 'data', 'vendor']) {
        fs.cpSync(path.join(ROOT, item), path.join(copy, item), { recursive: true });
      }
      await page.goto(pathToFileURL(path.join(copy, 'index.html')).href);
      await page.waitForFunction(() => Boolean(window.SME_DIAGNOSTICS)); await settled(page);
      assert.equal((await snapshot(page)).view.kind, 'overview');
      await searchExample(page);
    } finally { fs.rmSync(copy, { recursive: true, force: true }); }
  });

  await browser.close();
  const failed = results.filter((r) => !r.passed).length;
  const report = { generatedAt: new Date().toISOString(), browser: 'Installed Google Chrome on Linux, headless',
    runtime: 'file://, browser offline, HTTP/HTTPS requests rejected', tests: results.length,
    passed: results.length - failed, failed, results };
  fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ tests: report.tests, passed: report.passed, failed: report.failed }));
  process.exitCode = failed ? 1 : 0;
})().catch(async (error) => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
