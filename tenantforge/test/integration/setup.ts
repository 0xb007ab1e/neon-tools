// Load a local .env (git-ignored) for integration runs, if present. Uses Node's built-in
// env-file loader (no dependency). Falls back to the ambient environment when absent.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file — rely on whatever is already in the environment (CI secrets, exported vars).
}
