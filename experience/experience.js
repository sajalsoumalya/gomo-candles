/* GoMo Experience — scroll-driven scenes with live particle/flame effects. No dependencies. */
(() => {
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const range = (p, a, b) => clamp((p - a) / (b - a));
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const rand = (a, b) => a + Math.random() * (b - a);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(2, devicePixelRatio || 1);
  const bar = document.getElementById('bar');

  // ---------- canvas helper ----------
  function fitCanvas(c) {
    const r = c.getBoundingClientRect();
    const w = Math.round(r.width * DPR), h = Math.round(r.height * DPR);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w: r.width, h: r.height };
  }

  // ---------- Scene base ----------
  const scenes = [...document.querySelectorAll('.scene')].map(el => {
    const frame = el.querySelector('.frame');
    const s = {
      el, frame, type: el.dataset.scene, p: 0, visible: false,
      photo: el.querySelector('.photo'),
      canvas: el.querySelector('.fx'),
      copies: [...el.querySelectorAll('.copy')],
      particles: [],
    };
    s.ctx = s.canvas.getContext('2d');
    return s;
  });

  function sizeFrames() {
    const vw = innerWidth, vh = innerHeight;
    scenes.forEach(s => {
      const ar = +s.frame.dataset.w / +s.frame.dataset.h;
      let w = vw, h = vw / ar;
      if (h < vh) { h = vh; w = vh * ar; }
      s.frame.style.width = w + 'px';
      s.frame.style.height = h + 'px';
      s.fw = w; s.fh = h;
      // keep the scene's focal point (0..1 across the photo) in view on narrow screens
      const f = +(s.el.dataset.focus || .5);
      const maxShift = (w - vw) / 2;
      const shift = clamp((.5 - f) * w, -maxShift, maxShift);
      s.frame.style.left = `calc(50% + ${shift.toFixed(1)}px)`;
    });
  }

  // ---------- WARDROBE ----------
  const wardrobe = scenes.find(s => s.type === 'wardrobe');
  if (wardrobe) {
    wardrobe.doorL = wardrobe.el.querySelector('.door-l');
    wardrobe.doorR = wardrobe.el.querySelector('.door-r');
    wardrobe.sweep = wardrobe.el.querySelector('.light-sweep');
    wardrobe.glow = wardrobe.el.querySelector('.sachet-glow');
    wardrobe.gap = wardrobe.el.querySelector('.gap-light');
    wardrobe.doorsEl = wardrobe.el.querySelector('.doors');
    wardrobe.sheens = [...wardrobe.el.querySelectorAll('.sheen')];
    wardrobe.lastOpen = 0;
    wardrobe.apply = s => {
      // 1) latch clicks and a sliver of light leaks out, 2) doors swing with a soft overshoot
      const crack = easeOut(range(s.p, 0.04, 0.12)) * .06;
      const swing = ease(range(s.p, 0.12, 0.52));
      const settle = Math.sin(Math.PI * range(s.p, .46, .6)) * .035; // doors drift past and settle back
      const open = clamp(crack + (1 - .06) * swing + settle, 0, 1.04);
      s.open = clamp(open);
      const angL = open * 108, angR = open * 112;
      s.doorL.style.transform = `rotateY(${-angL}deg)`;
      s.doorR.style.transform = `rotateY(${angR}deg)`;
      const shade = (Math.min(open, 1) * .6).toFixed(3);
      s.doorL.style.setProperty('--shade', shade);
      s.doorR.style.setProperty('--shade', shade);
      s.sheens.forEach(el => { el.style.setProperty('--sheen', (Math.sin(Math.PI * clamp(open)) * .8).toFixed(3)); el.style.setProperty('--sx', (30 + open * 50).toFixed(1) + '%'); });
      s.gap.style.setProperty('--gw', (2 + crack * 260).toFixed(1) + 'px');
      s.gap.style.setProperty('--ga', (range(s.p, .03, .08) * .75 * (1 - range(s.p, .14, .3))).toFixed(3));
      s.doorsEl.querySelector('.inner-shade').style.setProperty('--is', (clamp(open) * (1 - range(s.p, .5, .8)) * .9).toFixed(3));
      // camera: slow dolly-in with a hint of parallax tilt
      const push = 1.18 - clamp(open) * .16 + range(s.p, .45, 1) * .09;
      s.frame.style.setProperty('--zoom', push.toFixed(4));
      s.photo.style.filter = `brightness(${(.4 + clamp(open) * .66).toFixed(3)}) saturate(${(.75 + clamp(open) * .3).toFixed(3)})`;
      s.sweep.style.opacity = (Math.sin(Math.PI * range(s.p, .25, .75)) * .9).toFixed(3);
      s.sweep.style.backgroundPosition = `${(100 - range(s.p, .25, .75) * 100).toFixed(1)}% 0`;
      s.glowBase = range(s.p, .42, .6);
    };
    wardrobe.tick = (s, dt, t) => {
      const { w, h } = fitCanvas(s.canvas);
      const ctx = s.ctx;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, w, h);
      s.glow.style.opacity = (s.glowBase * (.65 + .35 * Math.sin(t * 2.2))).toFixed(3);

      // Emit fresh-air wisps from the gap between the doors; burst while doors move
      const dOpen = Math.max(0, s.open - s.lastOpen);
      s.gust = Math.min(1, (s.gust || 0) * Math.pow(.15, dt) + dOpen * 25);
      s.lastOpen = s.open;
      const rate = (s.open > .02 && s.open < .999 ? 40 : 0) + dOpen * 2500 + (s.open > .9 ? 10 : 0);
      s.acc = (s.acc || 0) + rate * dt;
      while (s.acc > 1 && s.particles.length < 420) {
        s.acc--;
        const spread = w * (.05 + s.open * .35);
        const mint = Math.random() < .35;
        s.particles.push({
          x: w / 2 + rand(-spread, spread), y: h * rand(.15, .85),
          vx: rand(-30, 30) + (Math.random() < .5 ? -1 : 1) * rand(10, 60) * s.open,
          vy: rand(-28, -6), r: rand(14, 60), life: 0, max: rand(2.2, 4.2),
          z: rand(.2, 1), spark: Math.random() < .22,
          c: mint ? '200,245,230' : '255,250,240', ph: rand(0, 6.28),
        });
      }
      s.acc = Math.min(s.acc, 5);
      ctx.globalCompositeOperation = 'screen';
      s.particles = s.particles.filter(p => {
        p.life += dt;
        if (p.life > p.max) return false;
        const k = p.life / p.max;
        p.x += (p.vx + Math.sin(t * 1.3 + p.ph) * 18) * dt;
        p.y += p.vy * dt;
        const grow = 1 + k * 2.2 * p.z; // drifts toward viewer
        const a = Math.sin(Math.PI * k) * (p.spark ? .9 : .16) * p.z;
        if (p.spark) {
          const r = 1.2 + p.z * 1.6;
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.6 + .4 * Math.sin(t * 9 + p.ph)), 0, 6.283); ctx.fill();
        } else {
          const R = p.r * grow;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
          g.addColorStop(0, `rgba(${p.c},${a})`);
          g.addColorStop(1, `rgba(${p.c},0)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, R * 1.6, R, Math.sin(p.ph) * .5, 0, 6.283); ctx.fill();
        }
        return true;
      });
      // Dust motes floating in the light beam, with depth-of-field (near = big & soft)
      if (!s.dust) s.dust = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), ph: rand(0, 6.28), sp: rand(.004, .014) }));
      const da = range(s.p, .3, .55);
      if (da > 0) {
        s.dust.forEach(d => {
          d.y -= d.sp * dt * (0.4 + d.z); d.x += Math.sin(t * .4 + d.ph) * .0006;
          if (d.y < -.05) { d.y = 1.05; d.x = Math.random(); }
          const X = d.x * w, Y = d.y * h;
          const beam = Math.max(0, 1 - Math.abs((d.x - .55) - (d.y - .5) * -.35) * 2.6); // diagonal shaft of light
          const a = da * (.15 + beam * .75) * (.5 + .5 * Math.sin(t * 2 + d.ph));
          const R = d.z > .85 ? 3 + d.z * 5 : .6 + d.z * 1.6;
          const g = ctx.createRadialGradient(X, Y, 0, X, Y, R);
          g.addColorStop(0, `rgba(255,240,210,${a * (d.z > .85 ? .35 : 1)})`); g.addColorStop(1, 'rgba(255,240,210,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, R, 0, 6.283); ctx.fill();
        });
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  }

  // ---------- CANDLE ----------
  const candle = scenes.find(s => s.type === 'candle');
  if (candle) {
    candle.masks = [...candle.el.querySelectorAll('.wick-mask')];
    candle.warm = candle.el.querySelector('.warm-glow');
    // wick tops in frame-space (0..1) measured from the 800x689 photo
    candle.wicks = [{ x: .589, y: .487, on: 0 }, { x: .661, y: .501, on: 0 }];
    candle.apply = s => {
      s.ign = [easeOut(range(s.p, .30, .38)), easeOut(range(s.p, .40, .48))];
      const light = Math.max(s.ign[0], s.ign[1] * 1.0) * .55 + range(s.p, .4, .65) * .45;
      s.light = light;
      s.masks.forEach((m, i) => { m.style.opacity = (1 - s.ign[i]).toFixed(3); });
      s.frame.style.setProperty('--zoom', (1.22 - ease(range(s.p, 0, .7)) * .2).toFixed(4));
      // match travel: comes in from the right, reaches wick 1 then wick 2
      s.matchK = range(s.p, .14, .46);
    };
    candle.tick = (s, dt, t) => {
      const { w, h } = fitCanvas(s.canvas);
      const ctx = s.ctx;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Organic flicker: layered noise + rare gutters, drives the whole room's light
      s.gut = Math.max(0, (s.gut || 0) - dt * 3);
      if (Math.random() < dt * .35) s.gut = rand(.4, 1);
      const flick = .9 + .05 * Math.sin(t * 11) + .03 * Math.sin(t * 23.7 + 1) + .02 * Math.sin(t * 41) - s.gut * .08;
      s.flick = flick;
      const mk = s.matchK;
      const matchLight = mk > 0 && mk < 1 ? Math.min(1, mk * 12, (1 - mk) * 6) * .22 : 0;
      const L = s.light * flick + matchLight * flick;
      s.flash = Math.max(0, (s.flash || 0) - dt * 4);
      s.photo.style.filter = `brightness(${(.14 + L * .92 + s.flash * .5).toFixed(3)}) saturate(${(.6 + L * .5).toFixed(3)}) contrast(1.06) sepia(${((1 - L) * .2).toFixed(3)})`;
      s.warm.style.opacity = (Math.min(1, L + matchLight) * .95).toFixed(3);
      s.warm.style.translate = `${(Math.sin(t * 7) * 3).toFixed(1)}px ${(Math.sin(t * 5.3) * 2).toFixed(1)}px`;

      // Strike: spark burst + flash the moment the match head ignites
      if (mk > .005 && !s.struck) {
        s.struck = true; s.flash = 1;
        for (let i = 0; i < 40; i++) s.particles.push({ x: .95 * w, y: .3 * h, vx: rand(-160, 60), vy: rand(-180, 40), life: 0, max: rand(.3, .8), spark: true });
      }
      if (mk <= 0) s.struck = false;
      // Match is done: shake out, leave a lazy curling smoke ribbon
      if (mk >= 1 && !s.blown) {
        s.blown = true;
        for (let i = 0; i < 26; i++) s.particles.push({ x: s.wicks[1].x * w + 20, y: s.wicks[1].y * h - 30, vx: rand(-4, 4), vy: rand(-26, -14), life: -i * .06, max: rand(3, 4.5), smoke: true, curl: rand(14, 28) });
      }
      if (mk < .98) s.blown = false;
      // Fragrance: faint warm wisps rising from the lit candle
      if (s.ign && s.ign[1] >= 1 && Math.random() < dt * 5) {
        const c = s.wicks[Math.random() < .5 ? 0 : 1];
        s.particles.push({ x: c.x * w + rand(-6, 6), y: c.y * h - w * .05, vx: rand(-3, 3), vy: rand(-22, -12), life: 0, max: rand(3, 5), smoke: true, curl: rand(8, 20), warm: true });
      }

      // Match flame (visible while travelling)
      if (mk > 0 && mk < 1) {
        const w1 = s.wicks[0], w2 = s.wicks[1];
        let mx, my;
        if (mk < .5) { const k = ease(mk / .5); mx = 0.95 + (w1.x - .95) * k; my = .30 + (w1.y - .035 - .30) * k; }
        else { const k = ease((mk - .5) / .5); mx = w1.x + (w2.x - w1.x) * k; my = (w1.y - .035) + (w2.y - w1.y) * k; }
        const fade = Math.min(1, mk * 12, (1 - mk) * 6);
        const X = mx * w, Y = my * h;
        // matchstick
        ctx.strokeStyle = `rgba(210,170,110,${fade})`; ctx.lineWidth = w * .004; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(X + w * .006, Y + h * .006); ctx.lineTo(X + w * .09, Y + h * .09); ctx.stroke();
        drawFlame(ctx, X, Y, w * .012 * fade, t * 1.7, 1.1, fade);
        if (Math.random() < dt * 30) s.particles.push({ x: X, y: Y - 4, vx: rand(-8, 8), vy: rand(-40, -20), life: 0, max: rand(1.5, 2.5), smoke: true });
      }

      // Candle flames
      s.wicks.forEach((wk, i) => {
        const k = s.ign[i] || 0;
        if (k <= 0) return;
        const X = wk.x * w, Y = wk.y * h;
        drawFlame(ctx, X, Y, w * .0105 * k, t + i * 3.1, 1, k);
        if (k < 1 && Math.random() < dt * 40) s.particles.push({ x: X, y: Y - 10, vx: rand(-5, 5), vy: rand(-50, -25), life: 0, max: rand(1, 2), smoke: true });
      });

      // Smoke wisps
      s.particles = s.particles.filter(p => {
        p.life += dt;
        if (p.life > p.max) return false;
        if (p.life < 0) return true;
        const k = p.life / p.max;
        if (p.spark) {
          p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.save(); ctx.globalCompositeOperation = 'screen';
          ctx.strokeStyle = `rgba(255,${190 + 60 * (1 - k) | 0},120,${1 - k})`; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * .02, p.y - p.vy * .02); ctx.stroke(); ctx.restore();
          return true;
        }
        const curl = p.curl ? Math.sin(p.life * 1.6 + p.x * .01) * p.curl * k : 0;
        p.x += (p.vx + Math.sin(t * 3 + p.y * .05) * 10 + curl) * dt; p.y += p.vy * dt;
        const R = 3 + k * (p.curl ? 26 : 16);
        const col = p.warm ? '255,225,190' : '200,190,180';
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
        g.addColorStop(0, `rgba(${col},${Math.sin(Math.PI * k) * (p.warm ? .07 : .2)})`); g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 6.283); ctx.fill();
        return true;
      });
    };
  }

  // Realistic flame: halo, outer orange body, bright core, blue base — with noise flicker
  function drawFlame(ctx, x, y, size, t, stretch, alpha) {
    if (size < .3) return;
    const n = Math.sin(t * 9.1) * .5 + Math.sin(t * 15.3 + 1) * .3 + Math.sin(t * 27.1 + 2) * .2;
    const sway = n * size * .25;
    const H = size * (4.4 + n * .35) * stretch, W = size;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // halo
    let g = ctx.createRadialGradient(x, y - H * .45, 0, x, y - H * .45, H * 2.4);
    g.addColorStop(0, `rgba(255,200,120,${.42 * alpha})`); g.addColorStop(.35, `rgba(255,150,60,${.12 * alpha})`); g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - H * .45, H * 2.4, 0, 6.283); ctx.fill();
    const tear = (w, h, dy) => {
      ctx.beginPath();
      ctx.moveTo(x, y + dy);
      ctx.bezierCurveTo(x - w * 1.25, y + dy - h * .18, x - w * .7 + sway * .3, y + dy - h * .72, x + sway, y + dy - h);
      ctx.bezierCurveTo(x + w * .7 + sway * .3, y + dy - h * .72, x + w * 1.25, y + dy - h * .18, x, y + dy);
      ctx.closePath();
    };
    // outer
    g = ctx.createLinearGradient(x, y, x, y - H);
    g.addColorStop(0, `rgba(255,120,30,${.85 * alpha})`); g.addColorStop(.5, `rgba(255,175,70,${.9 * alpha})`); g.addColorStop(1, `rgba(255,230,160,${.4 * alpha})`);
    ctx.fillStyle = g; ctx.shadowColor = 'rgba(255,170,80,.9)'; ctx.shadowBlur = size * 3;
    tear(W, H, 0); ctx.fill();
    ctx.shadowBlur = 0;
    // core
    g = ctx.createLinearGradient(x, y, x, y - H * .7);
    g.addColorStop(0, `rgba(255,250,230,${.95 * alpha})`); g.addColorStop(1, `rgba(255,240,200,${.2 * alpha})`);
    ctx.fillStyle = g; tear(W * .5, H * .66, -H * .05); ctx.fill();
    ctx.restore();
    // blue base
    ctx.save();
    g = ctx.createRadialGradient(x, y - H * .06, 0, x, y - H * .06, W * .8);
    g.addColorStop(0, `rgba(90,130,255,${.6 * alpha})`); g.addColorStop(1, 'rgba(90,130,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y - H * .06, W * .8, W * .5, 0, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  // ---------- MIST ----------
  const mist = scenes.find(s => s.type === 'mist');
  if (mist) {
    mist.haze = mist.el.querySelector('.lavender-haze');
    mist.nozzle = { x: .292, y: .196 };
    mist.pumps = [.14, .27, .40];
    mist.fired = [false, false, false];
    mist.spray = 0;
    mist.apply = s => {
      const blur = (1 - range(s.p, 0, .12)) * 6;
      const night = range(s.p, .62, 1);
      s.photo.style.filter = `blur(${blur.toFixed(2)}px) brightness(${(1 - night * .32).toFixed(3)}) saturate(${(1 - night * .15).toFixed(3)}) hue-rotate(${(-night * 8).toFixed(1)}deg)`;
      s.haze.style.opacity = (range(s.p, .15, .55) * .9).toFixed(3);
      s.frame.style.setProperty('--zoom', (1.04 + range(s.p, 0, 1) * .1).toFixed(4));
      s.pumps.forEach((pp, i) => {
        if (s.p >= pp && !s.fired[i]) { s.fired[i] = true; s.spray = .45; s.kick = 1; s.wet = Math.min(1, (s.wet || 0) + .34); }
        if (s.p < pp - .02) s.fired[i] = false;
      });
    };
    mist.tick = (s, dt, t) => {
      const { w, h } = fitCanvas(s.canvas);
      const ctx = s.ctx;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const NX = s.nozzle.x * w, NY = s.nozzle.y * h;
      if (s.spray > 0) {
        s.spray -= dt;
        const n = Math.round(1400 * dt * (s.spray / .45 + .3));
        for (let i = 0; i < n && s.particles.length < 2600; i++) {
          const a = rand(-.38, .30) + .18; // cone aimed right & slightly down
          const sp = rand(.35, 1.05) * w * .9;
          const roll = Math.random();
          const fog = roll < .06, bokeh = roll > .985;
          s.particles.push({ x: NX, y: NY, vx: Math.cos(a) * sp * (bokeh ? 1.3 : 1), vy: Math.sin(a) * sp, life: 0, max: fog ? rand(2.5, 4) : rand(1.6, 3.2),
            r: fog ? rand(20, 50) : bokeh ? rand(6, 16) : rand(.5, 1.7), fog, bokeh, ph: rand(0, 6.28) });
        }
      }
      // tiny camera kick on each pump, like a handheld shot
      s.kick = Math.max(0, (s.kick || 0) - dt * 3.5);
      const kx = Math.sin(t * 40) * s.kick * 2.5, ky = Math.cos(t * 33) * s.kick * 1.8;
      s.frame.style.translate = `${kx.toFixed(2)}px ${ky.toFixed(2)}px`;
      // the pillow absorbs the mist: a soft lavender bloom where it lands
      if (s.wet) {
        const bx = .74 * w, by = .6 * h, R = w * (.18 + s.wet * .2);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, R);
        const a = s.wet * .16 * range(s.p, .15, .5);
        g.addColorStop(0, `rgba(205,190,255,${a})`); g.addColorStop(.6, `rgba(205,190,255,${a * .35})`); g.addColorStop(1, 'rgba(205,190,255,0)');
        ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(bx - R, by - R, R * 2, R * 2);
      }
      if (s.p < .1) s.wet = 0;
      const lampX = .47 * w, lampY = .22 * h;
      ctx.globalCompositeOperation = 'screen';
      s.particles = s.particles.filter(p => {
        p.life += dt;
        if (p.life > p.max) return false;
        const k = p.life / p.max;
        const drag = Math.pow(p.fog ? .2 : .04, dt); // strong air drag → droplets hang, then drift
        p.vx *= drag; p.vy = p.vy * drag + (p.fog ? 6 : 22) * dt;
        p.x += (p.vx + Math.sin(t * .8 + p.ph) * 6) * dt; p.y += p.vy * dt;
        if (p.fog) {
          const R = p.r * (1 + k * 2.5);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
          g.addColorStop(0, `rgba(235,228,255,${Math.sin(Math.PI * k) * .1})`); g.addColorStop(1, 'rgba(235,228,255,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 6.283); ctx.fill();
        } else if (p.bokeh) {
          // out-of-focus droplet right in front of the lens
          const a = Math.sin(Math.PI * k) * .22;
          const g = ctx.createRadialGradient(p.x, p.y, p.r * .55, p.x, p.y, p.r);
          g.addColorStop(0, `rgba(255,246,232,${a * .5})`); g.addColorStop(.85, `rgba(255,246,232,${a})`); g.addColorStop(1, 'rgba(255,246,232,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
        } else {
          // droplets light up as they pass through the lamp's glow (backlit spray)
          const d = Math.hypot(p.x - lampX, p.y - lampY) / w;
          const lit = 1 + Math.max(0, .5 - d) * 3;
          const a = (1 - k) * Math.min(1, p.life * 8) * .7 * lit;
          ctx.fillStyle = lit > 1.3 ? `rgba(255,236,200,${Math.min(1, a)})` : `rgba(255,252,248,${a})`;
          ctx.fillRect(p.x, p.y, p.r, p.r);
          if (lit > 1.6 && ((p.ph * 100) | 0) % 9 === 0) { ctx.fillStyle = `rgba(255,240,210,${a * .4})`; ctx.fillRect(p.x - 1.5, p.y - 1.5, p.r + 3, p.r + 3); }
        }
        return true;
      });
      // tiny lavender motes settling on the pillow once the mist has landed
      const settle = range(s.p, .45, .9);
      if (settle > 0) {
        for (let i = 0; i < 26; i++) {
          const px = (.6 + .32 * ((i * 0.618) % 1)) * w, py = (.5 + .16 * ((i * 0.377) % 1)) * h + Math.sin(t * .6 + i) * 6;
          const a = settle * (.25 + .25 * Math.sin(t * 1.5 + i * 2));
          ctx.fillStyle = `rgba(215,200,255,${a})`; ctx.beginPath(); ctx.arc(px, py, 1.6, 0, 6.283); ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  }

  // ---------- Scroll + loop ----------
  // Preview hook: /experience/#candle=0.4 freezes a scene at a progress value (for screenshots/QA)
  const pin = /^#(\w+)=([\d.]+)$/.exec(location.hash);
  const clockEl = document.getElementById('clock'), clockWrap = clockEl && clockEl.parentElement;
  const embers = document.getElementById('embers'), ectx = embers.getContext('2d');
  let introVisible = true;

  // split headlines into words for the staggered reveal (keeps <em>/<br>)
  document.querySelectorAll('.copy h2, .intro h1').forEach(h => {
    let i = 0;
    [...h.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const sp = document.createElement('span'); sp.className = 'w'; sp.style.setProperty('--i', i++); sp.textContent = part; frag.append(sp);
        });
        n.replaceWith(frag);
      } else if (n.nodeName === 'EM') { n.classList.add('w'); n.style.setProperty('--i', i++); }
    });
  });

  function setCopies(s) {
    s.copies.forEach(c => c.classList.toggle('on', s.visible && s.p >= +c.dataset.in && s.p < +c.dataset.out));
  }

  function onScroll() {
    const vh = innerHeight;
    if (pin) {
      scenes.forEach(s => {
        const on = s.type === pin[1];
        s.el.style.display = on ? '' : 'none';
        s.visible = on; s.p = s.target = +pin[2];
        if (on) { s.apply(s); setCopies(s); }
      });
      document.querySelectorAll('.intro,.outro').forEach(e => e.style.display = 'none');
      introVisible = false;
      return;
    }
    const doc = document.documentElement;
    const total = scrollY / (doc.scrollHeight - vh);
    bar.style.width = (total * 100).toFixed(2) + '%';
    introVisible = scrollY < vh;
    let inScene = false;
    scenes.forEach(s => {
      const r = s.el.getBoundingClientRect();
      const wasVisible = s.visible;
      s.visible = r.top < vh && r.bottom > 0;
      s.target = clamp(-r.top / (r.height - vh));
      // Entering from above: start at the beginning and play forward (capped), so a fast flick doesn't skip the scene.
      // Jumping in from far away (e.g. reload mid-page) or from below: show the current point straight away.
      // lastY tells us the direction: coming down from above the scene → play from its start.
      if (s.visible && !wasVisible) { s.p = (lastY < s.el.offsetTop && lastY !== null) ? 0 : s.target; s.apply(s); }
      setCopies(s);
      if (s.visible) inScene = true;
      s.el.querySelector('.stage').style.setProperty('--fade', (1 - clamp(Math.min(s.target * 16, (1 - s.target) * 10))).toFixed(3));
    });
    lastY = scrollY;
    // the story spans an evening: 6:30 PM at the wardrobe → 11:00 PM by the pillow
    if (clockEl) {
      const first = scenes[0].el.offsetTop, lastS = scenes[scenes.length - 1].el;
      const k = clamp((scrollY - first) / (lastS.offsetTop + lastS.offsetHeight - vh - first));
      const mins = 18 * 60 + 30 + Math.round(k * 270 / 5) * 5;
      const hh = Math.floor(mins / 60) % 12 || 12, mm = String(mins % 60).padStart(2, '0');
      clockEl.textContent = `${hh}:${mm} PM`;
      clockWrap.classList.toggle('on', inScene);
    }
  }

  // warm embers drifting over the intro
  const emberP = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: rand(.2, 1), ph: rand(0, 6.28) }));
  function drawEmbers(dt, t) {
    const { w, h } = fitCanvas(embers);
    ectx.setTransform(DPR, 0, 0, DPR, 0, 0); ectx.clearRect(0, 0, w, h);
    if (!introVisible) return;
    ectx.globalCompositeOperation = 'screen';
    emberP.forEach(e => {
      e.y -= dt * .02 * e.z; e.x += Math.sin(t * .5 + e.ph) * .0004;
      if (e.y < -.02) { e.y = 1.02; e.x = Math.random(); }
      const X = e.x * w, Y = e.y * h - scrollY * .3 * e.z, R = 1 + e.z * 2.5;
      const a = (.25 + .35 * Math.sin(t * 1.7 + e.ph)) * e.z;
      const g = ectx.createRadialGradient(X, Y, 0, X, Y, R * 4);
      g.addColorStop(0, `rgba(255,200,120,${a})`); g.addColorStop(.25, `rgba(255,160,70,${a * .4})`); g.addColorStop(1, 'rgba(255,140,50,0)');
      ectx.fillStyle = g; ectx.beginPath(); ectx.arc(X, Y, R * 4, 0, 6.283); ectx.fill();
    });
  }

  // ---------- Living photos (WebGL cinemagraphs) + parallax ----------
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  if (!reduced && window.LivingPhoto) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    scenes.forEach(s => { try { s.live = LivingPhoto.attach(s, coarse ? 1.5 : 2); } catch (e) { s.live = null; } });
    addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { par.tx = (e.clientX / innerWidth - .5) * -.012; par.ty = (e.clientY / innerHeight - .5) * -.008; } }, { passive: true });
    addEventListener('deviceorientation', e => { if (e.gamma == null) return; par.tx = clamp(e.gamma / 30, -1, 1) * -.01; par.ty = clamp((e.beta - 45) / 30, -1, 1) * -.007; }, { passive: true });
  }
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    const t = now / 1000;
    par.x += (par.tx - par.x) * (1 - Math.exp(-dt * 3)); par.y += (par.ty - par.y) * (1 - Math.exp(-dt * 3));
    const k = 1 - Math.exp(-dt * 3.2); // inertia: progress glides toward the scroll position (lower = calmer)
    // Speed limit: however fast someone scrolls, a scene plays at most MAX_RATE of its length per second, so each
    // moment (and its words) stays on screen long enough to take in. It catches up smoothly when scrolling slows.
    const MAX_RATE = 0.16;
    scenes.forEach(s => {
      if (!s.visible) { if (s.particles.length) s.particles.length = 0; return; }
      if (!pin && Math.abs(s.target - s.p) > 1e-4) {
        let step = (s.target - s.p) * k;
        const cap = MAX_RATE * dt;
        if (step > cap) step = cap; else if (step < -cap * 2) step = -cap * 2; // rewinding may be a bit quicker
        s.p += step; s.apply(s); setCopies(s);
      }
      s.tick && s.tick(s, dt, t);
      if (s.live) {
        const k = s.type === 'wardrobe' ? [s.gust || 0, 0] : s.type === 'candle' ? [s.light || 0, ((s.flick || .9) - .9) * 4] : [s.kick || 0, s.wet || 0];
        s.live.render(t, par.x, par.y, k);
      }
    });
    drawEmbers(dt, t);
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ calm scrolling
  // A fast mouse-wheel / trackpad flick or a hard swipe would otherwise carry the reader past a whole scene in a second.
  // The page's own scroll is eased and speed-limited (about 0.8 screen-heights per second), so every moment plays out.
  // Keyboard, scrollbar dragging and links keep their native behaviour.
  const calm = (() => {
    if (reduced) return null;
    const MAX_VH_PER_S = 0.8;      // top speed
    const WHEEL = 0.55;            // fraction of each wheel step that is applied
    let target = scrollY, cur = scrollY, active = false, setByUs = -1, lastT = 0;
    const maxY = () => document.documentElement.scrollHeight - innerHeight;
    const clampY = (y) => Math.max(0, Math.min(maxY(), y));
    function run(now) {
      const dt = Math.min(.05, (now - (lastT || now)) / 1000); lastT = now;
      const diff = target - cur;
      if (Math.abs(diff) < .5) { cur = target; active = false; lastT = 0; return; }
      const cap = MAX_VH_PER_S * innerHeight * Math.max(dt, 1 / 120);
      let step = diff * (1 - Math.exp(-dt * 7));
      if (Math.abs(step) > cap) step = Math.sign(step) * cap;
      cur += step;
      setByUs = Math.round(cur);
      scrollTo(0, cur);
      requestAnimationFrame(run);
    }
    function push(dy) {
      if (!active) { cur = scrollY; target = scrollY; }
      // Never let the queued distance run more than ~1.2 screens ahead, so stopping feels responsive.
      target = clampY(Math.max(cur - innerHeight * 1.2, Math.min(cur + innerHeight * 1.2, target + dy)));
      if (!active) { active = true; requestAnimationFrame(run); }
    }
    addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.defaultPrevented) return; // pinch-zoom
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
      e.preventDefault();
      push(e.deltaY * unit * WHEEL);
    }, { passive: false });
    // Touch: follow the finger 1:1 for control, then a gentle, capped glide instead of a long native fling.
    let ty = null, vy = 0, lastMoveT = 0;
    addEventListener('touchstart', (e) => { if (e.touches.length !== 1) return; ty = e.touches[0].clientY; vy = 0; lastMoveT = performance.now(); active = false; target = cur = scrollY; }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (ty == null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY, now = performance.now();
      const dy = ty - y; ty = y;
      vy = dy / Math.max(1, now - lastMoveT); lastMoveT = now;
      e.preventDefault();
      cur = target = clampY(scrollY + dy); setByUs = Math.round(cur); scrollTo(0, cur);
    }, { passive: false });
    addEventListener('touchend', () => { if (ty == null) return; ty = null; push(Math.max(-1, Math.min(1, vy)) * innerHeight * 0.45); }, { passive: true });
    // Native scrolls we didn't make (keyboard, scrollbar, links): stop our glide and follow them.
    addEventListener('scroll', () => { if (Math.abs(scrollY - setByUs) > 2 && ty == null) { active = false; cur = target = scrollY; } }, { passive: true });
    return { push };
  })();

  var lastY = null;
  window.__gomoScenes = scenes; // read-only hook for QA (scene progress)
  sizeFrames();
  addEventListener('resize', () => { sizeFrames(); onScroll(); });
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  scenes.forEach(s => { s.p = s.target || 0; s.apply(s); setCopies(s); });
  if (reduced) {
    scenes.forEach(s => { s.p = s.target = 1; s.apply(s); s.copies.forEach(c => c.classList.add('on')); });
    if (wardrobe) wardrobe.el.querySelector('.doors').style.display = 'none';
  }
  requestAnimationFrame(loop);
})();
