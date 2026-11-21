import { firebaseConfig, API_BASE, FIREBASE_SDK } from './firebase-config.js';

// Firebase Auth (Email/Password + Google). When Firebase isn't configured yet and the API runs on
// localhost, a local-only "dev token" login is offered (the Worker only honours it on localhost).

export const isConfigured = !/REPLACE_WITH/.test(firebaseConfig.apiKey || 'REPLACE_WITH');
// Local-only shortcut: a dev token accepted by `wrangler dev --var DEV_ADMIN_TOKEN:...` (never by the deployed Worker).
export const devLoginAvailable = /^http:\/\/(localhost|127\.0\.0\.1)/.test(API_BASE);
const DEV_KEY = 'gomo_admin_dev_token';
const devToken = () => (devLoginAvailable ? sessionStorage.getItem(DEV_KEY) : null);
const DEV_USER = { dev: true, email: 'dev@localhost', name: 'Local dev', verified: true };

let fb = null;   // { auth, A }
let listener = null;

function toUser(u) {
  return u ? { uid: u.uid, email: u.email, name: u.displayName || u.email, photo: u.photoURL, verified: u.emailVerified } : null;
}

export async function initAuth(onChange) {
  listener = onChange;
  if (devToken()) { onChange(DEV_USER); return; }
  if (!isConfigured) { onChange(null); return; }
  const [{ initializeApp }, A] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  await A.setPersistence(auth, A.browserLocalPersistence);
  fb = { auth, A };
  A.onAuthStateChanged(auth, (u) => onChange(toUser(u)));
  A.getRedirectResult(auth).catch(() => {});
}

const friendly = (e) => {
  const code = e?.code || '';
  const map = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with this email.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
    'auth/popup-closed-by-user': 'Sign-in window was closed.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/unauthorized-domain': 'This domain is not authorised in Firebase → Authentication → Settings → Authorised domains.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase → Authentication → Sign-in method.',
  };
  return new Error(map[code] || e?.message || 'Sign-in failed.');
};

export async function signInEmail(email, password) {
  try { await fb.A.signInWithEmailAndPassword(fb.auth, email, password); } catch (e) { throw friendly(e); }
}

export async function signInGoogle() {
  const provider = new fb.A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.A.signInWithPopup(fb.auth, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      return fb.A.signInWithRedirect(fb.auth, provider);
    }
    throw friendly(e);
  }
}

export async function resetPassword(email) {
  try { await fb.A.sendPasswordResetEmail(fb.auth, email); } catch (e) { throw friendly(e); }
}

export async function sendVerification() {
  if (fb?.auth.currentUser) await fb.A.sendEmailVerification(fb.auth.currentUser);
}

export async function reloadUser() {
  if (!fb?.auth.currentUser) return null;
  await fb.auth.currentUser.reload();
  await fb.auth.currentUser.getIdToken(true);
  return toUser(fb.auth.currentUser);
}

export async function signOut() {
  if (devToken() || !fb) {
    sessionStorage.removeItem(DEV_KEY);
    listener?.(null);
    return;
  }
  await fb.A.signOut(fb.auth);
}

export function devSignIn(token) {
  sessionStorage.setItem(DEV_KEY, token);
  listener?.(DEV_USER);
}

export async function getToken(force = false) {
  const dev = devToken();
  if (dev) return `dev:${dev}`;
  const u = fb?.auth.currentUser;
  return u ? u.getIdToken(force) : '';
}
