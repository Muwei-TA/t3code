# Lightning Code Mobile

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `Lightning Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `Lightning Code Preview`
- `production`: store/release build as `Lightning Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Verified thread links

Verified HTTPS links open `/threads/…` in a signed mobile build. Use the same
`LIGHTNING_MOBILE_LINK_HOST` (a hostname without a scheme or path) when building
the mobile app and web app, and deploy the web build to that HTTPS host. Set
`VITE_HOSTED_APP_URL=https://<host>` on the hosted web build so it generates links
to that domain.

- Set `LIGHTNING_IOS_TEAM_ID` to the Apple Team ID you use to sign the iOS app.
  Register the bundle IDs for the variants you sign.
- Set `LIGHTNING_ANDROID_APP_LINK_SHA256_PRODUCTION`,
  `LIGHTNING_ANDROID_APP_LINK_SHA256_PREVIEW`, or
  `LIGHTNING_ANDROID_APP_LINK_SHA256_DEVELOPMENT` to the colon-separated SHA-256
  fingerprints for the variants you distribute. Separate multiple fingerprints
  with commas. For Google Play builds use the Play app signing certificate.

The web build emits the association documents from these settings. The host
must serve `/.well-known/apple-app-site-association` as JSON without a redirect
(the build file ends in `.json`) and `/.well-known/assetlinks.json`. The
bundled server and Vercel configuration map the Apple URL automatically.

`lightning pair` uses the app scheme and works independently of HTTPS
thread-link verification.

## Development

For simulator, emulator, or Android phone development, boot or connect a device, then install the
native client that matches this checkout before starting Metro:

```bash
vp run mobile:install ios [simulator-udid]
# Or: vp run mobile:install android [emulator-or-phone-serial]
vp run dev:client
```

The device argument can be omitted when exactly one device is booted or connected. The helper
compares this checkout's Expo fingerprint and the installed binary with its last install record,
and reuses a matching client. Otherwise it installs the build for that fingerprint from
`~/.cache/t3code/native-clients/artifacts`, then the shared task cache, and builds only when
neither has it. The helper builds locally when CI runners are unavailable, the current commit
lacks your native edits, or `T3_NATIVE_CLIENT_BUILD=local` is set. If a repository enables
the `Mobile Dev Client` workflow with a shared cache, the helper can dispatch it for commits
already pushed to that repository. One iOS simulator build serves every iPhone and iPad
simulator, and one APK per
ABI (x86_64 or arm64-v8a) serves every emulator and phone of that ABI. Build output goes to the
log file it prints (`T3_NATIVE_CLIENT_VERBOSE=1` streams it instead). Builds are shared back when
your task-cache login (`bash infra/task-cache/install.sh`) can write. `T3_NATIVE_CLIENT_CACHE=read`
skips the upload and `off` skips the shared cache. Physical iPhones still use `vp run ios:dev`.

`--session <name>` installs into an agent-device session opened elsewhere, such as a device pool
or a cloud simulator, instead of a local device: `vp run mobile:install android --session pool-1
--metro http://<this-machine>:8081`. It uses only the cached build (x86_64 by default; `--abi`
for ARM) and fails with the next step when no machine has built this fingerprint yet.

For a read-only decision, run `node ../../scripts/mobile-native-client.ts check <ios|android>
[device]`: exit 0 means compatible, 2 means an install is needed, and 1 means an operational error.
An externally installed client is unverified until the helper installs it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/13_mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.lightningcode.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.lightningcode \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Source builds work without an EAS account and start with OTA updates disabled. To use EAS,
create a `lightning-code` project in your Expo account and set `LIGHTNING_MOBILE_EAS_OWNER`
to its owner and `LIGHTNING_MOBILE_EAS_PROJECT_ID` to its project UUID. Builds with a project
check for updates from that project. Set `T3CODE_MOBILE_UPDATES_ENABLED=0` to build without
OTA updates. Before submitting iOS builds, set `ascAppId` in the EAS submit profile to the
App Store Connect app you registered for Lightning Code.

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

To use a custom Clerk instance in preview or production, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. For iOS associated domains, set
`LIGHTNING_MOBILE_CLERK_DOMAIN` to your Clerk relying party hostname.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
