import express from "express";
import path from "path";
import session from "express-session";
import passport from "passport";
// @ts-ignore — no type declarations available
import SqliteStore from "better-sqlite3-session-store";
import db from "./db";
import adminRoutes from "./routes/admin";
import uploadRoutes from "./routes/upload";
import authRoutes from "./routes/auth";
import adminUIRoutes from "./routes/adminUI";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

app.set("trust proxy", 1); // trust Traefik
app.use(express.json());

// Session (SQLite-backed — no MemoryStore warning)
const BetterSqlite3Store = SqliteStore(session);
app.use(
  session({
    store: new BetterSqlite3Store({ client: db, expired: { clear: true, intervalMs: 3600000 } }),
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Traefik terminates SSL, app runs HTTP internally
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Static pages
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/auth", authRoutes);
app.use("/admin", adminUIRoutes);
app.use("/api/admin", adminRoutes);
app.use(uploadRoutes);

// Done page
app.get("/done", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "done.html"));
});

// Root — redirect to expired (no direct access)
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "expired.html"));
});

app.listen(port, () => {
  console.log(`Micalis Uploader running on port ${port}`);
});
