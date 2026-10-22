import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { zohoQuoteSync } from '../functions/zoho-quote-sync/resource';

/**
 * One Enquiry per "Ask for price", commission request or Little Artists gift.
 * Customers can create and read their own enquiries.
 * Price, payment link, status, payment details and the studio message can only be set by ADMINS.
 */
const schema = a.schema({
  Enquiry: a
    .model({
      ref: a.string().required(),
      kind: a.enum(['PRICE', 'COMMISSION', 'GIFT', 'MARKET']),
      title: a.string().required(),
      details: a.json(),
      customerName: a.string(),
      phone: a.string(),
      email: a.string(),
      fileKey: a.string(),
      status: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      quotedPrice: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentLink: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      adminMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentMethod: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      paymentRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Written by the Zoho sync: what Zoho Books holds for this enquiry (PAID = locked).
      zohoState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoQuote: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoInvoice: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoInvoiceId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPaymentId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Purchase side (Siva): PO → bill → payment. Set by the Studio desk / written back by the Zoho sync.
      costingAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistInvoiceNo: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistPaidRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      purchaseState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      purchaseMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPO: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoPOId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoBill: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoBillId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoVendorPaymentId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Delivery: courier + tracking (shown to the customer) and the Zoho delivery challan.
      courierName: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      trackingNo: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoChallan: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoChallanId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // After-sales: cancellation / damage → credit note + refund, or a replacement.
      refundAction: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundAmount: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundMethod: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundNote: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      refundMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoCreditNote: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoCreditNoteId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoRefundId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Siva's progress, reported on the Artist desk: STARTED → FINISHED → SHIPPED (to the frame shop).
      artistStage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistStartedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistFinishedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistShippedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistCourier: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistAwb: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      artistBy: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Customer's own cancellation request / damage report (made under My enquiries, through customerRequest).
      cancelRequest: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelReason: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelPhotos: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelRequestedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelRefundDue: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelState: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      cancelReply: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveredAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Rework for a replacement (damaged in transit): frame shop or Siva, confirmed ready by the studio before it ships again.
      reworkType: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkStage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkStartedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkFinishedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkSentAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkReadyAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkCourier: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkAwb: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkBy: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkNote: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkInvoiceNo: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkPaidRef: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoReworkBill: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoReworkBillId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      zohoReworkPaymentId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkMessage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Return transport for a replacement: customer → frame shop (UAE), frame shop → Siva (India) for a repair, and back.
      returnMode: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      returnCourier: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      returnAwb: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      returnPickupDate: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      returnPickedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      returnReceivedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      toSivaCourier: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      toSivaAwb: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      toSivaSentAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      sivaReceivedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      reworkBackAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Zoho IDs of earlier delivery challans (the damaged delivery), so Check Zoho still lists them.
      prevChallans: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Delivery address: given by the customer under My enquiries & orders (customerAddress), or typed by the studio.
      deliveryName: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryPhone: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryEmirate: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryCountry: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]), // UAE (default) | India
      deliveryPin: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]), // India PIN code
      deliveryAddress: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryLandmark: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      addressAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      addressBy: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Crafts shop (marketplace) orders: kind MARKET, created by the marketOrder mutation at the listing's price.
      listingId: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      sellerName: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      qty: a.integer().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      unitPrice: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      deliveryBy: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      sellerStage: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]), // READY (for Kalai pickup) | DISPATCHED (seller's courier) | DELIVERED
      sellerReadyAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      sellerDispatchedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      sellerId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      sellerAmount: a.float().authorization((allow) => [allow.group('ADMINS')]), // what the seller receives for this order
      commissionPct: a.float().authorization((allow) => [allow.group('ADMINS')]),
      sellerPaidRef: a.string().authorization((allow) => [allow.group('ADMINS')]),
      zohoSellerBill: a.string().authorization((allow) => [allow.group('ADMINS')]),
      zohoSellerBillId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      zohoSellerPaymentId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      // Ziina online payments: payment link (intent) created at Price sent, paid by webhook, refunds back to the card.
      // Customer code (BP-0000001…): one per customer (account, else email, else mobile), assigned by the function.
      customerCode: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Discount code applied by the customer (applyCode): price before the discount and the amount taken off.
      discountCode: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      discountAmount: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      listPrice: a.float().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      // Artist doing a price enquiry / commission: empty = Siva (Artist desk); else an approved portal artist.
      artistId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      artistName: a.string().authorization((allow) => [allow.group('ADMINS')]),
      artistCountry: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaIntentId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaAmount: a.float().authorization((allow) => [allow.group('ADMINS')]),
      ziinaTest: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaPaidAt: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaCard: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaRefundId: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaRefundState: a.string().authorization((allow) => [allow.group('ADMINS')]),
      ziinaMessage: a.string().authorization((allow) => [allow.group('ADMINS')]),
      owner: a.string().authorization((allow) => [allow.owner().to(['read', 'delete']), allow.group('ADMINS').to(['read'])]),
    })
    .authorization((allow) => [allow.owner().to(['create', 'read']), allow.group('ADMINS')]),

  // Cost build-up per enquiry: Siva's price and the costing. Admin only, never visible to customers.
  // Siva writes his price through artistQuote (below), not directly.
  Costing: a
    .model({
      enquiryId: a.id().required(),
      artistPriceInr: a.float(),
      artistPriceAed: a.float(), // portal artists based outside India price in AED
      artistReadyBy: a.string(),
      artistNote: a.string(),
      artistAt: a.string(),
      artistBy: a.string(),
      // Replacement / rework: Siva's rework price (INR) and the studio's extra costs + courier insurance claim (AED).
      reworkPriceInr: a.float(),
      reworkPriceAt: a.string(),
      reworkPriceBy: a.string(),
      rework: a.json(),
      sizeTier: a.string(),
      delivery: a.string(),
      framingOverride: a.float(),
      indiaCourierOverride: a.float(),
      localCourierOverride: a.float(),
      costs: a.json(),
      // Every Zoho document for the order (quote, invoices, payments, PO, bills), refreshed by Check Zoho.
      zohoDocs: a.json(),
      docsAt: a.string(),
    })
    .identifier(['enquiryId'])
    .authorization((allow) => [allow.group('ADMINS')]),

  // Customer feedback: one per delivered order, written by the customer. Private: only the customer and ADMINS.
  Review: a
    .model({
      enquiryId: a.id().required(),
      ref: a.string(),
      title: a.string(),
      firstName: a.string(),
      rating: a.integer().required(),
      comment: a.string(),
      consent: a.boolean(),
      published: a.boolean().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
      publishedAt: a.string().authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),
    })
    .identifier(['enquiryId'])
    .authorization((allow) => [allow.owner().to(['create', 'read']), allow.group('ADMINS')]),

  // Reviews the studio chose to publish (customer consented): shown on the website to everyone.
  PublicReview: a
    .model({
      enquiryId: a.id().required(),
      firstName: a.string(),
      rating: a.integer().required(),
      comment: a.string(),
      title: a.string(),
      date: a.string(),
    })
    .identifier(['enquiryId'])
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Product catalogue (website collection). Edited on the Catalogue tab; the website shows works whose status is
  // PUBLISHED or SOLD and whose publishAt has arrived (so a batch can be scheduled N per day).
  Product: a
    .model({
      title: a.string().required(),
      kind: a.string(), // water | sketch
      subject: a.string(), // land | village | nature | arch | people
      medium: a.string(),
      size: a.string(),
      framing: a.string(),
      description: a.string(),
      priceAed: a.float(),
      status: a.string(), // DRAFT | PUBLISHED | SOLD | HIDDEN
      publishAt: a.string(),
      imageKey: a.string(),
      sortOrder: a.integer(),
      source: a.string(),
      // Set when a real title is given (by the artist on his desk, or the studio in Catalogue). Until then the
      // website shows "Untitled" instead of the imported file name.
      named: a.string(),
      code: a.string(), // artwork code AT-0000001…, assigned by the function, never changes
    })
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Daily message shown as a small notice on the website, in Tamil, English and Arabic.
  Announcement: a
    .model({
      ta: a.string(),
      en: a.string(),
      ar: a.string(),
      active: a.boolean(),
      showFrom: a.string(),
      showUntil: a.string(),
      source: a.string(), // KURAL = the automatic Thirukkural of the day; empty = the studio's own message
      ref: a.string(), // e.g. "Kural 123 · Chapter …"
    })
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // ---------- Marketplace (seller portal) ----------
  // All seller writes go through the sellerAction function (it checks the seller is approved and keeps the prices honest).
  SellerProfile: a
    .model({
      business: a.string(),
      contactName: a.string(),
      phone: a.string(),
      email: a.string(),
      tradeLicence: a.string(),
      emirate: a.string(),
      address: a.string(),
      about: a.string(),
      categories: a.string(),
      bankName: a.string(),
      accountName: a.string(),
      iban: a.string(),
      status: a.string(), // APPLIED | APPROVED | REJECTED | SUSPENDED
      commissionPct: a.float(),
      kalaiDeliveryFee: a.float(),
      adminNote: a.string(),
      appliedAt: a.string(),
      approvedAt: a.string(),
      zohoVendorId: a.string(),
      // Artists ("Become an artist") use the same profile: type ARTIST, their mediums and sample works.
      type: a.string(), // SELLER | ARTIST
      country: a.string(), // UAE | India
      mediums: a.string(),
      experience: a.string(),
      commissions: a.string(), // YES | NO
      portfolio: a.string(),
      sampleKeys: a.string(), // JSON array of S3 keys under market/{identity}/samples/ (artists: sample works; sellers: product photos)
      photoKey: a.string(), // profile photo or shop logo
      accountNumber: a.string(), // India bank account
      ifsc: a.string(),
      owner: a.string(),
    })
    .authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),

  Listing: a
    .model({
      sellerId: a.string(),
      sellerName: a.string(),
      title: a.string(),
      description: a.string(),
      category: a.string(),
      imageKeys: a.string(), // JSON array of S3 keys under market/
      stock: a.integer(),
      costPrice: a.float(),
      markupPct: a.float(),
      courierCharge: a.float(),
      otherCharges: a.float(),
      sellerPrice: a.float(),
      deliveryBy: a.string(), // SELLER | KALAI
      commissionPct: a.float(),
      kalaiDeliveryFee: a.float(),
      customerPrice: a.float(),
      status: a.string(), // DRAFT | SUBMITTED | APPROVED | REJECTED | PAUSED
      adminNote: a.string(),
      submittedAt: a.string(),
      approvedAt: a.string(),
      owner: a.string(),
    })
    .authorization((allow) => [allow.owner().to(['read']), allow.group('ADMINS')]),

  // What the website shows: written only when a listing is approved (public fields only).
  MarketItem: a
    .model({
      listingId: a.id().required(),
      sellerName: a.string(),
      title: a.string(),
      description: a.string(),
      category: a.string(),
      imageKeys: a.string(),
      price: a.float(),
      stock: a.integer(),
      deliveryBy: a.string(),
      publishedAt: a.string(),
      sellerType: a.string(), // ARTIST (shown in the collection) | SELLER (Crafts shop)
      artistKey: a.string(), // links to ArtistProfile.id
    })
    .identifier(['listingId'])
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Promotions: website banner, the Offers page, and an optional discount code.
  Promotion: a
    .model({
      title: a.string(),
      bannerText: a.string(),
      showBanner: a.boolean(),
      details: a.string(), // text on the Offers page
      imageKey: a.string(),
      code: a.string(), // e.g. DIWALI10 (upper case), optional
      discountType: a.string(), // PCT | AED
      discountValue: a.float(),
      minOrder: a.float(),
      appliesTo: a.string(), // ALL | ART (catalogue + commissions) | CRAFTS (Crafts shop) | GIFT (Little Artists)
      startAt: a.string(),
      endAt: a.string(),
      active: a.boolean(),
      maxUses: a.integer(),
      usedCount: a.integer(),
      sortOrder: a.integer(),
      number: a.string(), // master number PR-0000001…, never changes
      copiedFrom: a.string(), // number of the offer it was re-used from
    })
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Website settings master (one row, id "site"): timings shown on the home page.
  SiteSetting: a
    .model({
      heroSeconds: a.integer(), // home page picture changes every N seconds (default 10)
      kuralSeconds: a.integer(), // Thirukkural card switches language every N seconds (default 10)
      // Home page texts (empty = the built-in text)
      heroTitle: a.string(),
      heroHighlight: a.string(),
      heroText: a.string(),
      siteLook: a.string(), // classic | magazine
      heroLines: a.string(), // several headlines, one per line, "plain part | gold part"; they take turns
      kidsTitle: a.string(),
      kidsText: a.string(), // paragraphs separated by a blank line
    })
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Public profile of an approved artist (written by the function on approval; no contact or bank details).
  ArtistProfile: a
    .model({
      name: a.string(),
      photoKey: a.string(),
      about: a.string(),
      mediums: a.string(),
      region: a.string(),
      country: a.string(),
      commissions: a.string(),
      publishedAt: a.string(),
    })
    .authorization((allow) => [allow.group('ADMINS'), allow.publicApiKey().to(['read'])]),

  // Master rates (framing and India courier per size tier, local courier, customs, fee, margin, VAT, FX).
  Rates: a
    .model({
      key: a.id().required(),
      data: a.json(),
    })
    .identifier(['key'])
    .authorization((allow) => [allow.group('ADMINS')]),

  // Artist desk: Siva's list (no customer details, no selling price), his price, and commission photos.
  artistList: a
    .query()
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistQuote: a
    .mutation()
    .arguments({ id: a.id().required(), priceInr: a.float().required(), readyBy: a.string(), note: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistProgress: a
    .mutation()
    .arguments({ id: a.id().required(), step: a.string().required(), courier: a.string(), awb: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistRework: a
    .mutation()
    .arguments({ id: a.id().required(), step: a.string().required(), priceInr: a.float(), courier: a.string(), awb: a.string(), note: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  artistPhoto: a
    .query()
    .arguments({ id: a.id().required() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Customer (or the studio for them): apply / remove a discount code on an order before paying.
  applyCode: a
    .mutation()
    .arguments({ id: a.id().required(), code: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoQuoteSync)),

  // Studio: give customer codes and artwork codes to everything that has none yet.
  assignCodes: a
    .mutation()
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Studio: publish today's Thirukkural now (it is also published every morning automatically).
  dailyKural: a
    .mutation()
    .arguments({ action: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Artist desk: list catalogue works and give them a title, size and description.
  artistWorks: a
    .mutation()
    .arguments({ action: a.string().required(), data: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ARTISTS'), allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Seller portal: apply, my profile + listings, save / submit / pause / delete a listing.
  sellerAction: a
    .mutation()
    .arguments({ action: a.string().required(), data: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoQuoteSync)),
  // Website: order a Crafts shop item (signed-in customer); the price is taken from the listing, not the browser.
  marketOrder: a
    .mutation()
    .arguments({ data: a.string().required() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoQuoteSync)),
  // Studio: Ziina status and webhook registration.
  ziinaAdmin: a
    .mutation()
    .arguments({ action: a.string().required(), data: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
  // Studio: approve / reject sellers and listings.
  marketAdmin: a
    .mutation()
    .arguments({ action: a.string().required(), data: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Daily message: translate the Tamil text to English and Arabic (Amazon Translate).
  translateMessage: a
    .mutation()
    .arguments({ text: a.string().required(), source: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Catalogue: import works from links (ArtStation album / artwork pages, or image addresses) into drafts.
  catalogueImport: a
    .mutation()
    .arguments({ mode: a.string().required(), links: a.string().required() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),

  // Visitor NOT signed in: price enquiry saved for the studio (no account, so the visitor can't track it).
  guestEnquiry: a
    .mutation()
    .arguments({ ref: a.string().required(), title: a.string().required(), details: a.string(), customerName: a.string().required(), phone: a.string().required(), email: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.publicApiKey()])
    .handler(a.handler.function(zohoQuoteSync)),

  // Customer, from My enquiries & orders: add or change the delivery address (until it ships).
  customerAddress: a
    .mutation()
    .arguments({ id: a.id().required(), name: a.string().required(), phone: a.string().required(), emirate: a.string().required(), address: a.string().required(), landmark: a.string(), country: a.string(), pin: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoQuoteSync)),

  // Customer, from My enquiries: cancel an order or report damage on delivery. Checked against the policy in the function.
  customerRequest: a
    .mutation()
    .arguments({ id: a.id().required(), action: a.string().required(), reason: a.string(), photos: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(zohoQuoteSync)),

  // Studio desk "Check Zoho": re-reads the invoice in Zoho; unlocks the enquiry if it was voided or its payment removed.
  checkZoho: a
    .mutation()
    .arguments({ id: a.id().required() })
    .returns(a.string())
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(zohoQuoteSync)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    // Public, read-only key used only to show published reviews on the website (renew yearly by redeploying).
    apiKeyAuthorizationMode: { expiresInDays: 365 },
  },
});
