const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/stockController");

router.get("/restaurants/:id/balance", asyncHandler(c.balanceHandler));
router.get("/restaurants/:id/report", asyncHandler(c.reportHandler));
router.get("/restaurants/:id/movements", asyncHandler(c.listMovements));
router.post("/restaurants/:id/movements", asyncHandler(c.addMovement));

module.exports = router;