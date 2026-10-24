'use strict';
(function () {
  const YMIN = 862, YMAX = 2026, VW = 1000, VH = 700;
  const PX = 8; // пикселей на год на точной шкале
  const EVENTS = (window.EVENTS || []).map((e, i) => ({ ...e, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const NAMES = window.NAMES || {};
  const KIND = { gain: 'приобретение', loss: 'потеря', occ: 'оккупация', annex: 'аннексия', event: 'событие' };
  const nf = new Intl.NumberFormat('ru-RU');

  // Ориентиры на карте по важности; названия меняются вместе с эпохой.
  const CITIES = [
    { at: [37.62, 55.75], names: [[1147, 'Москва']] },
    { at: [30.31, 59.94], names: [[1703, 'Санкт-Петербург'], [1914, 'Петроград'], [1924, 'Ленинград'], [1991, 'Санкт-Петербург']] },
    { at: [30.52, 50.45], names: [[YMIN, 'Киев']] },
    { at: [31.27, 58.52], names: [[YMIN, 'Новгород']] },
    { at: [28.98, 41.01], names: [[YMIN, 'Константинополь'], [1930, 'Стамбул']] },
    { at: [21.01, 52.23], names: [[1300, 'Варшава']] },
    { at: [68.25, 58.2], names: [[1587, 'Тобольск']] },
    { at: [129.73, 62.03], names: [[1632, 'Якутск']] },
    { at: [131.9, 43.12], names: [[1860, 'Владивосток']] },
  ];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const area = (k) => k >= 1e6
    ? (k / 1e6).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' млн км²'
    : nf.format(Math.round(k / 1000)) + ' тыс. км²';
  const delta = (d) => (d >= 0 ? '+' : '−') + area(Math.abs(d));
  const span = (a, b) => (a === b ? `${a} г.` : `${a}–${b} гг.`);
  const years = (ys) => (ys.length === 1 ? `${ys[0]} г.` : ys.slice(0, 3).join(', ') + (ys.length > 3 ? '…' : '') + ' гг.');
  const ruName = (n) => NAMES[n] || n;
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mq = window.matchMedia('(max-width: 899px)');
  const mobile = () => mq.matches;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = { year: 1914, follow: true, playing: false, t: d3.zoomIdentity, open: new Set(), sheet: false, peek: 0 };
  const hy = /^#(\d{3,4})$/.exec(location.hash);
  if (hy && +hy[1] >= YMIN && +hy[1] <= YMAX) S.year = +hy[1];

  const svg = d3.select('#map');
  const world = d3.select('#world');
  const projection = d3.geoConicEqualArea().rotate([-100, 0]).parallels([50, 70]);
  const path = d3.geoPath(projection);
  let L = null; // слои данных

  // Cliopatria и mapshaper пишут кольца в разном порядке; d3 нужен «по часовой».
  function rewindPoly(rings) {
    const f = { type: 'Polygon', coordinates: rings };
    return d3.geoArea(f) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings;
  }
  function rewind(g) {
    if (!g) return g;
    if (g.type === 'Polygon') g.coordinates = rewindPoly(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map(rewindPoly);
    return g;
  }
  const dOf = (f) => (f._d === undefined ? (f._d = path(f) || '') : f._d);
  const bOf = (f) => (f._b === undefined ? (f._b = path.bounds(f)) : f._b);
  const active = (arr, y) => arr.filter((f) => f.properties.from <= y && y <= f.properties.to);

  Promise.all(['data/borders.json', 'data/base.json', 'data/corrections.json'].map((u) =>
    fetch(u).then((r) => { if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); })))
    .then(init)
    .catch((e) => { $('#mapmsg').textContent = 'Не удалось загрузить данные карты (' + e.message + '). Обновите страницу.'; });

  function init([topo, base, corr]) {
    const land = topojson.feature(base, base.objects.land);
    const lakes = topojson.feature(base, base.objects.lakes);
    land.features.forEach((f) => rewind(f.geometry));
    lakes.features.forEach((f) => rewind(f.geometry));
    projection.fitExtent([[0, 0], [VW, VH]], { type: 'MultiPoint', coordinates: [[-10, 36], [45, 30], [100, 20], [150, 40], [-150, 62], [60, 80], [120, 78]] });

    L = { state: [], context: [], rus: [], change: [], overlay: [] };
    for (const f of topojson.feature(topo, topo.objects.raw).features) {
      rewind(f.geometry);
      const p = f.properties;
      if (p.layer === 'context') (p.rus ? L.rus : L.context).push(f);
      else L[p.layer].push(f);
    }
    L.state.sort((a, b) => a.properties.from - b.properties.from);
    L.state.forEach((f, i) => {
      const prev = L.state[i - 1];
      if (prev && prev.properties.to === f.properties.from - 1) f.prevKm2 = prev.properties.km2;
    });
    L.context.forEach((f) => { f.cls = 'ctx c' + (hash(f.properties.name) % 4); });

    d3.select('#sphere').attr('d', path({ type: 'Sphere' }));
    d3.select('#grat').attr('d', path(d3.geoGraticule().step([10, 10])()));
    d3.select('#land').attr('d', path(land));
    d3.select('#lakes').attr('d', path(lakes));

    buildBands();
    buildList();
    buildAbout(corr);
    $('#mapmsg').hidden = true;
    renderNow();
    measurePeek();
    drawDial();
    setYear(S.year, { instant: true });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(onResize, 80); });
    mq.addEventListener('change', () => { setOpen(false); onResize(); });
  }
  function onResize() {
    measurePeek();
    drawBands();
    drawDial();
    if (S.follow) followState(true);
    else { placeScreen(); layoutLabels(); }
  }

  /* ---------- карта ---------- */
  const zoom = d3.zoom().scaleExtent([0.4, 60])
    .on('zoom', (e) => {
      S.t = e.transform;
      world.attr('transform', S.t);
      const k = 1 / S.t.k;
      d3.selectAll('#map pattern').each(function () {
        const r = this.getAttribute('data-rot') ?? (this.getAttribute('patternTransform') || '').replace(/ scale\(.*\)/, '');
        this.setAttribute('data-rot', r);
        this.setAttribute('patternTransform', `${r} scale(${k})`);
      });
      placeScreen();
      if (e.sourceEvent && S.follow) setFollow(false);
    })
    .on('end', () => layoutLabels());
  svg.call(zoom).on('dblclick.zoom', null);
  $('#zin').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
  $('#zout').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
  $('#follow').onclick = () => { setFollow(!S.follow); if (S.follow) followState(); };
  function setFollow(v) { S.follow = v; $('#follow').setAttribute('aria-pressed', String(v)); }

  function size() { const n = svg.node(); return [n.clientWidth || 800, n.clientHeight || 500]; }

  // Часть карты, не закрытая карточкой года и нижней панелью: в неё вписываются границы.
  function viewRect() {
    const [w, h] = size();
    const r = svg.node().getBoundingClientRect(), c = $('#card').getBoundingClientRect();
    const top = clamp(c.bottom - r.top + 8, 0, h * 0.45);
    const bottom = h - (mobile() ? S.peek + 8 : 0);
    return [0, top, w, Math.max(top + 120, bottom)];
  }
  function targetBounds() {
    const fs = L.state.length ? active(L.state, S.year) : [];
    let feats = fs.concat(active(L.overlay, S.year));
    if (!fs.length) feats = feats.concat(active(L.rus, S.year));
    if (!feats.length && !S.focusAt) return [projection([20, 62]), projection([60, 44])];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (b) => { x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]); x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]); };
    for (const f of feats) add(bOf(f));
    // Место выбранного события тоже должно попасть в кадр (Аляска, Порт-Артур).
    if (S.focusAt) { const p = projection(S.focusAt); add([[p[0] - 15, p[1] - 15], [p[0] + 15, p[1] + 15]]); }
    const min = 90, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (x1 - x0 < min) { x0 = cx - min / 2; x1 = cx + min / 2; }
    if (y1 - y0 < min * 0.7) { y0 = cy - min * 0.35; y1 = cy + min * 0.35; }
    return [[x0, y0], [x1, y1]];
  }
  function fitT(b) {
    const [vx0, vy0, vx1, vy1] = viewRect();
    const [[x0, y0], [x1, y1]] = b;
    const pad = mobile() ? 0.94 : 0.88;
    const k = Math.min(60, pad / Math.max((x1 - x0) / (vx1 - vx0), (y1 - y0) / (vy1 - vy0)));
    return d3.zoomIdentity.translate((vx0 + vx1) / 2, (vy0 + vy1) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }
  function followState(instant) {
    const t = fitT(targetBounds());
    S.focusAt = null;
    if (instant || reduced()) { svg.interrupt().call(zoom.transform, t); layoutLabels(); return; }
    const [vx0, vy0, vx1, vy1] = viewRect(), cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2, c = S.t;
    const dk = Math.abs(Math.log(t.k / c.k));
    const dx = Math.abs(c.invertX(cx) - t.invertX(cx)) * c.k, dy = Math.abs(c.invertY(cy) - t.invertY(cy)) * c.k;
    if (dk < 0.22 && dx < (vx1 - vx0) * 0.18 && dy < (vy1 - vy0) * 0.18) return;
    svg.interrupt().transition().duration(750).ease(d3.easeCubicInOut).call(zoom.transform, t);
  }

  function join(sel, feats, cls) {
    sel.selectAll('path').data(feats, (f) => f._id || (f._id = Math.random().toString(36).slice(2)))
      .join((en) => en.append('path').attr('d', dOf))
      .attr('class', cls);
  }

  function drawMap() {
    const y = S.year;
    join(d3.select('#g-ctx'), active(L.context, y), (f) => f.cls);
    const rus = active(L.rus, y);
    join(d3.select('#g-rusfill'), rus, () => 'rusfill');
    join(d3.select('#g-rusline'), rus, () => 'rusline');
    const st = active(L.state, y);
    join(d3.select('#g-state'), st, () => 'st');
    // Внутренняя кайма границы: широкая полупрозрачная линия, обрезанная самим полигоном.
    join(d3.select('#clip-st'), st, () => null);
    join(d3.select('#g-rib'), st, () => 'rib');
    // Прирост и утрату показываем десять лет после изменения: дальше это уже не новость.
    join(d3.select('#g-change'), recentChanges(y), (f) => 'chg-' + f.properties.kind);
    join(d3.select('#g-over'), active(L.overlay, y), (f) => 'ov-' + f.properties.kind);
    drawScreen();
  }
  const recentChanges = (y) => active(L.change, y).filter((f) => y - f.properties.from < 10);

  /* ---------- подписи, города, маркеры (в экранных координатах) ---------- */
  let labelData = [], cityData = [], evData = [], VR = [0, 0, 0, 0];
  function drawScreen() {
    const y = S.year;
    labelData = [];
    for (const f of active(L.state, y)) labelData.push({ f, text: f.properties.name, cls: 'lbl lbl-state', pri: 3, fs: 13, cw: 0.84, always: true });
    for (const f of active(L.rus, y)) labelData.push({ f, text: ruName(f.properties.name), cls: 'lbl lbl-rus', pri: 2, fs: 12, cw: 0.5 });
    for (const f of active(L.context, y)) labelData.push({ f, text: ruName(f.properties.name), cls: 'lbl lbl-ctx', pri: 1, fs: 11, cw: 0.58 });
    labelData.forEach((d) => { d.p = projection(d.f.properties.lp); d.km2 = d.f.properties.km2 || 0; });
    labelData.sort((a, b) => b.pri - a.pri || b.km2 - a.km2);
    d3.select('#g-labels').selectAll('text').data(labelData, (d) => d.f._id + d.cls)
      .join('text').attr('class', (d) => d.cls).attr('text-anchor', 'middle').attr('dy', '0.35em').text((d) => d.text);

    cityData = CITIES.map((c) => {
      const n = c.names.filter(([from]) => from <= y).pop();
      return n ? { p: projection(c.at), name: n[1] } : null;
    }).filter(Boolean);
    const cg = d3.select('#g-cities').selectAll('g').data(cityData, (d) => d.p.join()).join((en) => {
      const g = en.append('g');
      g.append('circle').attr('class', 'city').attr('r', 2.6);
      g.append('text').attr('class', 'lbl lbl-city').attr('x', 6).attr('dy', '0.35em');
      return g;
    });
    cg.select('text').text((d) => d.name);

    const cur = currentEvent();
    evData = EVENTS.filter((e) => e.at && e.y <= y && y - e.y < 10);
    d3.select('#g-events').selectAll('circle.pulse').data(cur && cur.at && y - cur.y < 10 ? [cur] : [], (e) => e.i)
      .join((en) => en.insert('circle', ':first-child').attr('r', 7))
      .attr('class', (e) => `pulse k-${e.k}`);
    d3.select('#g-events').selectAll('circle.ev').data(evData, (e) => e.i)
      .join((en) => en.append('circle').on('click', (ev, e) => { ev.stopPropagation(); hideTip(); openEvent(e, true); })
        .on('pointerenter', (ev, e) => { if (ev.pointerType === 'mouse') showTip(ev, `<b>${esc(e.t)}</b><span class="sub">${esc(e.d)}</span>`); })
        .on('pointerleave', hideTip))
      .attr('class', (e) => `ev k-${e.k}` + (cur && e.y === cur.y ? ' cur' : ''))
      .attr('opacity', (e) => 1 - (y - e.y) * 0.07);
    placeScreen();
    layoutLabels();
  }
  // Подпись государства держится внутри видимой части его территории.
  function labelXY(d) {
    const t = S.t;
    let x = t.applyX(d.p[0]), y = t.applyY(d.p[1]);
    if (d.pri === 3) {
      d.fs = Math.round(clamp((mobile() ? 12 : 14) + 2.4 * Math.log2(Math.max(1, t.k)), 12, 21));
      const b = bOf(d.f), hw = (d.text.length * d.fs * d.cw) / 2 + 6;
      const lo = Math.max(VR[0], t.applyX(b[0][0])) + hw, hi = Math.min(VR[2], t.applyX(b[1][0])) - hw;
      const top = Math.max(VR[1], t.applyY(b[0][1])) + d.fs, bot = Math.min(VR[3], t.applyY(b[1][1])) - d.fs;
      if (lo <= hi) x = clamp(x, lo, hi);
      if (top <= bot) y = clamp(y, top, bot);
    }
    return [x, y];
  }
  function placeScreen() {
    const t = S.t;
    VR = viewRect();
    d3.select('#g-labels').selectAll('text').each(function (d) {
      const [x, y] = labelXY(d);
      d.x = x; d.y = d.y0 = y;
      this.setAttribute('x', x); this.setAttribute('y', y);
      if (d.pri === 3) this.style.fontSize = d.fs + 'px';
    });
    d3.select('#g-cities').selectAll('g').attr('transform', (d) => `translate(${t.applyX(d.p[0])},${t.applyY(d.p[1])})`);
    d3.select('#g-events').selectAll('circle').attr('cx', (e) => t.apply(projection(e.at))[0]).attr('cy', (e) => t.apply(projection(e.at))[1]);
  }
  // Что закрыто интерфейсом поверх карты: туда подписи не ставим.
  function blockers() {
    const r = svg.node().getBoundingClientRect(), out = [];
    for (const el of [$('#card'), $('.maptools')]) {
      const b = el.getBoundingClientRect();
      if (b.width) out.push([b.left - r.left - 4, b.top - r.top - 4, b.right - r.left + 4, b.bottom - r.top + 4]);
    }
    if (mobile()) { const [w, h] = size(); out.push([0, h - S.peek, w, h]); }
    return out;
  }
  // Жадная раскладка: подпись государства уходит от городов вверх или вниз, затем города,
  // затем остальные подписи по размеру; перекрытия прячем.
  function layoutLabels() {
    const t = S.t, [w, h] = size(), boxes = blockers();
    const over = (a, o) => a[0] < o[2] && a[2] > o[0] && a[1] < o[3] && a[3] > o[1];
    const hit = (b) => boxes.some((o) => over(b, o));
    const lbox = (d, dy = 0) => {
      const tw = d.text.length * d.fs * d.cw + 4, th = d.fs + 4;
      return [d.x - tw / 2, d.y + dy - th / 2, d.x + tw / 2, d.y + dy + th / 2];
    };
    const cities = [];
    d3.select('#g-cities').selectAll('g').each((c) => {
      const x = t.applyX(c.p[0]), y = t.applyY(c.p[1]);
      c.box = [x - 4, y - 7, x + 8 + c.name.length * 6.2, y + 7];
      c.out = x < 0 || c.box[2] > w || y < 0 || y > h;
      if (!c.out) cities.push(c.box);
    });
    d3.select('#g-labels').selectAll('text').filter((d) => d.always).each(function (d) {
      const shifts = [0, 1.6, -1.6, 3.2, -3.2].map((s) => s * d.fs);
      const dy = shifts.find((s) => !cities.some((c) => over(lbox(d, s), c))) ?? 0;
      d.y = d.y0 + dy;
      this.setAttribute('y', d.y);
      boxes.push(lbox(d));
    });
    d3.select('#g-cities').selectAll('g').attr('display', (c) => {
      if (c.out || hit(c.box)) return 'none';
      boxes.push(c.box);
      return null;
    });
    d3.select('#g-labels').selectAll('text').attr('display', (d) => {
      const { x, y } = d;
      const tw = d.text.length * d.fs * d.cw + 4, th = d.fs + 4;
      const b = [x - tw / 2, y - th / 2, x + tw / 2, y + th / 2];
      if (d.always) return x < 0 || x > w || y < 0 || y > h ? 'none' : null;
      if (b[0] < 2 || b[2] > w - 2 || b[1] < 2 || b[3] > h - 2) return 'none';
      const fb = bOf(d.f);
      if ((fb[1][0] - fb[0][0]) * t.k < tw * 0.9 || (fb[1][1] - fb[0][1]) * t.k < th * 1.3) return 'none';
      if (hit(b)) return 'none';
      boxes.push(b);
      return null;
    });
  }

  /* ---------- подсказки: мышь — по наведению, касание — по тапу ---------- */
  const tip = $('#tip');
  let tipTimer = null, ptype = 'mouse';
  function showTip(ev, html) {
    tip.innerHTML = html; tip.hidden = false;
    const r = $('#mapwrap').getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > r.width - 8) x = Math.max(8, ev.clientX - r.left - tw - 14);
    if (y + th > r.height - 8 - (mobile() ? S.peek : 0)) y = Math.max(8, ev.clientY - r.top - th - 14);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; clearTimeout(tipTimer); d3.selectAll('#world .hl').classed('hl', false); }
  function tipFor(f) {
    const p = f.properties;
    if (p.layer === 'state') return `<b>${esc(p.name)}</b><span class="sub">${area(p.km2)} · эти границы: ${span(p.from, p.to)}</span>`;
    if (p.layer === 'context') return `<b>${esc(ruName(p.name))}</b><span class="sub">в этих границах: ${span(p.from, p.to)}</span><span class="src">${esc(p.name)}</span>`;
    if (p.layer === 'change') return p.kind === 'gain'
      ? `<b>Приобретено в ${p.from} г.</b><span class="sub">около ${area(p.km2)}, по сравнению с ${p.from - 1} г.</span>`
      : `<b>Утрачено в ${p.from} г.</b><span class="sub">около ${area(p.km2)}, по сравнению с ${p.from - 1} г.</span>`;
    if (p.layer === 'overlay') return `<b>${esc(p.name)}</b><span class="sub">${span(p.from, p.to)}</span>`;
    return '';
  }
  function tipAt(ev) {
    const f = d3.select(ev.target).datum();
    if (!f || !f.properties) return hideTip();
    d3.selectAll('#world .hl').classed('hl', false);
    if (f.properties.layer !== 'state') d3.select(ev.target).classed('hl', true);
    showTip(ev, tipFor(f));
  }
  svg.on('pointerdown.tip', (ev) => { ptype = ev.pointerType; })
    .on('pointermove', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      if (ev.buttons) return hideTip();
      if (ev.target.closest('#g-events')) return;
      tipAt(ev);
    })
    .on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hideTip(); })
    .on('click', (ev) => {
      if (ptype === 'mouse') return;
      if (S.sheet) { setOpen(false); return; }
      tipAt(ev);
      tipTimer = setTimeout(hideTip, 4000);
    });

  /* ---------- карточка года и последнее событие ---------- */
  function currentEvent() {
    let cur = null;
    for (const e of EVENTS) { if (e.y <= S.year) cur = e; else break; }
    return cur;
  }
  const SW = (cls) => `<svg width="20" height="13" aria-hidden="true"><rect x="1" y="1" width="18" height="11" rx="2" class="${cls}"/></svg>`;
  function renderNow() {
    const y = S.year;
    $('#yr').textContent = y;
    const st = active(L.state, y)[0];
    const nm = $('#stname'), stats = $('#stats'), note = $('#gapnote');
    note.hidden = true;
    if (st) {
      const p = st.properties;
      nm.textContent = p.name; nm.className = 'statename';
      let h = `<span>${area(p.km2)}</span>`;
      if (st.prevKm2 && y - p.from < 10) {
        const d = p.km2 - st.prevKm2;
        if (Math.abs(d) >= 10000) h += `<span class="${d >= 0 ? 'up' : 'down'}">${delta(d)} в ${p.from} г.</span>`;
      }
      if (y > 2024) h += '<span>граница — по данным на 2024 г.</span>';
      stats.innerHTML = h;
    } else {
      nm.className = 'statename none';
      stats.innerHTML = '';
      if (y < 880) {
        nm.textContent = 'Границ в данных ещё нет';
        note.textContent = 'Полигоны границ начинаются с 880 г. До этого известны только летописные сведения: призвание Рюрика (862), княжение в Новгороде.';
      } else {
        nm.textContent = 'Русские княжества под властью Золотой Орды';
        note.textContent = '1241–1293: в исходных данных нет общей границы русских земель. ' + (active(L.rus, y).length
          ? 'Пунктиром показаны княжества, для которых полигоны есть.'
          : 'Полигонов русских княжеств за этот год в данных тоже нет.');
      }
      note.hidden = false;
    }
    // Условные обозначения — только для того, что сейчас на карте.
    const flags = [];
    for (const kind of ['gain', 'loss']) {
      const ys = [...new Set(recentChanges(y).filter((f) => f.properties.kind === kind).map((f) => f.properties.from))].sort((a, b) => a - b);
      if (ys.length) flags.push(SW('chg-' + kind) + `<span>${kind === 'gain' ? 'Приобретено' : 'Утрачено'} в ${years(ys)}</span>`);
    }
    // Длинные подписи оверлеев: суть видна всегда, пояснение на телефоне — по нажатию на карточку.
    for (const f of active(L.overlay, y)) {
      const n = f.properties.name, m = /^(.+?)(?:: | \()(.+?)\)?$/.exec(n);
      flags.push(SW('ov-' + f.properties.kind) + (m
        ? `<span class="fm has-d">${esc(m[1])}<span class="fd">${n[m[1].length] === ':' ? ': ' : ' ('}${esc(m[2])}${n.endsWith(')') ? ')' : ''}</span></span>`
        : `<span>${esc(n)}</span>`));
    }
    if (active(L.rus, y).length) flags.push(`<svg width="20" height="13" aria-hidden="true"><rect x="1" y="1" width="18" height="11" rx="2" class="rusfill"/><rect x="1" y="1" width="18" height="11" rx="2" class="rusline"/></svg><span>Другие русские княжества</span>`);
    $('#flags').innerHTML = flags.map((f) => `<div class="flag">${f}</div>`).join('');
    renderFeat();
    document.title = `${y} — Атлас границ России`;
  }
  $('#card').addEventListener('click', () => { if (mobile() && $('#card .has-d')) { $('#card').classList.toggle('more'); if (S.follow) followState(); } });
  const WHO = 'другая сторона';
  let featKey = '';
  function renderFeat() {
    const e = currentEvent(), y = S.year;
    if (!e) return;
    const ago = y - e.y, key = e.i + ':' + ago;
    if (key === featKey) return;
    featKey = key;
    const when = ago === 0 ? 'в этом году' : `${ago} ${plural(ago, 'год', 'года', 'лет')} назад`;
    $('#feathead').innerHTML = `<div class="feat-top"><span class="kind k-${e.k}">${KIND[e.k]}</span><span class="when">${when} · ${esc(e.d)}</span></div><h3 class="feat-t">${esc(e.t)}</h3>`;
    const meta = [e.how && `<b>${esc(e.how)}</b>`, e.who && `${WHO}: <b>${esc(e.who)}</b>`].filter(Boolean).join(' · ');
    $('#featbody').innerHTML = (meta ? `<p class="feat-meta">${meta}</p>` : '') + `<p class="feat-x">${esc(e.x)}</p>`;
  }

  /* ---------- летопись ---------- */
  const eraOf = (y) => bands.find((b) => !b.gap && b.from <= y && y <= b.to) || bands.find((b) => b.from <= y && y <= b.to) || bands[0];
  function buildList() {
    let html = '', era = null;
    for (const e of EVENTS) {
      const b = eraOf(e.y);
      if (b !== era) {
        html += `${era ? '</div>' : ''}<div class="era"><h3 class="era-h"><span>${esc(b.name)}</span><span class="era-y">${b.from}–${b.to === YMAX ? 'н. в.' : b.to}</span></h3>`;
        era = b;
      }
      html += `
        <div class="evitem" data-i="${e.i}" role="button" tabindex="0" aria-expanded="false">
          <span class="y">${e.y}</span>
          <span class="t">${esc(e.t)}</span>
          <span class="meta"><span class="kind k-${e.k}">${KIND[e.k]}</span><span>${esc(e.d)}</span>${e.how ? `<span>${esc(e.how)}</span>` : ''}</span>
          <span class="x">${esc(e.x)}${e.who ? `<br><span style="color:var(--muted);font-size:13px">${WHO[0].toUpperCase() + WHO.slice(1)}: ${esc(e.who)}</span>` : ''}</span>
        </div>`;
    }
    $('#evlist').innerHTML = html + '</div>';
    for (const el of document.querySelectorAll('.evitem')) {
      const e = EVENTS.find((x) => x.i === +el.dataset.i);
      el._e = e;
      const act = () => {
        if (S.open.has(e.i) && e.y === S.year) { S.open.delete(e.i); renderList(false); return; }
        openEvent(e, true);
        if (mobile()) setOpen(false);
      };
      el.addEventListener('click', act);
      el.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); act(); } });
    }
  }
  function openEvent(e, jump) {
    S.open.add(e.i);
    if (jump) {
      stop();
      S.focusAt = e.at || null;
      if (e.y === S.year) { renderList(true); followState(); } else setYear(e.y);
    }
  }
  function renderList(scroll) {
    const cur = currentEvent();
    for (const el of document.querySelectorAll('.evitem')) {
      const e = el._e;
      el.classList.toggle('cur', !!(cur && e.y === cur.y));
      el.classList.toggle('future', e.y > S.year);
      const open = S.open.has(e.i);
      el.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
    }
    if (scroll && cur) scrollToCur();
  }
  function scrollToCur() {
    const box = $('#chron'), el = document.querySelector('.evitem.cur');
    if (!el || (mobile() && !S.sheet)) return;
    const top = el.offsetTop, bottom = top + el.offsetHeight, head = 40;
    if (top < box.scrollTop + head + 10 || bottom > box.scrollTop + box.clientHeight - 20) box.scrollTop = top - head - 50;
  }

  /* ---------- нижняя панель на телефоне ---------- */
  const sheet = $('#sheet');
  function measurePeek() {
    if (!mobile()) { S.peek = 0; $('#chron').inert = false; return; }
    if (!S.sheet) {
      const fh = $('#feathead');
      S.peek = Math.ceil(fh.offsetTop + fh.offsetHeight + 12 + (parseFloat(getComputedStyle(sheet).paddingBottom) || 0));
      sheet.style.setProperty('--peek', S.peek + 'px');
    }
    $('#chron').inert = !S.sheet;
  }
  function setOpen(v) {
    S.sheet = v && mobile();
    sheet.classList.toggle('open', S.sheet);
    $('#handle').setAttribute('aria-expanded', String(S.sheet));
    if (S.sheet) hideTip();
    measurePeek();
    if (S.sheet) requestAnimationFrame(scrollToCur);
  }
  // Панель тянется за ручку или за заголовок события; короткое касание — открыть или закрыть.
  let drag = null;
  for (const el of [$('#handle'), $('#feathead')]) {
    el.addEventListener('pointerdown', (e) => {
      if (!mobile()) return;
      const closed = sheet.offsetHeight - S.peek;
      drag = { y0: e.clientY, t0: performance.now(), base: S.sheet ? 0 : closed, closed, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${clamp(drag.base + dy, 0, drag.closed)}px)`;
    });
    const end = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0, v = dy / Math.max(1, performance.now() - drag.t0);
      sheet.style.transition = ''; sheet.style.transform = '';
      if (!drag.moved) setOpen(!S.sheet);
      else setOpen(v < -0.35 || (v <= 0.35 && drag.base + dy < drag.closed / 2));
      drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => { if (e.detail === 0 && mobile()) setOpen(!S.sheet); });
  }
  $('#feathead').addEventListener('keydown', (k) => { if ((k.key === 'Enter' || k.key === ' ') && mobile()) { k.preventDefault(); setOpen(!S.sheet); } });

  /* ---------- шкала: обзор эпох ---------- */
  const SHORT = [
    [/^Русь$/, 'Русь'], [/Киевская/, 'Киевская Русь'], [/раздроблен/, 'Раздробленность'],
    [/Московское/, 'Московское княжество'], [/царство/, 'Царство'], [/империя/, 'Империя'],
    [/республика/, ''], [/Гражданской/, ''], [/СССР/, 'СССР'], [/Федерация/, 'РФ'],
  ];
  const TINY = { 'Киевская Русь': 'Русь', 'Московское княжество': 'Москва', 'Раздробленность': '', 'Империя': 'Имп.' };
  let bands = [];
  function buildBands() {
    for (const f of L.state) {
      const p = f.properties, last = bands[bands.length - 1];
      if (last && last.name === p.name && last.to === p.from - 1) last.to = p.to;
      else bands.push({ name: p.name, from: p.from, to: p.to });
    }
    bands.push({ name: 'Нет общей границы в данных', from: 1241, to: 1293, gap: true });
    bands.sort((a, b) => a.from - b.from);
    bands[0].from = YMIN; // «Русь» с призвания Рюрика, хотя полигоны начинаются с 880 г.
    bands[bands.length - 1].to = YMAX;
    let alt = 0;
    bands.forEach((b) => {
      const s = SHORT.find(([re]) => re.test(b.name));
      b.short = b.gap ? 'Орда' : s ? s[1] : '';
      b.cls = b.gap ? 'gap' : 'b' + (alt++ % 2);
    });
    drawBands();
  }
  let ox = null;
  function drawBands() {
    const el = d3.select('#bands'), w = el.node().clientWidth || 600;
    const x = (ox = d3.scaleLinear([YMIN, YMAX + 1], [0, w]));
    el.selectAll('*').remove();
    const top = 8, bh = 18;
    for (const b of bands) {
      const x0 = x(b.from), x1 = x(b.to + 1);
      el.append('rect').attr('class', 'band ' + b.cls).attr('x', x0).attr('y', top).attr('width', Math.max(1, x1 - x0)).attr('height', bh).attr('rx', 2)
        .append('title').text(`${b.name}: ${span(b.from, b.to)}`);
      let lbl = b.short;
      if (lbl && lbl.length * 6.1 + 8 > x1 - x0) lbl = TINY[lbl] ?? '';
      if (lbl && lbl.length * 6.1 + 8 < x1 - x0) el.append('text').attr('class', 'bandlbl').attr('x', x0 + 4).attr('y', top + 13).text(lbl);
    }
    for (const e of EVENTS) {
      if (e.k === 'event') continue;
      const xx = x(e.y + 0.5);
      el.append('line').attr('class', 'tick k-' + e.k).attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', top - 2);
    }
    el.append('rect').attr('class', 'win').attr('id', 'win').attr('y', top - 3).attr('height', bh + 6).attr('rx', 3);
    el.append('line').attr('class', 'cursor').attr('id', 'cursor').attr('y1', top - 4).attr('y2', top + bh + 4);
    moveCursor();
  }
  function moveCursor() {
    if (!ox) return;
    const xx = ox(S.year + 0.5);
    d3.select('#cursor').attr('x1', xx).attr('x2', xx);
    const half = ($('#dial').clientWidth || 0) / PX / 2;
    const a = ox(clamp(S.year - half, YMIN, YMAX + 1)), b = ox(clamp(S.year + half, YMIN, YMAX + 1));
    d3.select('#win').attr('x', a).attr('width', Math.max(0, b - a));
  }
  // Подсказка года при наведении на обзор.
  const over = $('#over'), bubble = $('#bubble');
  over.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !ox) return;
    const r = over.getBoundingClientRect(), y = clamp(Math.floor(ox.invert(e.clientX - r.left)), YMIN, YMAX);
    const b = eraOf(y);
    bubble.textContent = `${y} · ${b.gap ? 'Орда' : b.short || b.name}`;
    bubble.hidden = false;
    bubble.style.left = clamp(e.clientX - r.left, 40, r.width - 40) + 'px';
  });
  over.addEventListener('pointerleave', () => { bubble.hidden = true; });

  /* ---------- шкала: точное колесо ---------- */
  const dial = $('#dial');
  let dialW = 0;
  function drawDial() {
    const cw = dial.clientWidth;
    if (!cw) return;
    dialW = cw;
    const H = 46, W = (YMAX - YMIN) * PX + cw, x = (y) => cw / 2 + (y - YMIN) * PX;
    const el = d3.select('#dialsvg').attr('width', W).attr('height', H);
    el.selectAll('*').remove();
    for (const b of bands) {
      el.append('rect').attr('class', 'band ' + b.cls).attr('x', x(b.from - 0.5)).attr('y', H - 6).attr('width', (b.to - b.from + 1) * PX).attr('height', 5);
    }
    let minor = '', dec = '', cent = '';
    for (let y = YMIN; y <= YMAX; y++) {
      const xx = x(y).toFixed(1);
      if (y % 100 === 0) cent += `M${xx} 14V32`;
      else if (y % 10 === 0) dec += `M${xx} ${y % 50 === 0 ? 18 : 21}V32`;
      else minor += `M${xx} 27V32`;
    }
    el.append('path').attr('class', 'd-minor').attr('d', minor);
    el.append('path').attr('class', 'd-dec').attr('d', dec);
    el.append('path').attr('class', 'd-cent').attr('d', cent);
    for (let y = 870; y <= YMAX; y += 10) {
      el.append('text').attr('class', 'd-lbl' + (y % 100 === 0 ? ' c' : '')).attr('x', x(y)).attr('y', 10).attr('text-anchor', 'middle').text(y);
    }
    for (const e of EVENTS) {
      el.append('circle').attr('class', 'ev k-' + e.k).attr('cx', x(e.y)).attr('cy', 36.5).attr('r', 2.6).style('r', '2.6px').style('stroke-width', 0).style('pointer-events', 'none');
    }
    syncDial();
  }
  function syncDial() { if (dialW) dial.scrollLeft = (S.year - YMIN) * PX; }
  dial.addEventListener('scroll', () => {
    const y = clamp(YMIN + Math.round(dial.scrollLeft / PX), YMIN, YMAX);
    if (y !== S.year) { stop(); setYear(y, { fromDial: true }); }
  }, { passive: true });
  dial.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    dial.scrollLeft += e.deltaY;
  }, { passive: false });
  // Мышью колесо тянется как лента.
  let dd = null;
  dial.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') return; dd = { x: e.clientX, s: dial.scrollLeft }; dial.setPointerCapture(e.pointerId); });
  dial.addEventListener('pointermove', (e) => { if (dd) dial.scrollLeft = dd.s - (e.clientX - dd.x); });
  dial.addEventListener('pointerup', () => { dd = null; });

  /* ---------- управление ---------- */
  const range = $('#year');
  range.addEventListener('input', () => { stop(); setYear(+range.value, { fromSlider: true }); });
  const prevEvent = () => { stop(); const e = [...EVENTS].reverse().find((e) => e.y < S.year); if (e) openEvent(e, true); };
  const nextEvent = () => { stop(); const e = EVENTS.find((e) => e.y > S.year); if (e) openEvent(e, true); };
  $('#prev').onclick = prevEvent;
  $('#next').onclick = nextEvent;
  $('#play').onclick = () => (S.playing ? stop() : play());
  document.addEventListener('keydown', (k) => {
    if (k.target.closest('input, dialog, .evitem, button, [contenteditable]') || k.metaKey || k.ctrlKey || k.altKey) return;
    const step = { ArrowLeft: -1, ArrowRight: 1 }[k.key];
    if (step) { stop(); setYear(S.year + step * (k.shiftKey ? 10 : 1)); }
    else if (k.key === 'PageUp') prevEvent();
    else if (k.key === 'PageDown') nextEvent();
    else if (k.key === 'Home') { stop(); setYear(YMIN); }
    else if (k.key === 'End') { stop(); setYear(YMAX); }
    else if (k.key === ' ') S.playing ? stop() : play();
    else return;
    k.preventDefault();
  });

  window.addEventListener('hashchange', () => {
    const m = /^#(\d{3,4})$/.exec(location.hash);
    if (m && +m[1] !== S.year) { stop(); setYear(+m[1]); }
  });

  let timer = null;
  const yearsWithChange = new Set(EVENTS.filter((e) => e.k !== 'event').map((e) => e.y));
  function play() {
    if (S.year >= YMAX) setYear(YMIN);
    S.playing = true;
    $('#play').setAttribute('aria-label', 'Пауза');
    $('#playicon').innerHTML = '<path d="M3 2h3v10H3zM8 2h3v10H8z"/>';
    const step = () => {
      if (!S.playing) return;
      if (S.year >= YMAX) return stop();
      setYear(S.year + 1);
      timer = setTimeout(step, yearsWithChange.has(S.year) ? 1100 : 90);
    };
    timer = setTimeout(step, 200);
  }
  function stop() {
    if (!S.playing) return;
    S.playing = false; clearTimeout(timer);
    $('#play').setAttribute('aria-label', 'Воспроизвести');
    $('#playicon').innerHTML = '<path d="M3.5 1.5v11L12.5 7z"/>';
  }

  let followTimer = null;
  function setYear(y, opt = {}) {
    y = clamp(Math.round(y), YMIN, YMAX);
    const changed = y !== S.year;
    S.year = y;
    if (!L) return;
    range.value = y;
    if (!opt.fromDial) syncDial();
    moveCursor();
    drawMap();
    renderNow();
    renderList(true);
    try { history.replaceState(null, '', '#' + y); } catch (_) { /* не во всех рамках */ }
    if (opt.instant) { followState(true); return; }
    clearTimeout(followTimer);
    const drag = opt.fromSlider || opt.fromDial;
    if (S.follow && (changed || drag)) followTimer = setTimeout(() => followState(), drag ? 220 : 60);
  }

  /* ---------- О карте ---------- */
  function buildAbout(corr) {
    const lineage = bands.filter((b) => !b.gap).map((b) => `<tr><td>${b.from === b.to ? b.from : b.from + '–' + (b.to === YMAX ? 'н. в.' : b.to)}</td><td>${esc(b.name)}</td></tr>`).join('');
    const rows = (arr) => arr.map(([a, b, n]) => `<tr><td>${a === b ? a : a + '–' + b}</td><td>${esc(n)}</td></tr>`).join('');
    const lg = (svgInner, text) => `<div class="lg"><svg width="24" height="15" aria-hidden="true">${svgInner}</svg>${text}</div>`;
    const box = (cls) => `<rect x="1" y="1" width="22" height="13" rx="2" class="${cls}"/>`;
    $('#abouttext').innerHTML = `
      <button class="linkbtn close" type="button" id="aboutclose">Закрыть</button>
      <h2>О карте</h2>
      <p>Карта показывает территорию, которой фактически управляло государство с центром в Новгороде и Киеве, затем в Москве, Петербурге и снова в Москве, — по годам, с 880 по 2026 г. Год выбирается на шкале внизу: верхняя полоса — все эпохи сразу, нижняя лента — точный выбор года. Ссылку на конкретный год можно передать: адрес страницы с <code>#1914</code> на конце откроет 1914 г.</p>
      <p>Клавиши: ← → — год (с Shift — десять лет), PageUp и PageDown — соседнее событие, пробел — воспроизведение.</p>

      <h3>Обозначения</h3>
      <div class="lgrid">
        ${lg(box('st'), 'Территория государства')}
        ${lg(box('ctx c0'), 'Соседние государства')}
        ${lg(box('chg-gain'), 'Приобретено за последние 10 лет')}
        ${lg(box('chg-loss'), 'Утрачено за последние 10 лет')}
        ${lg(box('ov-occupied'), 'Занято противником')}
        ${lg(box('ov-autonomy'), 'Автономия под властью царя')}
        ${lg(box('ov-annexed'), 'Аннексия, не признана')}
        ${lg(box('ov-claimed'), 'Объявлена своей, не признана')}
        ${lg(box('rusfill') + box('rusline'), 'Другие русские княжества')}
        ${lg('<circle cx="12" cy="7.5" r="5" class="ev k-gain" style="r:5px"/>', 'Место события; цвет — тип')}
      </div>

      <h3>Чья территория в какие годы</h3>
      <div class="tblwrap"><table>${lineage}</table></div>
      <p>1241–1293: общей границы русских земель в данных нет; княжества, для которых есть полигоны, показаны пунктиром. До 880 г. полигонов нет. После 2024 г. граница повторяет данные 2024 г.</p>

      <h3>Как читать обозначения</h3>
      <ul>
        <li><b>Приобретено / утрачено</b> — разница с предыдущим годом, видна десять лет после изменения.</li>
        <li><b>Занято противником</b> — территория государства под оккупацией: 1812 г. (Наполеон), 1915–1917 гг. (Германия и Австро-Венгрия), 1941–1944 гг. Для войны есть только годовые срезы, относящиеся к разным моментам года; момент указан в подписи, линия приблизительная.</li>
        <li><b>Автономия</b> — Гетманщина (1662–1764): казачье государство под властью царя.</li>
        <li><b>Аннексия, не признана</b> — Крым и Севастополь с 2014 г. (резолюция ГА ООН 68/262). <b>Объявлена своей, не признана</b> — четыре области Украины с 2022 г. (резолюция ES-11/4); Россия контролирует их частично, линии фронта на карте нет.</li>
      </ul>

      <h3>Источники</h3>
      <ul>
        <li>Границы государств: <a href="https://github.com/Seshat-Global-History-Databank/cliopatria" target="_blank" rel="noopener">Cliopatria</a>, Seshat Global History Databank, лицензия CC BY 4.0. Шаг данных — один год.</li>
        <li>Суша, озёра, границы регионов Украины: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>, общественное достояние.</li>
        <li>Хронология составлена по датам мирных договоров, актов и сражений; даты до 1918 г. — по юлианскому календарю, для XVIII–XX вв. в скобках дан григорианский.</li>
      </ul>

      <h3>Что исправлено в исходных данных</h3>
      <p>Исходные полигоны сверены с 89 городами и известными датами их перехода. Где данные расходились с договорами, территория убрана или добавлена:</p>
      <div class="tblwrap"><table><tr><td colspan="2"><b>Убрано</b></td></tr>${rows(corr.remove || [])}<tr><td colspan="2"><b>Добавлено</b></td></tr>${rows(corr.add || [])}</table></div>

      <h3>Ограничения</h3>
      <ul>
        <li>Граница рисуется по годам, а не по дням: изменение внутри года видно с начала года, в котором оно случилось.</li>
        <li>Сибирский фронтир в данных продвигается медленнее, чем строились остроги: Томск, Красноярск, Якутск, Охотск попадают внутрь границы позже даты основания.</li>
        <li>Полигон Нижегородского княжества смещён примерно на градус к западу.</li>
        <li>Киев в данных — в составе России с 1662 г., а не с 1654 г.; Приамурье по Айгунскому договору — с 1860 г., а не с 1858 г.</li>
        <li>РСФСР внутри СССР отдельно не выделена; 1918–1921 гг. показаны одной территорией без деления на красных и белых.</li>
        <li>Оккупация 1941–1944 гг. — приблизительная, максимальное продвижение 1942 г. (Сталинград, Кавказ) не показано; линии фронта 2022–2026 гг. нет.</li>
        <li>Названия соседей — перевод названий Cliopatria; в подсказке приведён оригинал.</li>
      </ul>`;
    $('#aboutclose').onclick = () => $('#about').close();
  }
  $('#aboutbtn').onclick = () => $('#about').showModal();
  $('#aboutbtn2').onclick = () => $('#about').showModal();
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') e.target.close(); });
})();
