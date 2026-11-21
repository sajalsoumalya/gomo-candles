/* LivingPhoto — turns each still photo into a cinemagraph with a small WebGL shader.
   Regions of the photo (clothes, sachet, leaves, hand, sheet…) are displaced with layered waves,
   so things sway, flutter and breathe. WebGL1 only (works on every modern browser/OS);
   if WebGL is missing or the context is lost, the original <img> stays visible. */
window.LivingPhoto = (() => {
  const VS = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';

  const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D img;
uniform float t;
uniform vec2 par;
uniform vec4 k;
const float ASP = 1.161;
float box(vec2 uv, vec4 r, float f){
  vec2 a = smoothstep(r.xy - f, r.xy + f, uv);
  vec2 b = 1.0 - smoothstep(r.zw - f, r.zw + f, uv);
  return a.x * a.y * b.x * b.y;
}
float ell(vec2 uv, vec2 c, vec2 r){ return 1.0 - smoothstep(.55, 1.0, length((uv - c) / r)); }
vec2 rotA(vec2 p, vec2 c, float a){
  p -= c; p.x *= ASP;
  float s = sin(a), co = cos(a);
  p = vec2(co * p.x - s * p.y, s * p.x + co * p.y);
  p.x /= ASP; return c + p;
}
float wave(float x){ return sin(x) * .6 + sin(x * 2.3 + 1.7) * .3 + sin(x * 5.1 + .4) * .1; }
vec4 tex(vec2 uv){ return texture2D(img, clamp(uv, .001, .999)); }
vec2 cam(){
  vec2 uv = (v - .5) * .982 + .5;                       // slight overscan so drift never shows an edge
  return uv + vec2(wave(t * .31), wave(t * .27 + 3.)) * .0013 * k.w; // handheld camera breathing (rigid)
}
`;

  // Rule: only soft things move (fabric, the sachet on its string, leaves against a plain wall).
  // Wood, rails, frames and furniture get zero displacement; the camera moves the whole photo
  // as one rigid piece, so straight lines always stay straight.
  const SCENES = {
    // k.x = gust (doors swinging)
    wardrobe: `
void main(){
  vec2 uv = cam() + par;
  float g = 1.0 + k.x * 2.0;
  // fabric only: below the hanger shoulders, fading in so the top of each garment stays pinned
  float cloth = smoothstep(.63, .86, uv.y) * box(uv, vec4(.345, .5, 1.05, 1.05), .015);
  vec2 d = vec2(wave(t * 1.1 + uv.x * 9.0) * .0035 + wave(t * 2.3 + uv.x * 27.0) * .001,
                wave(t * 1.7 + uv.x * 13.0) * .0008) * cloth * g;
  // sachet: rigid swing about the knot on the rail, mask excludes the rail and hangers
  float m = box(uv, vec4(.765, .36, .83, .585), .008);
  float ang = wave(t * 1.6) * .03 * (.6 + k.x * 1.6);
  vec2 uvS = rotA(uv, vec2(.79, .315), ang);
  uv = mix(uv - d, uvS, m);
  vec4 col = tex(uv);
  float sh = ell(uv, vec2(.80, .525), vec2(.018, .022)) * pow(max(0., sin(t * .9)), 30.);
  col.rgb += sh * .3;
  gl_FragColor = col;
}`,
    // k.x = candle light 0..1, k.y = flicker (-.4..+.4)
    candle: `
void main(){
  vec2 uv = cam() + par;
  // heat shimmer only in the air above the flames (wall behind, no wood)
  float heat = ell(uv, vec2(.625, .30), vec2(.05, .08)) * k.x;
  vec2 d = vec2(wave(t * 7.0 + uv.y * 90.0), 0.) * .0012 * heat;
  // leaves of the plant, against the wall only (pot and desk excluded)
  float leaf = box(uv, vec4(.47, .0, .68, .28), .015);
  d += vec2(wave(t * 1.3 + uv.y * 27.0), wave(t * 1.1 + uv.x * 19.0)) * .0016 * leaf;
  vec4 col = tex(uv - d);
  vec2 q = uv - vec2(.625, .47); q.x *= ASP;
  float fall = exp(-dot(q, q) * 9.0);
  col.rgb *= 1.0 + k.x * k.y * .35 * fall;
  col.rgb += vec3(1., .62, .3) * k.x * (.5 + k.y) * fall * .07;
  gl_FragColor = col;
}`,
    // k.x = pump kick 0..1, k.y = how much mist has landed
    mist: `
void main(){
  vec2 uv = cam() + par;
  // bedsheet ripple: sheet only, away from the resting hand and the nightstand
  float sheet = smoothstep(.70, .86, uv.y) * (1.0 - box(uv, vec4(.0, .62, .58, .76), .03));
  vec2 d = vec2(0., (wave(uv.x * 11.0 - t * 1.3) * .0016 + wave(uv.x * 23.0 - t * 2.1) * .0006) * sheet * (1.0 + k.y));
  // pillows breathe softly; box keeps clear of the headboard above
  float pil = box(uv, vec4(.60, .34, .97, .62), .04);
  d += (uv - vec2(.78, .48)) * wave(t * .6) * .004 * pil;
  vec4 col = tex(uv - d);
  vec2 q = uv - vec2(.48, .12); q.x *= ASP;
  col.rgb += vec3(1., .8, .55) * exp(-dot(q, q) * 14.0) * (.04 + .02 * wave(t * 1.7));
  gl_FragColor = col;
}`,
  };

  function shader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[living]', gl.getShaderInfoLog(sh)); return null; }
    return sh;
  }

  function attach(s, maxDpr) {
    const src = SCENES[s.type];
    const img = s.photo;
    if (!src || !img) return null;
    const c = document.createElement('canvas');
    c.className = 'photo live';
    c.setAttribute('aria-hidden', 'true');
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' };
    let gl = null;
    try { gl = c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts); } catch (e) { gl = null; }
    if (!gl) return null;
    const vs = shader(gl, gl.VERTEX_SHADER, VS), fs = shader(gl, gl.FRAGMENT_SHADER, COMMON + src);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = { t: gl.getUniformLocation(prog, 't'), par: gl.getUniformLocation(prog, 'par'), k: gl.getUniformLocation(prog, 'k') };

    const live = { ready: false, canvas: c };
    const fallback = () => { live.ready = false; c.remove(); img.style.visibility = ''; s.photo = img; };

    function upload() {
      if (!img.naturalWidth) return;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); // NPOT-safe on WebGL1
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); } catch (e) { fallback(); return; }
      if (gl.getError() !== gl.NO_ERROR) { fallback(); return; }
      c.style.filter = img.style.filter;
      img.after(c);
      img.style.visibility = 'hidden'; // keeps lazy-loading and layout intact
      s.photo = c;
      live.ready = true;
    }
    c.addEventListener('webglcontextlost', e => { e.preventDefault(); fallback(); });
    if (img.complete && img.naturalWidth) upload();
    else img.addEventListener('load', upload, { once: true });

    live.render = (time, px, py, k) => {
      if (!live.ready) return;
      const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform1f(U.t, time % 900);
      gl.uniform2f(U.par, px, py);
      gl.uniform4f(U.k, k[0] || 0, k[1] || 0, k[2] || 0, window.LIVING_NOCAM ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    return live;
  }

  return { attach };
})();
