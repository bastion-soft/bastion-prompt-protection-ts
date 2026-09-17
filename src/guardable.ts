import type { GuardConfig } from "./config.js";
import type { ProtectOptions, WindowedGuardResult } from "./guard.js";
import type { LicenseStatus } from "./license.js";

/** Shared contract implemented by `Guard`. */
export interface Guardable {
  protect(prompt: string, options?: ProtectOptions): Promise<WindowedGuardResult>;
  readonly sdkVersion: string;
  readonly modelVersion: string | null;
  readonly config: GuardConfig;
  licenseStatus(): LicenseStatus;
}
