/**
 * A tripwire for the one hazard `skipLibCheck: true` hides: when `@getpaseo/client` fails to resolve, every Paseo API
 * type degrades to `any` and `tsc` still passes. The directive below must stay an error; if the member ever stops
 * erroring, the SDK types are `any` and the handlers are not really being checked.
 */
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// @ts-expect-error - Must stay an error. See above.
export type SdkTypesResolved = PluginHandlerContext["paseo"]["agents"]["thisMemberDoesNotExist"];
