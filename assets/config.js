// GoMo shop configuration.
window.GOMO_CONFIG = {
  // Cloudflare Worker (no trailing slash). The local test server (:8765/:8766) talks to `wrangler dev` on :8787;
  // any other preview (e.g. VS Code Live Server on :5500) uses the live API so it shows the admin's real prices.
  API_BASE: (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && /^876[56]$/.test(location.port)
    ? 'http://localhost:8787'
    : 'https://gomo-api.soumalya9862.workers.dev',
  // Firebase project "gomocandle" — customer sign-in. This web config is public by design.
  FIREBASE: {
    apiKey: 'AIzaSyBg2MfjlkRt6_NABOy7pQjuQTt8_9JWm54',
    authDomain: 'gomocandle.firebaseapp.com',
    projectId: 'gomocandle',
    appId: '1:637564181345:web:a80236c4eb9da377d84320',
  },
};
