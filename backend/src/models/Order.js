const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    conversationPublicId: { type: String, required: true, index: true },
    siteOrigin: { type: String, default: null },
    siteId: { type: String, default: 'default' },

    pageUrl: { type: String, default: null }, // product page the visitor was on

    // What the customer wants
    boxType: { type: String, default: null }, // satin lined rigid box | cigarette box | donut box | ...
    style: { type: String, default: null }, // magnetic flip-top | lid and base | tuck end | display ...
    dimensions: { type: String, default: null }, // free text, e.g. "10 x 8 x 4 in"
    quantity: { type: String, default: null }, // free text, e.g. "100", "50-100"
    productInside: { type: String, default: null }, // e.g. "15 incense sticks, 11 x 0.125 in"
    material: { type: String, default: null }, // kraft | cardstock | corrugated | rigid
    printing: { type: String, default: null }, // full color outside, 4/4, logo placement
    baseColor: { type: String, default: null },
    finish: { type: String, default: null }, // matte / gloss / foil / spot UV / none
    inserts: { type: String, default: null }, // dividers, satin lining, none
    artworkStatus: { type: String, default: null }, // ready | in progress | needs dieline | none
    sampleRequested: { type: Boolean, default: false },
    notes: { type: String, default: null },

    // Who they are
    customerName: { type: String, default: null },
    company: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, default: null },
    city: { type: String, default: null },

    status: {
      type: String,
      enum: ['new', 'contacted', 'quoted', 'won', 'lost'],
      default: 'new',
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
