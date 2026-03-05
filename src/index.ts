import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "./middleware";
import routes from "./routes";
import { getDb } from "./database";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);

// CORS
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// Rate limiting
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// Body parsing
app.use(express.json());

// Health check is public
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth on everything else
app.use(authMiddleware);
app.use(routes);

// Initialize DB on startup
getDb();

app.listen(PORT, () => {
  console.log(`Pager API running on port ${PORT}`);
});
