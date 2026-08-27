import express from "express";

// `debug` and `qs` are never declared in package.json. They resolve today only
// because express happens to depend on both, so the imports below break the
// moment express changes its own dependency tree.
import createDebug from "debug";
import qs from "qs";

const log = createDebug("invoice-worker");

export const app = express();

app.get("/invoices", (req, res) => {
  const filters = qs.parse(req.url.split("?")[1] ?? "");
  log("listing invoices with %o", filters);
  res.json({ filters });
});
