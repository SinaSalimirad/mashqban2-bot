import { readConfig } from "./shared/config.ts";

readConfig(Bun.env);
console.info("Configuration is valid.");
