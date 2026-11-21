// Admin panel configuration — Firebase project "gomocandle" (web app "GoMo").
// The Firebase web config is public by design; access is protected by Firebase Auth + the Worker's ADMIN_EMAILS allow-list.
export const firebaseConfig = {
  apiKey: 'AIzaSyBg2MfjlkRt6_NABOy7pQjuQTt8_9JWm54',
  authDomain: 'gomocandle.firebaseapp.com',
  projectId: 'gomocandle',
  appId: '1:637564181345:web:a80236c4eb9da377d84320',
};

const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Cloudflare Worker URL (no trailing slash). Always the live Worker, also when the admin is opened locally.
export const API_BASE = 'https://gomo-api.soumalya9862.workers.dev';

// Shop URL, used for "View on site" links.
export const SHOP_URL = isLocal ? 'http://localhost:8765' : 'https://gomo.earthenbeauty.in';

export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
