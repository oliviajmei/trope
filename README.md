# Trope — build your life to be cohesive

A static web app (no build step). Open `index.html`, or serve the folder.

## How matching works (no AI service)

- **Colour engine**: palettes and mood (deep/airy, muted/vivid, cool/warm, hazy/crisp) are computed in the browser with plain colour maths.
- **Smart analysis (optional)**: turns on an open image model (CLIP, via Transformers.js) that runs *on the device*. It reads subjects and style, suggests keywords, and ranks gift ideas. The model weights download once from Hugging Face and are cached; no API key and no image ever leaves the device.
- **Gift ideas**: a curated idea bank scored against your palette, keywords and (if on) image embeddings. No language model.

To remove even the one-time download dependency, host the model files yourself and point `ml.load()` at them.

## Cloud sync (optional, free Spark plan)

Sync keeps the same collection on every device, in *your own* Firebase project (Firestore only; no Storage or paid plan needed).

1. Firebase console → create a project → add a Web app → copy its config.
2. Firestore Database → create (production mode).
3. Paste the config into `firebase-config.js` (`window.TROPE_FIREBASE = {…}`).
4. Deploy rules + hosting: `npx firebase-tools deploy` (set the project with `firebase use <id>` first).
5. In the app: footer → **Sync devices** → **Create a code**, then enter that code on your other devices.

**Security model:** the sync code (24 hex characters) is the only credential. The rules allow reading a sync document only by exact id and never allow listing, so codes can't be discovered. Anyone who has your code can see your images, so keep it private. For real accounts, swap in Firebase Auth later.

## Not built yet

- **Pinterest linking.** Pinterest's API needs a server-side app secret for OAuth, which means a small function (Firebase Blaze plan, or a free Cloudflare Worker) plus Pinterest developer approval.
- Reverse image search against the web.
