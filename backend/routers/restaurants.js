const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const c = require("../controllers/restaurantController");
const { importMenu } = require("../controllers/importController");

router
  .route("/")
  .get(asyncHandler(c.getRestaurants))
  .post(asyncHandler(c.createRestaurant));
router
  .route("/:id")
  .get(asyncHandler(c.getRestaurant))
  .put(asyncHandler(c.updateRestaurant))
  .patch(asyncHandler(c.updateRestaurant))
  .delete(asyncHandler(c.deleteRestaurant));
router.post("/:id/import", asyncHandler(importMenu));
router.patch("/:id/subscription", asyncHandler(c.setSubscription));
router.patch("/:id/kitchen-phones", asyncHandler(c.addKitchenPhone));
router.delete("/:id/kitchen-phones/:phone", asyncHandler(c.removeKitchenPhone));
router.patch("/:id/alert-phones", asyncHandler(c.addAlertPhone));
router.delete("/:id/alert-phones/:phone", asyncHandler(c.removeAlertPhone));

// Menecer WhatsApp qrupu
router.post("/:id/group", asyncHandler(c.createGroup));
router.put("/:id/group", asyncHandler(c.setGroup));
router.delete("/:id/group", asyncHandler(c.removeGroup));

module.exports = router;