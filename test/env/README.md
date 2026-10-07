Deliberately empty `envDir` for vitest.config.js: Vite would otherwise load the
repo root's gitignored `.env.local` (the real server addresses) into
`import.meta.env` during tests. Never put a `.env*` file here.
