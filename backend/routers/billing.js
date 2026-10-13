const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/billingController");

router.get("/", asyncHandler(c.overview));
router.get("/revenue", asyncHandler(c.revenue));
router.post("/restaurants/:id/payments", asyncHandler(c.addPayment));
router.get("/restaurants/:id/payments", asyncHandler(c.listPayments));

module.exports = router;
