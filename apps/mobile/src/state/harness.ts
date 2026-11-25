import { createHarnessEnvironmentAtoms } from "@t3tools/client-runtime/state/harness";

import { connectionAtomRuntime } from "../connection/runtime";

export const harnessEnvironment = createHarnessEnvironmentAtoms(connectionAtomRuntime);
