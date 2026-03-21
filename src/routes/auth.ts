import { Router } from "express";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";

const router = Router();

const ALLOWED_USER = process.env.ALLOWED_GITHUB_USER || "aaristov";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

passport.serializeUser((user: any, done) => {
  done(null, user);
});

passport.deserializeUser((obj: any, done) => {
  done(null, obj);
});

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: `${APP_URL}/auth/github/callback`,
      },
      (_accessToken: string, _refreshToken: string, profile: any, done: any) => {
        done(null, { username: profile.username, displayName: profile.displayName });
      }
    )
  );
}

router.get("/github", passport.authenticate("github", { scope: ["read:user"] }));

router.get(
  "/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  (req, res) => {
    const user = req.user as any;
    if (user?.username === ALLOWED_USER) {
      req.session.save(() => res.redirect("/admin"));
    } else {
      req.logout(() => {
        res.status(403).send("Access denied. Only authorized users can access admin.");
      });
    }
  }
);

router.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect("/");
    });
  });
});

export default router;
