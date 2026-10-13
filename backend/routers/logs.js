const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const NotificationLog = require("../models/NotificationLog");

// GET /api/logs?status=FAILED&restaurant=<id>&limit=50
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = {};
    if (["SENT", "DELIVERED", "READ", "FAILED"].includes(req.query.status))
      q.status = req.query.status;
    if (req.query.restaurant) q.restaurant = req.query.restaurant;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json(
      await NotificationLog.find(q)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          "to kind status error_code error_message attempts is_fallback createdAt",
        )
        .lean(),
    );
  }),
);

module.exports = router;