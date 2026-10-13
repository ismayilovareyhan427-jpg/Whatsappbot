const Category = require("../models/Category");
const Item = require("../models/Item");

const createCategory = async (req, res) => {
  const { restaurant, name } = req.body;
  res.status(201).json(await Category.create({ restaurant, name }));
};

const getCategoriesByRestaurant = async (req, res) =>
  res.json(await Category.find({ restaurant: req.params.restaurantId }));

const updateCategory = async (req, res) => {
  const cat = await Category.findByIdAndUpdate(
    req.params.id,
    { name: req.body.name },
    { new: true, runValidators: true },
  );
  if (!cat) return res.status(404).json({ message: "Kateqoriya tapılmadı" });
  res.json(cat);
};

const deleteCategory = async (req, res) => {
  const cat = await Category.findByIdAndDelete(req.params.id);
  if (!cat) return res.status(404).json({ message: "Kateqoriya tapılmadı" });
  await Item.deleteMany({ category: cat._id }); // tarixçə (AlertHistory) saxlanılır
  res.json({ message: "Silindi" });
};

module.exports = {
  createCategory,
  getCategoriesByRestaurant,
  updateCategory,
  deleteCategory,
};
