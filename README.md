# Recipeak

The app is called **Recipeak** (it started as Meals and Mixers). The repository is `Bmajor1997/Recipeak`; GitHub forwards the old `Recipeek` and `Meals-and-Mixers` addresses. The package ID and URL scheme keep the original `mealsandmixers` name so saved recipes and sign-ins keep working.

<p align="center">
  <img src="assets/app-icon.png" alt="Recipeak app icon: a white serif R inside the citrus camera ring, on near-black" width="256">
</p>

**Take a photo of a meal or a cocktail, and get a recipe for it.**

Recipeak is a camera app. Point it at a plate of food or a drink, and it identifies what the dish or cocktail is, then gives you a recipe to make it yourself.

The recipe is for that *kind* of dish or drink, not the exact recipe the restaurant or bar used. A photo of a margarita gets a good classic margarita recipe; a photo of chicken parmesan gets a solid chicken parmesan recipe. When the app isn't sure what it's looking at, it shows its best few guesses and lets you choose.

Status: **phase 1 (foundation) built**. See [docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md).

## Decisions so far

- **Android first**, then iPhone, built the same way as Votic (Expo / React Native) so one codebase serves both.
- **AI service: the same setup as Votic.** Photos go to our own backend server, which calls OpenAI. The OpenAI key lives only on the server, never in the app.
- **Signed in before the first photo**, then **3 free photos**, then the paid plan.
- **Saved** screen for recipes, **diet versions** (vegetarian, vegan, gluten-free and more), and **US measurements**.

## Running it

Both parts need Node 24.

**Backend** (from the repository root):

```sh
npm ci
cp .env.example .env.backend.local   # then open it in your editor and add the OpenAI key
npm run dev                           # http://127.0.0.1:8787
npm test
```

For local testing without Firebase, set `MM_DEV_ALLOW_UNAUTHENTICATED=1` in `.env.backend.local`. Production refuses to start with that setting, or without Firebase, RevenueCat and the usage ledger.

**Mobile app** (from `apps/mobile`):

```sh
npm ci
cp .env.example .env    # backend address and the public Firebase settings
npm start               # or: npm run android, for a development build on a phone or emulator
npm test && npm run typecheck && npm run lint
```

## Accounts, purchases and builds (the same setup as Votic)

- **Sign-in:** email and password, Continue with Google, and Sign in with Apple on iPhone, all through Firebase.
  Google needs the Web client ID in `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and each build's SHA-1 fingerprint on the
  Firebase Android app `com.mealsandmixers.app`: test APKs and Play builds use different keys (see docs/GOOGLE-SIGN-IN.md).
- **Subscriptions:** RevenueCat (`react-native-purchases`). The app shows the store's prices and starts the purchase;
  the server checks RevenueCat itself before giving Premium. Set `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` (goog_…)
  in the app and `REVENUECAT_SECRET_API_KEY` on the server. The RevenueCat offering needs a yearly ($rc_annual) and a
  monthly ($rc_monthly) package attached to the `premium` entitlement.
- **Expo Go can't do Google sign-in or purchases** (they need native code). Use the test APK below for those.
- **Test APK:** GitHub → Actions → "Test APK for the emulator or a phone" → Run workflow, then download the APK from
  the run and drag it onto the emulator. It builds on GitHub's computers, so nothing is built on Windows.
- **Google Play:** Actions → "Google Play App Bundle" builds the signed .aab after the upload-key secrets are added.
- **Build settings** for both come from GitHub Actions *variables* with the same names as `apps/mobile/.env.example`.
- **Server hosting:** see `deploy/backend/README.md`.

## What's in the repository

- `assets/app-icon.png` — the front-facing app image (also used for the app icons).
- `apps/mobile/` — the Expo / React Native app: sign-in, camera, recipe, Saved, and Settings screens. See [Settings behavior and validation](docs/SETTINGS.md).
- `admin/` — the private feedback dashboard, served at `/admin/feedback` (see "Feedback" in `docs/PROJECT-PLAN.md`).
- `server/` — the Node backend: sign-in check, free-photo allowance, usage and cost limits, and the OpenAI recipe calls.
- `docs/PROJECT-PLAN.md` — architecture, build phases and open questions.
- `.github/workflows/app-checks.yml` — tests, type-check, lint and an Android JavaScript bundle, plus backend tests.
- `.github/workflows/native-checks.yml` — selective Android build/launch and iOS simulator build.
- `.github/workflows/security-checks.yml` — code quality and security CI, ported from Votic. Runs on every push and pull request, and weekly.
- `.github/workflows/release-sbom.yml` — attaches a software bill of materials to each published release.
- `.github/dependabot.yml` — weekly updates for npm packages and the pinned GitHub Actions.
- `.github/CODEOWNERS` — review ownership.
- `security/` — scan verifiers, the dependency-exception gate and the vulnerability report.
- `docs/security/SECURITY-BASELINE.md` — the security standards this app targets.
- `.gitleaks.toml`, `.gitleaksignore`, `osv-scanner.toml` — scanner configuration and exception lists.

### Native verification

Every pull request runs the security and app checks. Full Android and iOS verification runs when the changed files
affect the respective native project; shared dependencies, app configuration, assets and shared native plugins run
both. Ordinary app JavaScript, recipe data and documentation changes do not by themselves trigger a native build.
This saves time but cannot guarantee platform behavior for every JavaScript change. The weekly scheduled assurance
run and a manually dispatched Assurance run both verify Android and iOS. If changed files cannot be determined,
both builds run. The Required assurance summary shows which native verification was selected.

To run a specific platform, open **Actions → Native app verification → Run workflow**, select the branch and choose
**android**, **ios**, or **both**. A manual native run does not replace the pull request's assurance result or
automatically block a release. Before releasing, run both platforms on the exact commit to be released and confirm
the results; the Android Play bundle remains a separate manually run workflow.

Run the security tooling tests with:

```sh
node --test code_checks/*.test.js
```
