// Runs one resident host generation the way the Pi entry does
// (src/residency/pi-entry.ts): the process ends as soon as the host returns,
// so nothing the host left in flight survives its close.
import { runResidentHostFromConfigPath } from "../../src/residency/host.js";

const index = process.argv.indexOf("--config");
const configPath = index >= 0 ? process.argv[index + 1] : undefined;
if (!configPath) throw new Error("Missing --config");
await runResidentHostFromConfigPath(configPath).catch(() => undefined);
process.exit(0);
