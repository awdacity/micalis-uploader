# Add GitHub OAuth Admin UI

## Goal
Add a web-based admin panel at `/admin` protected by GitHub OAuth login.
Only GitHub user `aaristov` can access it.

## New Dependencies
- `express-session` + `@types/express-session`
- `passport` + `@types/passport`
- `passport-github2` + `@types/passport-github2`

## New Routes

### Auth routes (src/routes/auth.ts)
- `GET /auth/github` — redirect to GitHub OAuth
- `GET /auth/github/callback` — handle callback, set session, redirect to /admin
- `GET /auth/logout` — destroy session, redirect to /

### Admin UI (src/routes/adminUI.ts)
- `GET /admin` — serve admin.html (if session user is `aaristov`, else redirect to /auth/github)
- The existing `src/routes/admin.ts` API stays as-is (Bearer token auth)

## New Files

### src/public/admin.html
Clean admin page. When logged in as aaristov shows:
- Heading "Micalis Admin" + "Logged in as @aaristov" + Logout link
- Form: text input for "Client name" + "Generate link" button
- On submit: POST to /api/admin/tokens (using session-based auth, not Bearer)
  → shows the generated URL in a copy-able box below
- Table listing all existing tokens: label, created_at, status (active/used/expired), URL (for active ones)
- Auto-refresh token list on page load

### src/routes/adminUI.ts
- Middleware: if req.user?.username !== 'aaristov' → redirect /auth/github
- GET /admin → res.sendFile admin.html
- POST /admin/tokens (session-protected) → calls createToken(), returns JSON {url}
- GET /admin/tokens (session-protected) → returns listTokens() as JSON

## Environment Variables to Add
```
GITHUB_CLIENT_ID=<from GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from GitHub OAuth app>
SESSION_SECRET=<random 32 char string>
APP_URL=https://upload.awd.bio
ALLOWED_GITHUB_USER=aaristov
```

## src/index.ts changes
- Add session middleware (before routes)
- Add passport middleware
- Add auth routes
- Add adminUI routes

## Session config
```ts
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}))
```

## Notes
- Keep Bearer token admin API working (src/routes/admin.ts unchanged)
- The /admin/tokens POST should also accept Bearer for backward compat
- Use simple passport-github2 strategy
- GitHub username check: `req.user.username === process.env.ALLOWED_GITHUB_USER`

## When done
Run: openclaw system event --text "Done: GitHub OAuth admin UI built for Micalis uploader" --mode now
