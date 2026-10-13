const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/categoryController");

router.post("/", asyncHandler(c.createCategory));
router.get(
  "/restaurant/:restaurantId",
  asyncHandler(c.getCategoriesByRestaurant),
);
router.put("/:id", asyncHandler(c.updateCategory));
router.delete("/:id", asyncHandler(c.deleteCategory));

module.exports = router;
