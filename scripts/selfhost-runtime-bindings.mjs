import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const names = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "BING_WEBMASTER_API_KEY",
  "BING_WEBMASTER_API_KEY_OLD",
  "BING_WEBMASTER_ENABLED",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
  "ALLOWED_HOST",
  "AUTH_MODE",
  "DATAFORSEO_API_KEY",
  "DO_NOT_TRACK",
  "OPENSEO_TELEMETRY_DISABLED",
  "VITE_SHOW_DEVTOOLS",
];

const values = names.filter((name) => process.env[name] !== undefined);
for (const name of values) {
  // Refuse ambiguous dotenv values instead of starting with altered credentials.
  if (/[\r\n"'\\]/.test(process.env[name])) {
    throw new Error(
      `Runtime binding ${name} needs a supported dotenv representation.`,
    );
  }
}
const body =
  values.map((name) => `${name}="${process.env[name]}"`).join("\n") + "\n";
const root = resolve(process.argv[2] || ".");
for (const subdir of [".", "dist/server"]) {
  const directory = resolve(root, subdir);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.dev.vars.runtime-${process.pid}`);
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, resolve(directory, ".dev.vars"));
}
console.log(
  `Prepared ${values.length} existing runtime bindings for local preview.`,
);
