/* Firebase web config — fill this in once from Firebase console → Project
   settings → Your apps → SDK setup, then leave this file alone.

   This is NOT a secret. Firebase web configs are meant to be public in
   client-side code — the real security boundary is your Firestore rules
   (read-only for everyone) plus the Cloud Functions (which hold the actual
   CFBD API key server-side, never here). Safe to commit to a public repo.

   Keeping this in its own file (instead of inline in index.html) means
   future updates to index.html never touch or overwrite these values —
   you only ever edit this file when you change Firebase projects. */
const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
