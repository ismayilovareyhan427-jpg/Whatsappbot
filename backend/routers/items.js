const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const Item = require("../models/Item");
const {
  reportItemStatus,
  getItemsByCategory,
} = require("../controllers/itemController");

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { category, name, unit, default_qty } = req.body;
    res
      .status(201)
      .json(await Item.create({ category, name, unit, default_qty }));
  }),
);

router.get(
  "/category/:categoryId",
  asyncHandler(async (req, res) => {
    res.json(await getItemsByCategory(req.params.categoryId));
  }),
);

// Ad / vahid / kateqoriya / adi sifariş miqdarı dəyiş
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const update = {};
    for (const k of ["name", "unit", "category", "default_qty"])
      if (req.body[k] !== undefined) update[k] = req.body[k];
    const item = await Item.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!item) return res.status(404).json({ message: "Məhsul tapılmadı" });
    res.json(item);
  }),
);

// Məhsul silinir, amma tarixçə (AlertHistory) saxlanılır -> analitika dəqiq qalır
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const item = await Item.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: "Məhsul tapılmadı" });
    res.json({ message: "Silindi" });
  }),
);

// Test üçün: statusu əl ilə dəyiş (menecerə xəbərdarlıq da gedir)
router.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const { status, phone } = req.body;
    if (!["LOW_STOCK", "OUT_OF_STOCK"].includes(status))
      return res.status(400).json({ message: "Yanlış status dəyəri" });
    const { item, delivered } = await reportItemStatus(
      req.params.id,
      status,
      phone || "admin",
    );
    res.json({ item, delivered });
  }),
);

module.exports = router;
