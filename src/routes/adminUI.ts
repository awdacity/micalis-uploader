import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { createToken, listTokens } from "../db";

const router = Router();

const ALLOWED_USER = process.env.ALLOWED_GITHUB_USER || "aaristov";

function requireGitHubUser(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.username !== ALLOWED_USER) {
    res.redirect("/auth/github");
    return;
  }
  next();
}

router.get("/", requireGitHubUser, (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

router.post("/tokens", requireGitHubUser, (req: Request, res: Response) => {
  const { label } = req.body;
  if (!label || typeof label !== "string") {
    res.status(400).json({ error: "label is required" });
    return;
  }
  const token = uuidv4();
  const row = createToken(token, label.trim());
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  res.status(201).json({
    ...row,
    url: `${appUrl}/u/${row.token}`,
  });
});

router.get("/tokens", requireGitHubUser, (_req: Request, res: Response) => {
  const tokens = listTokens();
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const enriched = tokens.map((t) => ({
    ...t,
    url: !t.used_at && !t.invalidated_at ? `${appUrl}/u/${t.token}` : null,
    status: t.used_at ? "used" : t.invalidated_at ? "expired" : "active",
  }));
  res.json(enriched);
});

export default router;
