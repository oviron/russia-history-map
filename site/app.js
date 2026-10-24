'use strict';
(function () {
  const YMIN = 862, YMAX = 2026, VW = 1000, VH = 700;
  const EVENTS = (window.EVENTS || []).map((e, i) => ({ ...e, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const NAMES = window.NAMES || {};
  const KIND = { gain: 'приобретение', loss: 'потеря', occ: 'оккупация', annex: 'аннексия', event: 'событие' };
  const nf = new Intl.NumberFormat('ru-RU');

  // Ориентиры на карте; названия меняются вместе с эпохой.
  const CITIES = [
    { at: [31.27, 58.52], names: [[YMIN, 'Новгород']] },
    { at: [30.52, 50.45], names: [[YMIN, 'Киев']] },
    { at: [37.62, 55.75], names: [[1147, 'Москва']] },
    { at: [30.31, 59.94], names: [[1703, 'Санкт-Петербург'], [1914, 'Петроград'], [1924, 'Ленинград'], [1991, 'Санкт-Петербург']] },
    { at: [68.25, 58.2], names: [[1587, 'Тобольск']] },
    { at: [129.73, 62.03], names: [[1632, 'Якутск']] },
    { at: [131.9, 43.12], names: [[1860, 'Владивосток']] },
    { at: [28.98, 41.01], names: [[YMIN, 'Константинополь'], [1930, 'Стамбул']] },
    { at: [21.01, 52.23], names: [[1300, 'Варшава']] },
  ];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const area = (k) => k >= 1e6
    ? (k / 1e6).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' млн км²'
    : nf.format(Math.round(k / 1000)) + ' тыс. км²';
  const delta = (d) => (d >= 0 ? '+' : '−') + area(Math.abs(d));
  const span = (a, b) => (a === b ? `${a} г.` : `${a}–${b} гг.`);
  const ruName = (n) => NAMES[n] || n;
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

  const S = { year: 1914, follow: true, playing: false, t: d3.zoomIdentity, open: new Set() };
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
    setYear(S.year, { instant: true });
    window.addEventListener('resize', () => { drawBands(); if (S.follow) followState(true); else placeScreen(); });
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
  svg.call(zoom);
  $('#zin').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
  $('#zout').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
  $('#follow').onclick = () => { setFollow(!S.follow); if (S.follow) followState(); };
  function setFollow(v) { S.follow = v; $('#follow').setAttribute('aria-pressed', String(v)); }

  function size() { const n = svg.node(); return [n.clientWidth || 800, n.clientHeight || 500]; }

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
    const [w, h] = size();
    const [[x0, y0], [x1, y1]] = b;
    const k = Math.min(60, 0.86 / Math.max((x1 - x0) / w, (y1 - y0) / h));
    return d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }
  function followState(instant) {
    const t = fitT(targetBounds());
    S.focusAt = null;
    const [w, h] = size();
    const c = S.t, dk = Math.abs(Math.log(t.k / c.k));
    const dx = Math.abs(c.invertX(w / 2) - t.invertX(w / 2)) * c.k, dy = Math.abs(c.invertY(h / 2) - t.invertY(h / 2)) * c.k;
    if (instant) { svg.interrupt().call(zoom.transform, t); return; }
    if (dk < 0.22 && dx < w * 0.18 && dy < h * 0.18) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.interrupt().transition().duration(reduce ? 0 : 750).ease(d3.easeCubicInOut).call(zoom.transform, t);
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
    join(d3.select('#g-state'), active(L.state, y), () => 'st');
    // Прирост и утрату показываем десять лет после изменения: дальше это уже не новость.
    join(d3.select('#g-change'), active(L.change, y).filter((f) => y - f.properties.from < 10), (f) => 'chg-' + f.properties.kind);
    join(d3.select('#g-over'), active(L.overlay, y), (f) => 'ov-' + f.properties.kind);
    drawScreen();
  }

  /* ---------- подписи, города, маркеры (в экранных координатах) ---------- */
  let labelData = [], cityData = [], evData = [];
  function drawScreen() {
    const y = S.year;
    labelData = [];
    for (const f of active(L.state, y)) labelData.push({ f, text: f.properties.name, cls: 'lbl lbl-state', pri: 3, fs: 13, ls: 0.16, always: true });
    for (const f of active(L.rus, y)) labelData.push({ f, text: ruName(f.properties.name), cls: 'lbl lbl-rus', pri: 2, fs: 11, ls: 0 });
    for (const f of active(L.context, y)) labelData.push({ f, text: ruName(f.properties.name), cls: 'lbl lbl-ctx', pri: 1, fs: 11, ls: 0.04 });
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
      g.append('circle').attr('class', 'city').attr('r', 2.4);
      g.append('text').attr('class', 'lbl lbl-city').attr('x', 5).attr('dy', '0.35em');
      return g;
    });
    cg.select('text').text((d) => d.name);

    const cur = currentEvent();
    evData = EVENTS.filter((e) => e.at && e.y <= y && y - e.y < 10);
    d3.select('#g-events').selectAll('circle.ev').data(evData, (e) => e.i)
      .join((en) => en.append('circle').on('click', (ev, e) => { ev.stopPropagation(); openEvent(e, true); })
        .on('pointerenter', (ev, e) => showTip(ev, `<b>${esc(e.t)}</b><span class="sub">${esc(e.d)}</span>`))
        .on('pointerleave', hideTip))
      .attr('class', (e) => `ev k-${e.k}` + (cur && e.y === cur.y ? ' cur' : ''))
      .attr('r', (e) => (cur && e.y === cur.y ? 6.5 : 4.5))
      .attr('opacity', (e) => 1 - (y - e.y) * 0.07);
    placeScreen();
    layoutLabels();
  }
  function placeScreen() {
    const t = S.t;
    d3.select('#g-labels').selectAll('text').attr('x', (d) => t.applyX(d.p[0])).attr('y', (d) => t.applyY(d.p[1]));
    d3.select('#g-cities').selectAll('g').attr('transform', (d) => `translate(${t.applyX(d.p[0])},${t.applyY(d.p[1])})`);
    d3.select('#g-events').selectAll('circle.ev').attr('cx', (e) => t.apply(projection(e.at))[0]).attr('cy', (e) => t.apply(projection(e.at))[1]);
  }
  // Жадная раскладка: крупные подписи первыми, перекрытия прячем.
  function layoutLabels() {
    const t = S.t, [w, h] = size(), boxes = [];
    const hit = (b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    for (const c of cityData) {
      const x = t.applyX(c.p[0]), y = t.applyY(c.p[1]);
      boxes.push([x - 3, y - 7, x + 6 + c.name.length * 6, y + 7]);
    }
    d3.select('#g-labels').selectAll('text').attr('display', (d) => {
      const x = t.applyX(d.p[0]), y = t.applyY(d.p[1]);
      const tw = d.text.length * d.fs * (0.56 + d.ls) + 4, th = d.fs + 4;
      const b = [x - tw / 2, y - th / 2, x + tw / 2, y + th / 2];
      if (x < 0 || x > w || y < 0 || y > h) return 'none';
      if (!d.always) {
        const fb = bOf(d.f);
        if ((fb[1][0] - fb[0][0]) * t.k < tw * 0.9 || (fb[1][1] - fb[0][1]) * t.k < th * 1.3) return 'none';
        if (hit(b)) return 'none';
      }
      boxes.push(b);
      return null;
    });
  }

  /* ---------- подсказки ---------- */
  const tip = $('#tip');
  function showTip(ev, html) {
    tip.innerHTML = html; tip.hidden = false;
    const r = $('.mapwrap').getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > r.width - 8) x = Math.max(8, ev.clientX - r.left - tw - 14);
    if (y + th > r.height - 8) y = Math.max(8, ev.clientY - r.top - th - 14);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; d3.selectAll('#world .hl').classed('hl', false); }
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
  svg.on('pointermove', (ev) => {
    if (ev.buttons) return hideTip();
    const f = d3.select(ev.target).datum();
    if (!f || !f.properties || ev.target.closest('#g-events')) { if (!ev.target.closest('#g-events')) hideTip(); return; }
    d3.selectAll('#world .hl').classed('hl', false);
    if (f.properties.layer !== 'state') d3.select(ev.target).classed('hl', true);
    showTip(ev, tipFor(f));
  }).on('pointerleave', hideTip);

  /* ---------- панель ---------- */
  function currentEvent() {
    let cur = null;
    for (const e of EVENTS) { if (e.y <= S.year) cur = e; else break; }
    return cur;
  }
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
        note.textContent = '1241–1293: в исходных данных нет общей границы русских земель. Пунктиром показаны княжества, для которых полигоны есть.';
      }
      note.hidden = false;
    }
    const ov = active(L.overlay, y);
    const sw = { occupied: 'ov-occupied', autonomy: 'ov-autonomy', annexed: 'ov-annexed', claimed: 'ov-claimed' };
    $('#flags').innerHTML = ov.map((f) => `<div class="flag"><svg width="18" height="12"><rect x="1" y="1" width="16" height="10" class="${sw[f.properties.kind]}"/></svg><span>${esc(f.properties.name)}</span></div>`).join('');
    document.title = `${y} — Атлас границ России`;
  }

  const WHO = 'Другая сторона';
  function buildList() {
    $('#evlist').innerHTML = EVENTS.map((e) => `
      <div class="evitem" data-i="${e.i}" role="button" tabindex="0" aria-expanded="false">
        <span class="y">${e.y}</span>
        <span class="t">${esc(e.t)}</span>
        <span class="meta"><span class="kind k-${e.k}">${KIND[e.k]}</span><span>${esc(e.d)}</span>${e.how ? `<span>${esc(e.how)}</span>` : ''}</span>
        <span class="x">${esc(e.x)}${e.who ? `<br><span style="color:var(--muted);font-size:13px">${WHO}: ${esc(e.who)}</span>` : ''}</span>
      </div>`).join('');
    const items = [...document.querySelectorAll('.evitem')];
    items.forEach((el) => {
      const e = EVENTS.find((x) => x.i === +el.dataset.i);
      el._e = e;
      const act = () => openEvent(e, true);
      el.addEventListener('click', act);
      el.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); act(); } });
    });
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
      const isCur = cur && e.y === cur.y;
      el.classList.toggle('cur', !!isCur);
      el.classList.toggle('past', e.y <= S.year);
      el.classList.toggle('future', e.y > S.year);
      const open = isCur || S.open.has(e.i);
      el.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
    }
    if (scroll && cur) {
      const box = $('#chron'), el = document.querySelector(`.evitem.cur`);
      if (el && getComputedStyle(box).overflowY === 'auto') {
        const top = el.offsetTop - box.offsetTop, bottom = top + el.offsetHeight;
        if (top < box.scrollTop + 30 || bottom > box.scrollTop + box.clientHeight - 30) box.scrollTop = top - 60;
      }
    }
  }

  /* ---------- шкала времени ---------- */
  const SHORT = [
    [/^Русь$/, 'Русь'], [/Киевская/, 'Киевская Русь'], [/раздроблен/, 'Раздробленность'],
    [/Московское/, 'Московское княжество'], [/царство/, 'Царство'], [/империя/, 'Империя'],
    [/республика/, ''], [/Гражданской/, ''], [/СССР/, 'СССР'], [/Федерация/, 'РФ'],
  ];
  let bands = [];
  function buildBands() {
    for (const f of L.state) {
      const p = f.properties, last = bands[bands.length - 1];
      if (last && last.name === p.name && last.to === p.from - 1) last.to = p.to;
      else bands.push({ name: p.name, from: p.from, to: p.to });
    }
    bands.push({ name: 'Нет общей границы в данных', from: 1241, to: 1293, gap: true });
    bands.sort((a, b) => a.from - b.from);
    bands[bands.length - 1].to = YMAX;
    bands.forEach((b) => { const s = SHORT.find(([re]) => re.test(b.name)); b.short = b.gap ? 'Орда' : s ? s[1] : ''; });
    drawBands();
  }
  function drawBands() {
    const el = d3.select('#bands'), w = el.node().clientWidth || 600;
    const x = d3.scaleLinear([YMIN, YMAX + 1], [0, w]);
    el.selectAll('*').remove();
    const top = 14, bh = 24;
    let alt = 0;
    for (const b of bands) {
      const x0 = x(b.from), x1 = x(b.to + 1);
      el.append('rect').attr('class', 'band ' + (b.gap ? 'gap' : 'b' + (alt++ % 2))).attr('x', x0).attr('y', top).attr('width', Math.max(1, x1 - x0)).attr('height', bh)
        .append('title').text(`${b.name}: ${span(b.from, b.to)}`);
      if (b.short && b.short.length * 6.2 + 8 < x1 - x0) el.append('text').attr('class', 'bandlbl').attr('x', x0 + 4).attr('y', top + 16).text(b.short);
    }
    for (const e of EVENTS) {
      if (e.k === 'event') continue;
      const xx = x(e.y + 0.5);
      el.append('line').attr('class', 'tick k-' + e.k).attr('x1', xx).attr('x2', xx).attr('y1', 3).attr('y2', top - 2);
    }
    for (let c = 900; c <= 2000; c += 100) {
      const xx = x(c);
      el.append('line').attr('class', 'centline').attr('x1', xx).attr('x2', xx).attr('y1', top + bh).attr('y2', top + bh + 4);
      if (w > 520 || c % 200 === 0) el.append('text').attr('class', 'cent').attr('x', xx).attr('y', top + bh + 14).attr('text-anchor', 'middle').text(c);
    }
    el.append('line').attr('class', 'cursor').attr('id', 'cursor').attr('y1', 0).attr('y2', top + bh + 4);
    el.node()._x = x;
    moveCursor();
  }
  function moveCursor() {
    const el = $('#bands');
    if (!el._x) return;
    const xx = el._x(S.year + 0.5);
    d3.select('#cursor').attr('x1', xx).attr('x2', xx);
  }

  const range = $('#year');
  range.addEventListener('input', () => { stop(); setYear(+range.value, { fromSlider: true }); });
  $('#prev').onclick = () => { stop(); const e = [...EVENTS].reverse().find((e) => e.y < S.year); if (e) openEvent(e, true); };
  $('#next').onclick = () => { stop(); const e = EVENTS.find((e) => e.y > S.year); if (e) openEvent(e, true); };
  $('#play').onclick = () => (S.playing ? stop() : play());
  document.addEventListener('keydown', (k) => {
    if (k.target.closest('input, dialog, .evitem, button')) return;
    if (k.key === 'ArrowLeft' || k.key === 'ArrowRight') { stop(); setYear(S.year + (k.key === 'ArrowLeft' ? -1 : 1)); k.preventDefault(); }
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
    S.playing = false; clearTimeout(timer);
    $('#play').setAttribute('aria-label', 'Воспроизвести');
    $('#playicon').innerHTML = '<path d="M3 1.5v11L12.5 7z"/>';
  }

  let followTimer = null;
  function setYear(y, opt = {}) {
    y = Math.max(YMIN, Math.min(YMAX, Math.round(y)));
    const changed = y !== S.year;
    S.year = y;
    if (!L) return;
    range.value = y;
    moveCursor();
    drawMap();
    renderNow();
    renderList(true);
    try { history.replaceState(null, '', '#' + y); } catch (_) { /* не во всех рамках */ }
    if (opt.instant) { followState(true); return; }
    clearTimeout(followTimer);
    if (S.follow && (changed || opt.fromSlider)) followTimer = setTimeout(() => followState(), opt.fromSlider ? 220 : 60);
  }

  /* ---------- О карте ---------- */
  function buildAbout(corr) {
    const lineage = bands.filter((b) => !b.gap).map((b) => `<tr><td>${b.from === b.to ? b.from : b.from + '–' + (b.to === YMAX ? 'н. в.' : b.to)}</td><td>${esc(b.name)}</td></tr>`).join('');
    const rows = (arr) => arr.map(([a, b, n]) => `<tr><td>${a === b ? a : a + '–' + b}</td><td>${esc(n)}</td></tr>`).join('');
    $('#abouttext').innerHTML = `
      <button class="linkbtn close" type="button" id="aboutclose">Закрыть</button>
      <h2>О карте</h2>
      <p>Карта показывает территорию, которой фактически управляло государство с центром в Новгороде и Киеве, затем в Москве, Петербурге и снова в Москве, — по годам, с 880 по 2026 г. Ползунок двигает год; панель показывает площадь, изменения и события. Ссылку на конкретный год можно передать: адрес страницы с <code>#1914</code> на конце откроет 1914 г.</p>

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
  $('#about').addEventListener('click', (e) => { if (e.target.id === 'about') e.target.close(); });
})();
