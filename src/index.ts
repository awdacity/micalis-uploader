import express from "express";
import path from "path";
import adminRoutes from "./routes/admin";
import uploadRoutes from "./routes/upload";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

// Static pages
app.use(express.static(path.join(__dirname, "public")));

// Routes
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
