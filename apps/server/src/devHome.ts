import { LIGHTNING_BRAND } from "@t3tools/shared/brand";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const resolveLightningWorktreeHome = Effect.fn("resolveLightningWorktreeHome")(function* (
  cwd: string,
) {
  const home = yield* resolveWorktreeT3Home(cwd);
  const path = yield* Path.Path;
  return home === undefined ? undefined : path.join(home, LIGHTNING_BRAND.slug);
});
