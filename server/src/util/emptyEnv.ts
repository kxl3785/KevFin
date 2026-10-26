// dotenv never overrides a variable that already exists in process.env — and
// docker-compose's `- KEY=${KEY}` creates it as an EMPTY string when the stack
// has no value for it, which would permanently mask whatever the user saved in
// the app (the keys file). For settings that are meant to be editable in-app,
// treat a blank value as "not provided" so the keys file can supply it.
export function dropBlankEnv(keys: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const k of keys) if (env[k] !== undefined && env[k]!.trim() === '') delete env[k];
}
