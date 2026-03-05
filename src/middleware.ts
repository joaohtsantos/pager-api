import { Request, Response, NextFunction } from "express";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.PAGER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "PAGER_API_KEY not configured" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== apiKey) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}
