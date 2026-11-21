// GoMo story — a scroll-scrubbed film. Motion (motion.dev, the vanilla build of Framer Motion) tracks scroll;
// every frame of the SVG scene is a pure function of scroll progress p (0 → 1), eased with a soft lerp.
import { animate, scroll, inView, stagger } from 'https://cdn.jsdelivr.net/npm/motion@12/+esm';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// keyframes: [[p, value], ...] → eased interpolation between neighbours
function kf(p, frames) {
  if (p <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [p1, v1] = frames[i];
    if (p <= p1) {
      const [p0, v0] = frames[i - 1];
      const t = ease((p - p0) / (p1 - p0 || 1));
      return typeof v0 === 'string' ? mixHex(v0, v1, t) : v0 + (v1 - v0) * t;
    }
  }
  return frames[frames.length - 1][1];
}
function mixHex(a, b, t) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ timeline
const T = {
  personX: [[0, 190], [.04, 190], [.11, 620], [.28, 620], [.38, 1830], [.58, 1830], [.68, 2990], [1, 2990]],
  focus: [[0, 420], [.04, 420], [.11, 870], [.28, 870], [.38, 1950], [.58, 1950], [.68, 3130], [.86, 3200], [1, 3280]],
  zoom: [[0, 1.08], [.06, 1], [.86, 1], [1, .74]],
  cy: [[0, 450], [.86, 450], [1, 555]],
  arm: [[.11, 0], [.13, -78], [.17, -78], [.2, 0], [.39, 0], [.41, -62], [.45, -62], [.47, 0], [.68, 0], [.705, -88], [.82, -88], [.845, 0]],
  doors: [[.12, 0], [.18, 1]],
  swing: [[.15, 0], [.19, 1], [.3, .25]],
  wispDraw: [[.15, 0], [.25, 1]],
  wispOp: [[.15, 0], [.17, .85], [.3, .85], [.36, 0]],
  flame: [[.42, 0], [.45, 1], [.64, 1], [.67, 0]],
  steam: [[.47, 0], [.5, 1], [.6, 1], [.63, 0]],
  night: [[0, 0], [.3, .08], [.5, .28], [.66, .48], [.85, .6], [1, .78]],
  sky: [[0, '#f2b880'], [.35, '#c77d6e'], [.55, '#4a3a6a'], [.7, '#141a3a']],
  stars: [[.55, 0], [.72, 1]],
  moonY: [[.6, 0], [.85, -205]],
  moonOp: [[.6, 0], [.66, 1]],
  lamp: [[.6, 0], [.66, 1], [.86, 1], [.9, 0]],
  lift: [[.69, 0], [.73, 1], [.82, 1], [.85, 0]],
  tilt: [[.72, 0], [.74, -28], [.81, -28], [.83, 0]],
  spray: [[.74, 0], [.75, 1], [.8, 1], [.81, 0]],
  lav: [[.76, 0], [.8, 1], [.95, .6]],
  awake: [[.84, 1], [.87, 0]],
  asleep: [[.85, 0], [.88, 1]],
  zzz: [[.9, 0], [.93, 1]],
};
const WALK_SPEED = 430 / .07; // fastest walk (px of world per unit p), normalises the leg swing

// ------------------------------------------------------------------ elements
const svg = $('#scene');
const el = id => document.getElementById(id);
const E = {
  walker: el('walker'), legL: el('legL'), legR: el('legR'), arm: el('arm'), doorL: el('doorL'), doorR: el('doorR'),
  sachet: el('sachet'), wisps: $$('.wisp'), flameL: el('flameL'), flameR: el('flameR'), candleGlow: el('candleGlow'),
  steam: el('steam'), night: el('night'), skies: $$('.sky, .sky-cut'), stars: el('stars'), moon: el('moon'),
  lampGlow: el('lampGlow'), bottle: el('bottle'), spray: el('spray'), lav: el('lavender'), blanket: el('blanket'),
  sleeper: el('sleeper'), zzz: el('zzz'), clock: el('clock'), caps: $$('.cap'),
};
const DROPS = 26;
E.spray.innerHTML = Array.from({ length: DROPS }, () => '<circle r="4" fill="#d6c8f5"/>').join('');
const drops = [...E.spray.children];
const capWins = E.caps.map(c => c.dataset.win.split(',').map(Number));

let vbW = 1600, vbH = 900;
function fit() {
  const a = innerWidth / innerHeight;
  vbW = Math.max(700, 900 * a); vbH = vbW / a;
}
addEventListener('resize', fit); fit();

function clockText(p) {
  const mins = Math.round((18.5 * 60 + p * 300) / 5) * 5;
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} PM`;
}

// ------------------------------------------------------------------ one frame
function render(p, t) {
  const x = kf(p, T.personX);
  const speed = Math.abs(kf(p + .002, T.personX) - kf(p - .002, T.personX)) / .004;
  const walk = clamp(speed / WALK_SPEED);
  const stride = Math.sin(x / 20) * 26 * walk;

  // camera
  const z = kf(p, T.zoom), w = vbW * z, h = vbH * z;
  svg.setAttribute('viewBox', `${(kf(p, T.focus) - w / 2).toFixed(1)} ${(kf(p, T.cy) - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);

  // person
  E.walker.setAttribute('transform', `translate(${x.toFixed(1)} ${(-Math.abs(Math.sin(x / 20)) * 7 * walk).toFixed(1)})`);
  E.walker.style.opacity = kf(p, T.awake);
  E.legL.setAttribute('transform', `rotate(${stride.toFixed(2)} -12 615)`);
  E.legR.setAttribute('transform', `rotate(${(-stride).toFixed(2)} 12 615)`);
  E.arm.setAttribute('transform', `rotate(${(kf(p, T.arm) + stride * -.6).toFixed(2)} 0 485)`);

  // scene 1 · wardrobe opens, the sachet sways, fragrance drifts out
  const d = 1 - kf(p, T.doors) * .88;
  E.doorL.setAttribute('transform', `translate(740 0) scale(${d} 1) translate(-740 0)`);
  E.doorR.setAttribute('transform', `translate(1120 0) scale(${d} 1) translate(-1120 0)`);
  E.sachet.setAttribute('transform', `rotate(${(Math.sin(t * 2.2) * 9 * kf(p, T.swing)).toFixed(2)} 960 300)`);
  const wd = kf(p, T.wispDraw), wo = kf(p, T.wispOp);
  E.wisps.forEach((w, i) => { w.style.strokeDashoffset = 1 - clamp(wd * 1.2 - i * .1); w.style.opacity = wo; });

  // scene 2 · candle lights, the room warms, dinner steams
  const f = kf(p, T.flame), flick = reduce ? 1 : 1 + Math.sin(t * 13) * .05 + Math.sin(t * 7.3) * .04;
  [E.flameL, E.flameR].forEach((fl, i) => {
    const s = f * (i ? flick : 2 - flick), bx = i ? 2020 : 1980;
    fl.setAttribute('transform', `translate(${bx} 551) scale(${s.toFixed(3)}) translate(${-bx} -551)`);
  });
  E.candleGlow.style.opacity = (f * .95 * flick).toFixed(3);
  E.steam.style.opacity = kf(p, T.steam);

  // time of day
  E.night.style.opacity = kf(p, T.night);
  const sky = kf(p, T.sky);
  E.skies.forEach(s => s.setAttribute('fill', sky));
  E.stars.style.opacity = kf(p, T.stars) * (reduce ? 1 : .8 + Math.sin(t * 3) * .2);
  E.moon.setAttribute('transform', `translate(0 ${kf(p, T.moonY).toFixed(1)})`);
  E.moon.style.opacity = kf(p, T.moonOp);
  E.lampGlow.style.opacity = kf(p, T.lamp);

  // scene 3 · bottle lifts from the nightstand, mist falls on the pillow
  const lift = kf(p, T.lift), tilt = kf(p, T.tilt);
  const bx = 2840 + (3150 - 2840) * lift, by = 600 + (470 - 600) * lift - Math.sin(lift * Math.PI) * 60;
  E.bottle.setAttribute('transform', `translate(${bx.toFixed(1)} ${by.toFixed(1)}) rotate(${tilt.toFixed(2)})`);
  const r = tilt * Math.PI / 180, nx = bx + 2 * Math.cos(r) + 109 * Math.sin(r), ny = by + 2 * Math.sin(r) - 109 * Math.cos(r);
  const sp = kf(p, T.spray);
  drops.forEach((c, i) => {
    const ph = (t * .9 + i / DROPS) % 1, tx = 3165 + (i % 9) * 18, ty = 548 + (i % 3) * 4;
    c.setAttribute('cx', (nx + (tx - nx) * ph).toFixed(1));
    c.setAttribute('cy', (ny + (ty - ny) * ph - Math.sin(ph * Math.PI) * 40).toFixed(1));
    c.setAttribute('r', (2 + ph * 5).toFixed(2));
    c.style.opacity = (sp * (1 - ph) * .85).toFixed(3);
  });
  E.lav.style.opacity = kf(p, T.lav);

  // scene 4 · asleep
  const a = kf(p, T.asleep);
  E.sleeper.style.opacity = a; E.blanket.style.opacity = 1 - a;
  E.zzz.style.opacity = kf(p, T.zzz);

  // captions + clock
  E.caps.forEach((c, i) => {
    const [a0, a1, b0, b1] = capWins[i];
    const o = p < a1 ? clamp((p - a0) / (a1 - a0 || 1)) : clamp(1 - (p - b0) / (b1 - b0));
    c.style.opacity = i === 0 && p <= 0 ? 1 : o.toFixed(3);
    c.style.transform = `translateY(${((1 - o) * 30).toFixed(1)}px)`;
  });
  E.clock.textContent = clockText(p);
}

// ------------------------------------------------------------------ drive it
let target = 0, cur = 0;
scroll(v => { target = v; }, { target: $('#film'), offset: ['start start', 'end end'] });
scroll(animate('.progress-bar', { scaleX: [0, 1] }, { ease: 'linear' }));

(function loop(now) {
  cur = reduce ? target : cur + (target - cur) * .09;
  render(clamp(cur), now / 1000);
  requestAnimationFrame(loop);
})(performance.now());

// intro + outro
if (!reduce) {
  document.documentElement.classList.add('motion-on');
  animate('.cap-intro > *', { opacity: [0, 1], y: [40, 0] }, { type: 'spring', stiffness: 80, damping: 16, delay: stagger(.15, { startDelay: .2 }) });
  inView('.trio', () => {
    animate('.prod', { opacity: [0, 1], y: [60, 0], scale: [.94, 1] }, { type: 'spring', stiffness: 90, damping: 16, delay: stagger(.12) });
  }, { amount: .25 });
  inView('.cta', c => { animate(c, { opacity: [0, 1], y: [30, 0] }, { duration: .8 }); }, { amount: .5 });
}
