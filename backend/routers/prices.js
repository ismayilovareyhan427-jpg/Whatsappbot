const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/priceController");

router.post("/restaurants/:id", asyncHandler(c.addPrice));
router.post("/restaurants/:id/bulk", asyncHandler(c.bulkPrices));
router.get("/restaurants/:id/compare", asyncHandler(c.compareHandler));
router.get("/item/:itemId/history", asyncHandler(c.historyHandler));
router.delete("/:id", asyncHandler(c.deletePrice));

module.exports = router;