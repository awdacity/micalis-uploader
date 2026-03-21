import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { createToken, listTokens, invalidateToken, getToken } from "../db";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(500).json({ error: "ADMIN_SECRET not configured" });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use(requireAdmin);

router.post("/tokens", (req: Request, res: Response) => {
  const { label } = req.body;
  if (!label || typeof label !== "string") {
    res.status(400).json({ error: "label is required" });
    return;
  }
  const token = uuidv4();
  const row = createToken(token, label.trim());
  const host = req.get("host") || "localhost:3000";
  const protocol = req.protocol;
  res.status(201).json({
    ...row,
    url: `${protocol}://${host}/u/${row.token}`,
  });
});

router.get("/tokens", (_req: Request, res: Response) => {
  const tokens = listTokens();
  res.json(tokens);
});

router.delete("/tokens/:token", (req: Request, res: Response) => {
  const t = req.params.token as string;
  const row = getToken(t);
  if (!row) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  invalidateToken(t);
  res.json({ ok: true });
});

export default router;
