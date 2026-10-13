const mongoose = require("mongoose");
const { normalizePhone } = require("../utils/text");

const phone = { type: String, set: normalizePhone };

const restaurantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    manager_phone: { ...phone, required: true, index: true },
    supplier_phone: { ...phone, index: true },
    kitchen_phones: { type: [phone], default: [], index: true },
    alert_phones: { type: [phone], default: [], index: true },
    owner_phone: { ...phone, index: true },
    chain: { type: String, trim: true, index: true },
    auto_send_to_supplier: { type: Boolean, default: false },

    // Menecer WhatsApp qrupu (Groups API). Boşdursa yalnız fərdi nömrələrə gedir.
    manager_group_id: { type: String, trim: true, index: true },
    manager_group_invite: { type: String, trim: true },
    manager_group_request: { type: String, trim: true, index: true }, // webhook-dan ID gözlənilir

    // Abunəlik
    is_active: { type: Boolean, default: true },
    trial_ends_at: { type: Date },
    paid_until: { type: Date },
    monthly_fee: { type: Number, default: 100 },
    billing_reminded_for: { type: Date },
    billing_expired_for: { type: Date },

    // Birdəfəlik quraşdırma haqqı (təklif: 150 AZN)
    setup_fee: { type: Number, default: 150, min: 0 },
    setup_paid: { type: Boolean, default: false },
    setup_paid_at: { type: Date },
  },
  { timestamps: true },
);

restaurantSchema.pre("save", function () {
  if (this.isNew && !this.trial_ends_at && !this.paid_until) {
    const days = parseInt(process.env.TRIAL_DAYS || "3", 10);
    this.trial_ends_at = new Date(Date.now() + days * 86400000);
  }
});

restaurantSchema.methods.subscriptionEnd = function () {
  const ts = [this.paid_until, this.trial_ends_at]
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  return ts.length ? new Date(Math.max(...ts)) : null;
};

restaurantSchema.methods.hasAccess = function () {
  if (!this.is_active) return false;
  const end = this.subscriptionEnd();
  return end ? end.getTime() > Date.now() : true;
};

restaurantSchema.methods.planStatus = function () {
  if (!this.is_active) return "SUSPENDED";
  const now = Date.now();
  if (this.paid_until && new Date(this.paid_until).getTime() > now)
    return "ACTIVE";
  if (this.trial_ends_at && new Date(this.trial_ends_at).getTime() > now)
    return "TRIAL";
  return this.paid_until || this.trial_ends_at ? "EXPIRED" : "ACTIVE";
};

module.exports = mongoose.model("Restaurant", restaurantSchema);