const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/analyticsController");
const u = require("../controllers/usageController");

router.get("/summary", asyncHandler(c.summaryAnalytics));
router.get("/chain/:chain", asyncHandler(c.chainAnalytics));
router.get("/restaurant/:id", asyncHandler(c.restaurantAnalytics));
router.get("/usage/:restaurantId", asyncHandler(u.usageAnalytics));

module.exports = router;
